import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import {
  onAgentReply,
  onCustomerMessage,
  sweepResponseTargets,
} from '../services/responseTargets.js';

/**
 * Response-time targets end to end: the clock, the breach, the escalation.
 *
 * What is pinned here is mostly about NOT crying wolf. A team that stops believing the
 * alerts is worse off than a team that never had them, so the cases are: a deadline
 * that respects opening hours, a follow-up that cannot reset a deadline it is chasing,
 * a resolved conversation that stops being chased, and an escalation that fires once.
 */

let app: FastifyInstance;
let token: string;
let workspaceId: string;
let websiteId: string;
let ownerMemberId: string;
let helperMemberId: string;

const PASSWORD = 'correct horse battery';

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1/w/${workspaceId}${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as object } : {}),
  });
}

/** A conversation with the clock already started, `minutesAgo` in the past. */
async function conversationWaitingFor(minutesAgo: number): Promise<string> {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const conv = await unscopedPrisma.conversations.create({
    data: {
      workspace_id: workspaceId,
      website_id: websiteId,
      visitor_id: `v-${Math.random().toString(36).slice(2)}`,
      visitor_name: 'Waiting Wanda',
      channel: 'widget',
      created_at: at,
    },
    select: { id: true },
  });
  await onCustomerMessage({ workspaceId, websiteId, conversationId: conv.id, at });
  return conv.id;
}

async function setTargets(patch: Record<string, unknown>) {
  const res = await api('PUT', `/websites/${websiteId}/response-targets`, {
    enabled: true,
    first_response_minutes: 30,
    next_response_minutes: 60,
    business_hours_only: false,
    escalate_enabled: false,
    escalate_to_member_id: null,
    notify_owners: false,
    ...patch,
  });
  assert.equal(res.statusCode, 200, res.body);
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Owner', email: 'owner@example.com', password: PASSWORD, workspace_name: 'Acme' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  token = signup.json().access_token;
  await unscopedPrisma.users.update({
    where: { email: 'owner@example.com' },
    data: { email_verified_at: new Date() },
  });

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  workspaceId = me.json().workspaces[0].id;
  ownerMemberId = me.json().workspaces[0].member_id;

  const site = await api('POST', '/websites', { name: 'Acme Site' });
  assert.equal(site.statusCode, 201, site.body);
  websiteId = site.json().website.id;

  // A second member to escalate to.
  const helperUser = await unscopedPrisma.users.create({
    data: { email: 'helper@example.com', name: 'Helper', password_hash: 'x' },
    select: { id: true },
  });
  const helper = await unscopedPrisma.workspace_members.create({
    data: { workspace_id: workspaceId, user_id: helperUser.id, role: 'agent' },
    select: { id: true },
  });
  helperMemberId = helper.id;
});

beforeEach(async () => {
  await unscopedPrisma.conversations.deleteMany({ where: { workspace_id: workspaceId } });
});

after(async () => {
  await app.close();
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  await unscopedPrisma.$disconnect();
});

// ── The clock ───────────────────────────────────────────────────────────────

test('no targets configured means no deadline, not a deadline of zero', async () => {
  await setTargets({ enabled: false });
  const id = await conversationWaitingFor(0);
  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true, awaiting_reply_since: true },
  });
  assert.equal(conv.response_due_at, null);
  // But the wait IS recorded, because the report measures response time whether or not
  // a promise was made about it.
  assert.ok(conv.awaiting_reply_since);
});

test('a customer message sets a deadline the target’s distance away', async () => {
  await setTargets({ first_response_minutes: 30 });
  const before = Date.now();
  const id = await conversationWaitingFor(0);
  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true },
  });
  const due = conv.response_due_at!.getTime();
  assert.ok(due >= before + 29 * 60_000 && due <= Date.now() + 31 * 60_000, `due at ${conv.response_due_at}`);
});

test('the clock only runs in open hours', async () => {
  // Closed all week. With business_hours_only the deadline cannot be found inside the
  // lookahead, so there is NO deadline rather than an invented one.
  await unscopedPrisma.website_business_hours.upsert({
    where: { website_id: websiteId },
    create: { website_id: websiteId, workspace_id: workspaceId, enabled: true, timezone: 'UTC', rules: [], holidays: [] },
    update: { enabled: true, rules: [] },
  });
  await setTargets({ business_hours_only: true, first_response_minutes: 30 });

  const id = await conversationWaitingFor(0);
  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true, awaiting_reply_since: true },
  });
  assert.equal(conv.response_due_at, null, 'a schedule that never opens produces no deadline');
  assert.ok(conv.awaiting_reply_since);

  // Open 24/7 and the same target lands 30 minutes out.
  await unscopedPrisma.website_business_hours.update({
    where: { website_id: websiteId },
    data: { rules: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, intervals: [['00:00', '24:00']] })) },
  });
  const open = await conversationWaitingFor(0);
  const openConv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id: open },
    select: { response_due_at: true },
  });
  assert.ok(openConv.response_due_at, 'an open schedule produces one');

  await unscopedPrisma.website_business_hours.update({
    where: { website_id: websiteId },
    data: { enabled: false },
  });
});

test('an agent reply stops the clock', async () => {
  await setTargets({});
  const id = await conversationWaitingFor(5);
  await onAgentReply({ workspaceId, conversationId: id });
  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true, awaiting_reply_since: true, unread_at: true },
  });
  assert.equal(conv.response_due_at, null);
  assert.equal(conv.awaiting_reply_since, null);
  assert.equal(conv.unread_at, null, 'answering also clears the unread flag');
});

test('a follow-up cannot reset a deadline that has already been missed', async () => {
  // Otherwise a customer sending three impatient follow-ups keeps pushing the deadline
  // they are complaining about into the future, and the breach never surfaces.
  await setTargets({ first_response_minutes: 5 });
  const id = await conversationWaitingFor(60);
  assert.equal(await sweepResponseTargets(), 1);

  const breached = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_breached_at: true, response_due_at: true },
  });
  assert.ok(breached.response_breached_at);

  await onCustomerMessage({ workspaceId, websiteId, conversationId: id });
  const after = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_breached_at: true },
  });
  assert.deepEqual(after.response_breached_at, breached.response_breached_at);
});

// ── The sweep ───────────────────────────────────────────────────────────────

test('a missed deadline is stamped, marked unread and escalated exactly once', async () => {
  await setTargets({
    first_response_minutes: 5,
    escalate_enabled: true,
    escalate_to_member_id: helperMemberId,
  });
  const id = await conversationWaitingFor(60);

  assert.equal(await sweepResponseTargets(), 1);
  const first = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: {
      response_breached_at: true,
      escalated_at: true,
      unread_at: true,
      assigned_member_id: true,
    },
  });
  assert.ok(first.response_breached_at, 'breach stamped');
  assert.ok(first.unread_at, 'marked unread so it cannot slide down a list sorted by recency');
  assert.equal(first.assigned_member_id, helperMemberId, 'reassigned, not merely announced');

  // Once. A sweep every minute must not re-announce the same failure sixty times an hour.
  assert.equal(await sweepResponseTargets(), 0);
  const second = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { escalated_at: true, response_breached_at: true },
  });
  assert.deepEqual(second.escalated_at, first.escalated_at);
  assert.deepEqual(second.response_breached_at, first.response_breached_at);
});

test('the breach is stamped at the DEADLINE, not at the moment the sweep noticed', async () => {
  // A server that was down for an hour must not report every breach as having happened
  // at boot, which would make the report's timeline fiction.
  await setTargets({ first_response_minutes: 5 });
  const id = await conversationWaitingFor(120);
  const before = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true },
  });
  await sweepResponseTargets();
  const after = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_breached_at: true },
  });
  assert.deepEqual(after.response_breached_at, before.response_due_at);
});

test('a resolved conversation is not chased', async () => {
  await setTargets({ first_response_minutes: 5 });
  const id = await conversationWaitingFor(60);
  const res = await api('POST', `/conversations/${id}/status`, { status: 'resolved' });
  assert.equal(res.statusCode, 200, res.body);

  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id },
    select: { response_due_at: true },
  });
  assert.equal(conv.response_due_at, null, 'resolving stops the clock');
  assert.equal(await sweepResponseTargets(), 0);
});

test('an answered conversation is not chased', async () => {
  await setTargets({ first_response_minutes: 5 });
  const id = await conversationWaitingFor(60);
  const res = await api('POST', `/conversations/${id}/messages`, { content: 'Sorry for the wait!' });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await sweepResponseTargets(), 0);
});

// ── The queue ───────────────────────────────────────────────────────────────

test('the at-risk view looks FORWARD, and sorts by deadline rather than recency', async () => {
  await setTargets({ first_response_minutes: 30 });
  // Due in 5 minutes (at risk), due in 25 (not yet), and long overdue.
  const soon = await conversationWaitingFor(25);
  const later = await conversationWaitingFor(5);
  const overdue = await conversationWaitingFor(90);

  const res = await api('GET', '/conversations?due=at_risk&status=all');
  assert.equal(res.statusCode, 200, res.body);
  const ids = res.json().conversations.map((c: { id: string }) => c.id);

  // A list of things already late is a list of failures. The window looks forward so
  // there is still time to act.
  assert.ok(ids.includes(soon), 'due within 15 minutes is at risk');
  assert.ok(ids.includes(overdue), 'already overdue is at risk');
  assert.ok(!ids.includes(later), 'due in 25 minutes is not yet at risk');
  // Soonest deadline first — the whole point, since ordering by recency is what buries
  // the conversation nobody answered.
  assert.deepEqual(ids, [overdue, soon]);
});

test('the attention counts are visible without opening the view', async () => {
  await setTargets({ first_response_minutes: 5 });
  await conversationWaitingFor(60);
  await conversationWaitingFor(1);
  await sweepResponseTargets();

  const res = await api('GET', '/conversations/attention');
  assert.equal(res.statusCode, 200, res.body);
  const counts = res.json();
  assert.equal(counts.breached, 1);
  assert.equal(counts.unread, 1);
  assert.equal(counts.waiting, 2);
  assert.ok(counts.at_risk >= 1);
});

test('mark unread, and read again', async () => {
  await setTargets({ enabled: false });
  const id = await conversationWaitingFor(0);

  assert.equal((await api('POST', `/conversations/${id}/unread`, { unread: true })).statusCode, 200);
  let list = await api('GET', '/conversations?due=unread&status=all');
  assert.deepEqual(list.json().conversations.map((c: { id: string }) => c.id), [id]);

  assert.equal((await api('POST', `/conversations/${id}/unread`, { unread: false })).statusCode, 200);
  list = await api('GET', '/conversations?due=unread&status=all');
  assert.deepEqual(list.json().conversations, []);
});

// ── The report ──────────────────────────────────────────────────────────────

test('the report reports percentiles, counts what was never answered, and names its unit', async () => {
  await setTargets({ enabled: false });
  // Three answered at 10, 20 and 60 minutes, and one never answered.
  const now = Date.now();
  for (const minutes of [10, 20, 60]) {
    await unscopedPrisma.conversations.create({
      data: {
        workspace_id: workspaceId,
        website_id: websiteId,
        visitor_id: `v-${minutes}-${Math.random()}`,
        created_at: new Date(now - 3 * 60 * 60_000),
        first_response_at: new Date(now - 3 * 60 * 60_000 + minutes * 60_000),
        status: 'resolved',
      },
    });
  }
  await unscopedPrisma.conversations.create({
    data: {
      workspace_id: workspaceId,
      website_id: websiteId,
      visitor_id: `v-never-${Math.random()}`,
      created_at: new Date(now - 60 * 60_000),
      status: 'open',
    },
  });

  const res = await api('GET', '/reports/response-times?days=7');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.answered, 3);
  // The number a manager actually wants, and the one an average would hide.
  assert.equal(body.unanswered, 1);
  assert.equal(body.first_response_minutes.p50, 20);
  assert.equal(body.first_response_minutes.p90, 60);
  assert.equal(body.first_response_minutes.fastest, 10);
  // Stated, because a reader assuming wall-clock would misread every number above.
  assert.equal(body.unit, 'business_minutes');
});

test('another workspace’s conversations are not chased, counted or reported', async () => {
  const other = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Bob', email: 'bob@example.com', password: PASSWORD, workspace_name: 'Globex' },
  });
  const otherToken = other.json().access_token as string;
  const otherMe = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${otherToken}` },
  });
  const otherWs = otherMe.json().workspaces[0].id as string;

  await setTargets({ first_response_minutes: 5 });
  await conversationWaitingFor(60);
  await sweepResponseTargets();

  const counts = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${otherWs}/conversations/attention`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(counts.statusCode, 200, counts.body);
  assert.deepEqual(counts.json(), { at_risk: 0, breached: 0, unread: 0, waiting: 0 });

  const report = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${otherWs}/reports/response-times`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(report.json().total, 0);

  // And Ada's escalation target cannot be set to a stranger.
  const cross = await app.inject({
    method: 'PUT',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/response-targets`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      enabled: true,
      first_response_minutes: 30,
      next_response_minutes: null,
      business_hours_only: false,
      escalate_enabled: true,
      escalate_to_member_id: otherMe.json().workspaces[0].member_id,
      notify_owners: false,
    },
  });
  assert.equal(cross.statusCode, 400, cross.body);
  assert.match(cross.json().error, /not in this workspace/);
  void ownerMemberId;
});
