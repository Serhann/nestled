import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { tenantDb } from '../db/tenant.js';
import { RESTORE_WINDOW_DAYS, purgeExpiredDeletions } from '../lib/deletions.js';

/**
 * Deletion from the ops panel: what it takes with it, what comes back, and what
 * eventually does not.
 *
 * The tests that matter most are the two nobody would write first:
 *
 *   - "a restore does not resurrect what was already deleted" — the reason
 *     `deletion_events.targets` exists at all. Without it, restore can only mean
 *     "clear every deleted_at underneath", which silently reverses decisions the
 *     customer made themselves weeks earlier.
 *   - "a deleted conversation is invisible to the tenant client" — the reason the
 *     filter lives in db/tenant.ts rather than in 79 query sites. If this passes only
 *     because a particular route remembered a predicate, the feature is one new route
 *     away from serving deleted data.
 */

let app: FastifyInstance;
let staffToken: string;
let ownerToken: string;
let workspaceId: string;
let websiteId: string;
let secondWebsiteId: string;
let ownerUserId: string;

const STAFF_SECRET = generateTotpSecret();
const STAFF_PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });
const ownerAuth = () => ({ authorization: `Bearer ${ownerToken}` });

/** The tenant client a route handler would be given for this workspace. */
const asCustomer = () => tenantDb({ workspaceId, websiteIds: null });

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });

  app = await buildServer();
  await app.ready();

  await unscopedPrisma.platform_users.create({
    data: {
      email: 'ops@nestled.chat',
      name: 'Ops',
      role: 'superadmin',
      password_hash: await hashPassword(STAFF_PASSWORD),
      totp_secret: STAFF_SECRET,
      totp_enabled: true,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'ops@nestled.chat', password: STAFF_PASSWORD, totp: currentCode(STAFF_SECRET) },
  });
  assert.equal(login.statusCode, 200, login.body);
  staffToken = login.json().token;

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: CUSTOMER_PASSWORD, workspace_name: 'Acme' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  ownerToken = signup.json().access_token;

  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: ownerAuth() });
  workspaceId = me.json().workspaces[0].id;
  ownerUserId = (await unscopedPrisma.users.findUniqueOrThrow({ where: { email: 'ada@example.com' } })).id;

  websiteId = await createWebsite('Main site');
  secondWebsiteId = await createWebsite('Second site');
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

async function createWebsite(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: ownerAuth(),
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().website.id as string;
}

/** A conversation, created straight through the unscoped client — no widget needed. */
async function createConversation(siteId: string, visitor: string): Promise<string> {
  const row = await unscopedPrisma.conversations.create({
    data: {
      workspace_id: workspaceId,
      website_id: siteId,
      visitor_id: `v-${visitor}`,
      visitor_name: visitor,
      status: 'open',
    },
    select: { id: true },
  });
  return row.id;
}

const deleteThing = (type: string, id: string, reason = 'customer asked us to — ticket 1') =>
  app.inject({ method: 'POST', url: '/platform/deletions', headers: staffAuth(), payload: { type, id, reason } });

test('a reason is mandatory', async () => {
  const conversationId = await createConversation(websiteId, 'no-reason');
  for (const payload of [{}, { reason: 'x' }, { reason: '' }]) {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/deletions',
      headers: staffAuth(),
      payload: { type: 'conversation', id: conversationId, ...payload },
    });
    assert.equal(res.statusCode, 400, res.body);
  }
});

test('a deleted conversation is invisible to the tenant client, and to the customer API', async () => {
  const conversationId = await createConversation(websiteId, 'Kaya');

  const before = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/conversations`,
    headers: ownerAuth(),
  });
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(
    (before.json().conversations as { id: string }[]).some((c) => c.id === conversationId),
    'the conversation should be in the inbox before it is deleted',
  );

  const res = await deleteThing('conversation', conversationId);
  assert.equal(res.statusCode, 201, res.body);

  // Through the same client every route handler gets — not through a route that might
  // happen to filter correctly on its own.
  assert.equal(await asCustomer().conversations.count({ where: { id: conversationId } }), 0);
  assert.equal(await asCustomer().conversations.findUnique({ where: { id: conversationId } }), null);

  const after = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/conversations`,
    headers: ownerAuth(),
  });
  assert.ok(!(after.json().conversations as { id: string }[]).some((c) => c.id === conversationId));

  // Still there for support, which is the whole point of soft deletion.
  const row = await unscopedPrisma.conversations.findUnique({ where: { id: conversationId } });
  assert.ok(row?.deleted_at, 'the row is retained with a deleted_at');
});

test('deleting a website takes its conversations and leaves the other website alone', async () => {
  const mine = await createConversation(secondWebsiteId, 'Deniz');
  const neighbour = await createConversation(websiteId, 'Ece');

  const res = await deleteThing('website', secondWebsiteId, 'duplicate site created by mistake');
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json().affected, { websites: 1, conversations: 1 });

  assert.equal(await asCustomer().websites.count({ where: { id: secondWebsiteId } }), 0);
  assert.equal(await asCustomer().conversations.count({ where: { id: mine } }), 0);
  assert.equal(await asCustomer().conversations.count({ where: { id: neighbour } }), 1);

  // `is_active` goes false as well as the timestamp: every widget boot check reads both,
  // and one forgotten predicate would otherwise keep serving a deleted website.
  const row = await unscopedPrisma.websites.findUniqueOrThrow({ where: { id: secondWebsiteId } });
  assert.equal(row.is_active, false);
  assert.ok(row.deleted_at);
});

test('the same thing cannot be deleted twice', async () => {
  const res = await deleteThing('website', secondWebsiteId, 'trying again');
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'already_deleted');
});

test('restoring brings back exactly what that deletion touched — and nothing else', async () => {
  // The customer deletes one of their own websites first. Nothing about the workspace
  // deletion that follows may reverse that decision.
  const customerDeleted = await createWebsite('Retired site');
  const retiredConversation = await createConversation(customerDeleted, 'Fatma');
  const customerDelete = await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${workspaceId}/websites/${customerDeleted}`,
    headers: ownerAuth(),
  });
  assert.equal(customerDelete.statusCode, 200, customerDelete.body);

  const liveConversation = await createConversation(websiteId, 'Gizem');

  const deleted = await deleteThing('workspace', workspaceId, 'account closure requested — ticket 2');
  assert.equal(deleted.statusCode, 201, deleted.body);
  const eventId = deleted.json().deletion.id as string;

  // The retired website was already deleted, so it is not in this event's target list.
  const event = await unscopedPrisma.deletion_events.findUniqueOrThrow({ where: { id: eventId } });
  const targets = event.targets as { table: string; ids: string[] }[];
  const websiteTargets = targets.find((t) => t.table === 'websites')?.ids ?? [];
  assert.ok(!websiteTargets.includes(customerDeleted), 'an already-deleted website must not be captured');
  assert.ok(websiteTargets.includes(websiteId));

  const restore = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${eventId}/restore`,
    headers: staffAuth(),
    payload: { reason: 'deleted the wrong account — ticket 2' },
  });
  assert.equal(restore.statusCode, 200, restore.body);

  const workspace = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(workspace.deleted_at, null, 'the workspace is back');
  assert.equal(await asCustomer().websites.count({ where: { id: websiteId } }), 1, 'its live website is back');
  assert.equal(await asCustomer().conversations.count({ where: { id: liveConversation } }), 1);

  // The thing the customer had already deleted stays deleted. This is the assertion the
  // whole `targets` mechanism exists for.
  assert.equal(await asCustomer().websites.count({ where: { id: customerDeleted } }), 0);

  // Its conversation, on the other hand, is live — and deliberately so. The customer's
  // own website delete (routes/v1/workspaces.ts) soft-deletes the WEBSITE only, on the
  // stated grounds that clicking Delete on a website must not destroy their support
  // history. So that conversation was live when the workspace was deleted, was captured
  // by this event, and comes back with it. The asymmetry with the ops-side website
  // delete (which does take conversations) is real: one is a customer tidying up, the
  // other is us removing data on request.
  assert.equal(await asCustomer().conversations.count({ where: { id: retiredConversation } }), 1);
});

test('a restored deletion cannot be restored again', async () => {
  const conversationId = await createConversation(websiteId, 'Halil');
  const deleted = await deleteThing('conversation', conversationId);
  const eventId = deleted.json().deletion.id as string;

  const first = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${eventId}/restore`,
    headers: staffAuth(),
    payload: { reason: 'put it back please' },
  });
  assert.equal(first.statusCode, 200, first.body);

  const second = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${eventId}/restore`,
    headers: staffAuth(),
    payload: { reason: 'put it back again' },
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().code, 'already_restored');
});

test('deleting a user keeps their memberships, so a restore puts them back on the team', async () => {
  const deleted = await deleteThing('user', ownerUserId, 'duplicate account — ticket 3');
  assert.equal(deleted.statusCode, 201, deleted.body);

  const memberships = await unscopedPrisma.workspace_members.count({ where: { user_id: ownerUserId } });
  assert.equal(memberships, 1, 'membership rows survive a soft-deleted user');

  // And the account is actually unusable in the meantime.
  const blocked = await app.inject({ method: 'GET', url: '/api/v1/me', headers: ownerAuth() });
  assert.equal(blocked.statusCode, 401, blocked.body);

  const restore = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${deleted.json().deletion.id}/restore`,
    headers: staffAuth(),
    payload: { reason: 'wrong account — ticket 3' },
  });
  assert.equal(restore.statusCode, 200, restore.body);
  const user = await unscopedPrisma.users.findUniqueOrThrow({ where: { id: ownerUserId } });
  assert.equal(user.deleted_at, null);
});

test('the sweep leaves anything inside the window alone', async () => {
  const conversationId = await createConversation(websiteId, 'Irmak');
  await deleteThing('conversation', conversationId);

  const report = await purgeExpiredDeletions();
  assert.equal(report.purged, 0, 'nothing is due yet');
  assert.ok(await unscopedPrisma.conversations.findUnique({ where: { id: conversationId } }));
});

test(`past ${RESTORE_WINDOW_DAYS} days the sweep deletes for real, and says so where the row cannot`, async () => {
  const conversationId = await createConversation(websiteId, 'Jale');
  const deleted = await deleteThing('conversation', conversationId, 'spam — ticket 4');
  const eventId = deleted.json().deletion.id as string;

  // Reach into `purge_after` rather than faking a clock: it is the column the sweep
  // reads, and moving it is exactly what ninety days of waiting does.
  await unscopedPrisma.deletion_events.update({
    where: { id: eventId },
    data: { purge_after: new Date(Date.now() - 60_000) },
  });

  const report = await purgeExpiredDeletions();
  assert.equal(report.purged, 1, JSON.stringify(report));
  assert.equal(await unscopedPrisma.conversations.findUnique({ where: { id: conversationId } }), null);

  const event = await unscopedPrisma.deletion_events.findUniqueOrThrow({ where: { id: eventId } });
  assert.ok(event.purged_at, 'the event records the outcome');
  assert.equal(event.target_label, 'Jale', 'the label survives the row it named');
  assert.equal(event.reason, 'spam — ticket 4');

  // Restoring after the sweep must fail loudly rather than report a success that
  // restored nothing.
  const restore = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${eventId}/restore`,
    headers: staffAuth(),
    payload: { reason: 'customer changed their mind' },
  });
  assert.equal(restore.statusCode, 409, restore.body);
  assert.equal(restore.json().code, 'already_purged');
});

test('purging a workspace cascades, and the record of it survives the workspace', async () => {
  // The most consequential path in the file: a real customer's row, removed for good,
  // with a dozen cascades hanging off it. Its own workspace so nothing else is caught.
  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Nil', email: 'nil@example.com', password: CUSTOMER_PASSWORD, workspace_name: 'Doomed' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const token = signup.json().access_token as string;
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
  const doomedId = me.json().workspaces[0].id as string;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${doomedId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Doomed site' },
  });
  const doomedSite = site.json().website.id as string;
  const conversation = await unscopedPrisma.conversations.create({
    data: { workspace_id: doomedId, website_id: doomedSite, visitor_id: 'v-doomed', status: 'open' },
    select: { id: true },
  });

  const deleted = await deleteThing('workspace', doomedId, 'account closed at their request — ticket 8');
  assert.equal(deleted.statusCode, 201, deleted.body);
  const eventId = deleted.json().deletion.id as string;

  await unscopedPrisma.deletion_events.update({
    where: { id: eventId },
    data: { purge_after: new Date(Date.now() - 60_000) },
  });
  const report = await purgeExpiredDeletions();
  assert.ok(report.purged >= 1, JSON.stringify(report));
  assert.equal(report.failed, 0, 'a cascade that cannot complete leaves data past the promised window');

  assert.equal(await unscopedPrisma.workspaces.findUnique({ where: { id: doomedId } }), null);
  assert.equal(await unscopedPrisma.websites.count({ where: { id: doomedSite } }), 0, 'websites cascaded');
  assert.equal(
    await unscopedPrisma.conversations.count({ where: { id: conversation.id } }),
    0,
    'conversations cascaded',
  );

  // The event outlives its subject — this is what `ON DELETE SET NULL` and the label
  // snapshot are for. Without them, purging a workspace would erase the only record
  // that says we purged it.
  const event = await unscopedPrisma.deletion_events.findUniqueOrThrow({ where: { id: eventId } });
  assert.equal(event.workspace_id, null);
  assert.equal(event.target_label, 'Doomed');
  assert.ok(event.purged_at);
  assert.match(event.reason, /ticket 8/);

  // `audit_log` rows for a purged workspace cascade away with it, so the sweep writes a
  // platform-scoped one. It is what remains to answer "what happened to this customer?".
  const trail = await unscopedPrisma.audit_log.findFirst({
    where: { action: 'platform.deletion_purged', target_id: doomedId },
  });
  assert.ok(trail, 'the purge leaves a platform-level audit row behind');
  assert.equal(trail.workspace_id, null);

  // And the user survives their workspace: their login is not the customer's property.
  const user = await unscopedPrisma.users.findUnique({ where: { email: 'nil@example.com' } });
  assert.ok(user, 'a purged workspace does not take its people');
});

test('the audit log offers Undo only while the deletion is still reversible', async () => {
  const pending = await createConversation(websiteId, 'Kerem');
  const pendingEvent = (await deleteThing('conversation', pending, 'noise — ticket 5')).json().deletion.id;

  const purged = await createConversation(websiteId, 'Leyla');
  const purgedEvent = (await deleteThing('conversation', purged, 'noise — ticket 6')).json().deletion.id;
  await unscopedPrisma.deletion_events.update({
    where: { id: purgedEvent },
    data: { purge_after: new Date(Date.now() - 60_000) },
  });
  await purgeExpiredDeletions();

  const res = await app.inject({
    method: 'GET',
    url: '/platform/audit?action=platform.deleted&per_page=100',
    headers: staffAuth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const entries = res.json().entries as {
    details: { deletion_event_id?: string };
    restore: { deletion_event_id: string } | null;
  }[];

  const pendingRow = entries.find((e) => e.details.deletion_event_id === pendingEvent);
  const purgedRow = entries.find((e) => e.details.deletion_event_id === purgedEvent);
  assert.ok(pendingRow?.restore, 'a pending deletion is offered an undo');
  assert.equal(purgedRow?.restore, null, 'a purged one is not');
});

test('a deletion is recorded in the customer’s own audit log, with who and why', async () => {
  const conversationId = await createConversation(websiteId, 'Mert');
  await deleteThing('conversation', conversationId, 'contained card details — ticket 7');

  const res = await app.inject({
    method: 'GET',
    url: `/platform/workspaces/${workspaceId}/activity`,
    headers: staffAuth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const entry = (res.json().entries as { action: string; actor_email: string | null; details: { reason?: string } }[]).find(
    (e) => e.action === 'platform.deleted',
  );
  assert.ok(entry, 'the customer can see that we deleted something');
  assert.equal(entry.actor_email, 'ops@nestled.chat');
  assert.match(String(entry.details.reason), /ticket 7/);
});
