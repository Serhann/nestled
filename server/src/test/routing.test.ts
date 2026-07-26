import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { registerAgentSocket } from '../realtime/hub.js';
import { pickAssignee } from '../services/routing.js';

/**
 * Routing rules against a real pool.
 *
 * The behaviours worth pinning are the ones that decide whether a customer trusts
 * the feature: the rotation is fair, it survives a restart, and it never hands a
 * chat to somebody who is not there.
 */

let app: FastifyInstance;
let token: string;
let workspaceId: string;
let websiteId: string;
let publicKey: string;
/** Ada (the owner) plus two agents, in creation order — the rotation's order. */
let members: string[] = [];

const PASSWORD = 'correct horse battery';

/**
 * A stand-in for a connected agent socket.
 *
 * Online-ness lives in the hub's in-process registry, not in a column, precisely
 * because a column would say "online" for an hour after a laptop lid closed. The
 * test therefore has to connect rather than to UPDATE.
 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  private handlers = new Map<string, (arg?: unknown) => void>();
  on(event: string, fn: (arg?: unknown) => void): this {
    this.handlers.set(event, fn);
    return this;
  }
  send(): void {}
  disconnect(): void {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }
}

const sockets = new Map<string, FakeSocket>();

function goOnline(memberId: string, userId: string): void {
  const ws = new FakeSocket();
  sockets.set(memberId, ws);
  registerAgentSocket(ws as unknown as WebSocket, {
    memberId,
    userId,
    workspaceId,
    websiteIds: null,
  });
}

function goOffline(memberId: string): void {
  sockets.get(memberId)?.disconnect();
  sockets.delete(memberId);
}

async function addAgent(email: string): Promise<string> {
  const user = await unscopedPrisma.users.create({
    data: { email, name: email, password_hash: 'x', email_verified_at: new Date() },
  });
  const member = await unscopedPrisma.workspace_members.create({
    data: { workspace_id: workspaceId, user_id: user.id, role: 'agent' },
  });
  return member.id;
}

async function makeRule(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/routing`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().item.id as string;
}

async function clearRules(): Promise<void> {
  await unscopedPrisma.routing_rules.deleteMany({ where: { workspace_id: workspaceId } });
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspace_name: 'Acme' },
  });
  token = signup.json().access_token;
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  workspaceId = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Acme Storefront' },
  });
  websiteId = site.json().website.id;
  publicKey = site.json().website.public_key;

  const owner = await unscopedPrisma.workspace_members.findFirstOrThrow({
    where: { workspace_id: workspaceId },
  });
  members = [owner.id, await addAgent('bob@example.com'), await addAgent('cara@example.com')];
});

after(async () => {
  for (const id of [...sockets.keys()]) goOffline(id);
  await app.close();
  await unscopedPrisma.$disconnect();
});

const ctx = () => ({
  workspaceId,
  websiteId,
  conversationId: '00000000-0000-0000-0000-000000000000',
});

test('with nobody online, routing declines rather than assigning to an empty chair', async () => {
  await makeRule({ name: 'Everyone', strategy: 'round_robin', member_pool: members });
  // Nobody is connected yet. A chat assigned to someone who will not read it until
  // Monday is worse than one sitting in a queue the whole team can see.
  assert.equal(await pickAssignee(ctx()), null);
  await clearRules();
});

test('round robin distributes across the pool and skips offline members', async () => {
  const [ada, bob, cara] = members as [string, string, string];
  await makeRule({ name: 'Everyone', strategy: 'round_robin', member_pool: members });

  goOnline(ada, 'x');
  goOnline(bob, 'y');
  goOnline(cara, 'z');

  const first: string[] = [];
  for (let i = 0; i < 6; i += 1) first.push((await pickAssignee(ctx()))!.memberId);
  // Two full rotations, in a stable order — fairness is only meaningful against one.
  assert.deepEqual(first.slice(0, 3).sort(), [ada, bob, cara].sort());
  assert.deepEqual(first.slice(0, 3), first.slice(3, 6), 'the rotation should repeat');

  // Bob closes his laptop. The rotation must step over him, not stall on him.
  goOffline(bob);
  const afterOffline: string[] = [];
  for (let i = 0; i < 4; i += 1) afterOffline.push((await pickAssignee(ctx()))!.memberId);
  assert.ok(!afterOffline.includes(bob), 'an offline member must never be picked');
  assert.deepEqual(new Set(afterOffline), new Set([ada, cara]));

  // The cursor is a column, so a restart resumes the rotation instead of handing
  // the next two chats to whoever happens to sort first.
  const rule = await unscopedPrisma.routing_rules.findFirstOrThrow({
    where: { workspace_id: workspaceId },
  });
  assert.equal(rule.cursor_member_id, afterOffline[3]);

  goOffline(ada);
  goOffline(cara);
  await clearRules();
});

test('least_active picks the quietest agent, and the concurrency cap skips a full one', async () => {
  const [ada, bob] = members as [string, string, string];
  goOnline(ada, 'x');
  goOnline(bob, 'y');

  // Ada is already carrying two open chats; Bob has none.
  for (let i = 0; i < 2; i += 1) {
    await unscopedPrisma.conversations.create({
      data: {
        workspace_id: workspaceId,
        website_id: websiteId,
        visitor_id: `busy-${i}`,
        visitor_token_hash: `hash-busy-${i}`,
        assigned_member_id: ada,
        status: 'open',
      },
    });
  }

  await makeRule({ name: 'Quietest', strategy: 'least_active', member_pool: [ada, bob] });
  assert.equal((await pickAssignee(ctx()))!.memberId, bob);
  await clearRules();

  // Now cap everyone at one open chat. Ada is over it, so only Bob is eligible —
  // a rule must not pile a queue onto someone already drowning.
  await makeRule({
    name: 'Capped',
    strategy: 'round_robin',
    member_pool: [ada, bob],
    conditions: { max_concurrent: 1 },
  });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await pickAssignee(ctx()))!.memberId, bob);
  }

  await clearRules();
  await unscopedPrisma.conversations.deleteMany({ where: { workspace_id: workspaceId } });
  goOffline(ada);
  goOffline(bob);
});

test('conditions decide which rule fires, in priority order', async () => {
  const [ada, bob] = members as [string, string, string];
  goOnline(ada, 'x');
  goOnline(bob, 'y');

  await makeRule({ name: 'Everything', priority: 0, strategy: 'specific', member_pool: [ada] });
  await makeRule({
    name: 'Pricing to Bob',
    priority: 10,
    strategy: 'specific',
    member_pool: [bob],
    conditions: { pages: ['*/pricing*'] },
  });

  const onPricing = await pickAssignee({ ...ctx(), page: 'https://acme.com/pricing' });
  assert.equal(onPricing!.memberId, bob, 'the higher-priority matching rule wins');

  const elsewhere = await pickAssignee({ ...ctx(), page: 'https://acme.com/blog' });
  assert.equal(elsewhere!.memberId, ada, 'a rule whose conditions miss is skipped');

  await clearRules();
  goOffline(ada);
  goOffline(bob);
});

test('a new widget conversation is routed and the assignment is announced', async () => {
  const [ada] = members as [string, string, string];
  goOnline(ada, 'x');
  await makeRule({ name: 'Everything', strategy: 'specific', member_pool: [ada] });

  const session = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: session.session_token },
  });
  assert.equal(created.statusCode, 201, created.body);

  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id: created.json().conversation_id },
  });
  assert.equal(conv.assigned_member_id, ada);

  // A rule firing late must never take a chat away from whoever already claimed it.
  await unscopedPrisma.conversations.update({
    where: { id: conv.id },
    data: { assigned_member_id: members[1]! },
  });
  const again = await pickAssignee({ ...ctx(), conversationId: conv.id });
  assert.ok(again, 'the rule still matches');
  const unchanged = await unscopedPrisma.conversations.findUniqueOrThrow({ where: { id: conv.id } });
  assert.equal(unchanged.assigned_member_id, members[1]);

  await clearRules();
  goOffline(ada);
});
