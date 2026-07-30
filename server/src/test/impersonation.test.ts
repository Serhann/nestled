import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { tenantDb, TenantScopeError } from '../db/tenant.js';
import { capabilitiesFor } from '../permissions.js';

/**
 * Impersonation, from both ends.
 *
 * Minting the session is the easy half. The half worth testing is what the minted
 * token can and cannot do once it is on the customer plane: that it is confined to
 * one workspace, that `read_only` cannot write even if a route forgets to check,
 * that every mutation lands in the CUSTOMER's audit log attributed to the staff
 * member, and that ending the session kills the token without waiting for its TTL.
 */

let app: FastifyInstance;
let staffToken: string;
let staffId: string;
let ownerToken: string;
let workspaceA: string;
let workspaceB: string;
let ownerUserId: string;

const STAFF_SECRET = generateTotpSecret();
const STAFF_PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });

async function signup(name: string, email: string, workspace: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: CUSTOMER_PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().access_token as string;
}

async function workspaceOf(token: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
  return res.json().workspaces[0].id as string;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });

  app = await buildServer();
  await app.ready();

  const staff = await unscopedPrisma.platform_users.create({
    data: {
      email: 'ops@nestled.chat',
      name: 'Ops',
      role: 'superadmin',
      password_hash: await hashPassword(STAFF_PASSWORD),
      totp_secret: STAFF_SECRET,
      totp_enabled: true,
    },
    select: { id: true },
  });
  staffId = staff.id;

  const res = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'ops@nestled.chat', password: STAFF_PASSWORD, totp: currentCode(STAFF_SECRET) },
  });
  assert.equal(res.statusCode, 200, res.body);
  staffToken = res.json().token;

  ownerToken = await signup('Ada', 'ada@example.com', 'Acme');
  workspaceA = await workspaceOf(ownerToken);
  ownerUserId = (await unscopedPrisma.users.findUniqueOrThrow({ where: { email: 'ada@example.com' } })).id;

  const otherToken = await signup('Bob', 'bob@example.com', 'Beta');
  workspaceB = await workspaceOf(otherToken);
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

async function impersonate(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/impersonate`,
    headers: staffAuth(),
    payload,
  });
}

/**
 * Redeem the handover code the mint returned, the way the customer app's tab does.
 *
 * The mint no longer returns a token at all (see migration 0013), so every assertion below
 * that needs one goes through this — which means these tests now cover both halves of the
 * real flow rather than a token nobody would receive that way.
 */
async function claim(minted: { json: () => { handover_url: string } }): Promise<string> {
  const code = new URL(minted.json().handover_url).hash.replace(/^#c=/, '');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().access_token as string;
}

test('a reason is mandatory, and a token cannot be minted without one', async () => {
  for (const payload of [
    { scope: 'read_only' },
    { reason: 'short', scope: 'read_only' },
    { reason: '', scope: 'full' },
  ]) {
    const res = await impersonate(workspaceA, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('the TTL is capped at 30 minutes whatever the client asks for', async () => {
  const res = await impersonate(workspaceA, {
    reason: 'reproducing the reported widget crash',
    scope: 'read_only',
    ttl_minutes: 120,
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('a full session mints a customer token with an act claim and no refresh token', async () => {
  const res = await impersonate(workspaceA, {
    reason: 'customer reported the inbox is empty after upgrading',
    scope: 'full',
    ttl_minutes: 20,
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();

  // The mint hands over a URL, never a credential — see migration 0013 for the textarea
  // full of bearer token this replaced.
  assert.equal(body.access_token, undefined, 'the panel must not be given the token');
  assert.match(body.handover_url as string, /\/impersonate#c=/);
  assert.equal(body.session.scope, 'full');
  assert.equal(body.session.target.email, 'ada@example.com', 'defaults to the workspace owner');

  const redeemed = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code: new URL(body.handover_url).hash.replace(/^#c=/, '') },
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  assert.equal(redeemed.json().refresh_token, null, 'an impersonation credential must not be renewable');

  const claims = jwt.decode(redeemed.json().access_token) as Record<string, unknown>;
  assert.equal(claims.typ, 'user');
  assert.equal(claims.sub, ownerUserId);
  assert.deepEqual(claims.act, {
    pu: staffId,
    sid: body.session.id,
    ws: workspaceA,
    scope: 'full',
  });
  // The JWT must not outlive the session row it belongs to, or support silently
  // loses access mid-investigation with nothing to refresh from.
  const ttlSeconds = (claims.exp as number) - (claims.iat as number);
  assert.ok(ttlSeconds <= 20 * 60 + 5 && ttlSeconds >= 20 * 60 - 5, `ttl was ${ttlSeconds}s`);

  const row = await unscopedPrisma.impersonation_sessions.findUniqueOrThrow({
    where: { id: body.session.id },
  });
  assert.equal(row.reason, 'customer reported the inbox is empty after upgrading');
  assert.equal(row.workspace_id, workspaceA);
  assert.equal(row.target_user_id, ownerUserId);
});

test('the impersonated token works on the customer plane and announces itself', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'checking whether their plan limits are applied correctly',
    scope: 'full',
  });
  const token = await claim(minted);
  const headers = { authorization: `Bearer ${token}` };

  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  assert.equal(me.statusCode, 200, me.body);
  // Without this block the customer has no way to know a staff member is inside
  // their account — the client renders it as an unmissable banner with a countdown.
  assert.deepEqual(me.json().impersonation, {
    by_platform_user_id: staffId,
    scope: 'full',
    workspace_id: workspaceA,
    expires_at: minted.json().session.expires_at,
  });
  // The countdown's number must be the SESSION's end, not the token's: they agree today
  // because the token is minted to the remaining time, and this is what keeps them
  // agreeing if that ever changes.
  const sessionRow = await unscopedPrisma.impersonation_sessions.findUniqueOrThrow({
    where: { id: minted.json().session.id },
    select: { expires_at: true },
  });
  assert.equal(me.json().impersonation.expires_at, sessionRow.expires_at.toISOString());

  const ws = await app.inject({ method: 'GET', url: `/api/v1/w/${workspaceA}`, headers });
  assert.equal(ws.statusCode, 200, ws.body);
});

test('a session is bound to ONE workspace and cannot be replayed against another', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'confirming the workspace binding holds',
    scope: 'full',
  });
  const headers = { authorization: `Bearer ${await claim(minted)}` };

  // Same token, different workspace in the path. Editing the URL is the entire
  // attack, and requireWorkspace refuses it before any query runs.
  const res = await app.inject({ method: 'GET', url: `/api/v1/w/${workspaceB}`, headers });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(res.json().error, /scoped to a different workspace/);
});

test('impersonation subtracts billing, integrations, membership and export', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'verifying the capability subtraction is applied',
    scope: 'full',
  });
  const headers = { authorization: `Bearer ${await claim(minted)}` };

  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  const permissions: string[] = me.json().workspaces[0].permissions;
  // The owner would normally have all of these. "We were debugging" stops being a
  // defensible explanation for any of them.
  for (const denied of [
    'billing:manage',
    'integration:manage',
    'workspace:delete',
    'member:invite',
    'member:update',
    'member:remove',
    'export:data',
  ]) {
    assert.ok(!permissions.includes(denied), `${denied} survived impersonation`);
  }
  assert.ok(permissions.includes('conversation:read'));

  // The route agrees with the advertised list.
  const integrations = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceA}/integrations`,
    headers,
  });
  assert.equal(integrations.statusCode, 403, integrations.body);
});

test('a read_only session is refused at the capability layer', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'reading their configuration to answer a support question',
    scope: 'read_only',
  });
  const headers = { authorization: `Bearer ${await claim(minted)}` };

  const read = await app.inject({ method: 'GET', url: `/api/v1/w/${workspaceA}/conversations`, headers });
  assert.equal(read.statusCode, 200, read.body);

  const write = await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceA}`,
    headers,
    payload: { name: 'Renamed by support' },
  });
  assert.equal(write.statusCode, 403, write.body);

  // And the workspace was genuinely not renamed.
  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceA } });
  assert.equal(ws.name, 'Acme');
});

test('a read_only session THROWS on the first write even if a route forgets to check', async () => {
  // The mechanical backstop, asserted directly against the tenant client rather
  // than through a route: with `readOnly` set, every non-read Prisma operation
  // throws before it reaches Postgres. The capability layer produces the honest
  // 403; THIS is what makes a forgotten check a 500 instead of a data change.
  const db = tenantDb({ workspaceId: workspaceA, websiteIds: null, readOnly: true });

  await assert.rejects(
    () => db.knowledge_base.create({ data: { question: 'q', answer: 'a' } as never }),
    (err: Error) => {
      assert.ok(err instanceof TenantScopeError, `expected TenantScopeError, got ${err.name}`);
      assert.match(err.message, /read-only session attempted create on knowledge_base/);
      return true;
    },
  );
  await assert.rejects(
    () => db.conversations.updateMany({ where: {}, data: { status: 'resolved' } }),
    TenantScopeError,
  );
  await assert.rejects(() => db.workspace_members.deleteMany({ where: {} }), TenantScopeError);

  // Reads still work, or the session would be useless rather than read-only.
  assert.equal(typeof (await db.conversations.count()), 'number');

  // Nothing was written.
  assert.equal(await unscopedPrisma.knowledge_base.count({ where: { workspace_id: workspaceA } }), 0);
});

test('capabilitiesFor is the single source of the subtraction', async () => {
  // Pinned as a unit too, so a change to the matrix fails here with a clear diff
  // rather than only as a surprising 403 in an integration test.
  const full = capabilitiesFor('owner', 'full');
  const readOnly = capabilitiesFor('owner', 'read_only');
  assert.ok(!full.has('billing:manage'));
  assert.ok(full.has('conversation:reply'));
  assert.ok(!readOnly.has('conversation:reply'));
  assert.ok(readOnly.has('conversation:read'));
  for (const cap of readOnly) assert.ok(full.has(cap), `${cap} is in read_only but not in full`);
});

test('a mutation while impersonating lands in the CUSTOMER audit log, as the staff member', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'renaming the workspace at the owner request over email',
    scope: 'full',
  });
  const sessionId = minted.json().session.id as string;
  const headers = { authorization: `Bearer ${await claim(minted)}` };

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceA}`,
    headers,
    payload: { name: 'Acme Corporation' },
  });
  assert.equal(res.statusCode, 200, res.body);

  const entry = await unscopedPrisma.audit_log.findFirst({
    where: { workspace_id: workspaceA, impersonation_session_id: sessionId, action: { startsWith: 'workspace' } },
    orderBy: { created_at: 'desc' },
  });
  assert.ok(entry, 'the mutation must be recorded in the customer own log');
  // Attributed to the staff member driving it, not to the customer whose session
  // it borrows — that distinction is the whole point of the act claim.
  assert.equal(entry.actor_type, 'platform_user');
  assert.equal(entry.actor_id, staffId);
  assert.equal(entry.impersonation_session_id, sessionId);

  // The customer can see it on their own audit page, with no involvement from us.
  const customerView = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceA}/audit`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(customerView.statusCode, 200, customerView.body);
  const visible = customerView.json().entries.find((e: { id: string }) => e.id === entry.id);
  assert.ok(visible, 'the entry must be visible to the customer');

  await unscopedPrisma.workspaces.update({ where: { id: workspaceA }, data: { name: 'Acme' } });
});

test('ending a session kills the token without waiting for its TTL', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'testing that early termination actually terminates',
    scope: 'read_only',
    ttl_minutes: 30,
  });
  const sessionId = minted.json().session.id as string;
  const headers = { authorization: `Bearer ${await claim(minted)}` };

  const ended = await app.inject({
    method: 'POST',
    url: `/platform/impersonations/${sessionId}/end`,
    headers: staffAuth(),
  });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().effective_within_seconds, 10);

  // The token is used for the FIRST time after the end, so requireAuth has nothing
  // cached and must consult the row. That is the path this test is about; the 10s
  // liveness cache in plugins/auth.ts is the only reason an already-warm token can
  // outlive the end call, and the response above states that window explicitly
  // rather than leaving the caller to discover it.
  const after_ = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  assert.equal(after_.statusCode, 401, after_.body);
  assert.match(after_.json().error, /Impersonation session ended/);

  // Ending twice is not an error — the button can be pressed by two people.
  const again = await app.inject({
    method: 'POST',
    url: `/platform/impersonations/${sessionId}/end`,
    headers: staffAuth(),
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().already_ended, true);
});

test('an expired session row invalidates the token even while the JWT is valid', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'confirming expiry is enforced from the row, not the token',
    scope: 'read_only',
    ttl_minutes: 30,
  });
  const sessionId = minted.json().session.id as string;
  const token = await claim(minted);
  const headers = { authorization: `Bearer ${token}` };

  await unscopedPrisma.impersonation_sessions.update({
    where: { id: sessionId },
    data: { expires_at: new Date(Date.now() - 1000) },
  });

  // The JWT itself is still nowhere near its exp; the row is what decides.
  const claims = jwt.decode(token) as { exp: number };
  assert.ok(claims.exp * 1000 > Date.now(), 'precondition: the JWT has not expired');

  const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  assert.equal(res.statusCode, 401, res.body);
});

test('the register lists every session, counts what each one did, and cannot be deleted', async () => {
  const list = await app.inject({ method: 'GET', url: '/platform/impersonations', headers: staffAuth() });
  assert.equal(list.statusCode, 200, list.body);
  const sessions = list.json().sessions as Record<string, unknown>[];
  assert.ok(sessions.length >= 5, `expected the register to hold this run's sessions, got ${sessions.length}`);
  for (const s of sessions) {
    assert.ok(typeof s.reason === 'string' && (s.reason as string).length > 0, 'every row carries its reason');
    assert.equal(typeof s.mutations, 'number');
  }

  // There is no DELETE route on this collection, anywhere. A staff member cannot
  // curate the record of what staff did.
  const remove = await app.inject({
    method: 'DELETE',
    url: `/platform/impersonations/${sessions[0]!.id}`,
    headers: staffAuth(),
  });
  assert.equal(remove.statusCode, 404, 'no route may exist to delete an impersonation record');

  const detail = await app.inject({
    method: 'GET',
    url: `/platform/impersonations/${sessions[0]!.id}`,
    headers: staffAuth(),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.ok(Array.isArray(detail.json().session.audit_entries));
});

test('a workspace with no impersonatable member is refused, not fudged', async () => {
  const plan = await unscopedPrisma.plans.findFirstOrThrow({ where: { code: 'free' } });
  const empty = await unscopedPrisma.workspaces.create({
    data: { name: 'Empty', slug: `empty-${Date.now()}`, plan_id: plan.id },
    select: { id: true },
  });
  const res = await impersonate(empty.id, {
    reason: 'attempting to impersonate a memberless workspace',
    scope: 'read_only',
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, 'no_target');
  // No orphan session row was written for the failed attempt.
  assert.equal(await unscopedPrisma.impersonation_sessions.count({ where: { workspace_id: empty.id } }), 0);
});

// ── The handover ─────────────────────────────────────────────────────────────
//
// The mint hands the panel a URL with a single-use code; the customer app's tab redeems it.
// What these pin is the part that makes that safer than the textarea of bearer token it
// replaced: the code works once, briefly, and buys no more than the session it belongs to.

test('a handover code works exactly once', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'confirming the handover code cannot be replayed',
    scope: 'read_only',
  });
  const code = new URL(minted.json().handover_url).hash.replace(/^#c=/, '');

  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code },
  });
  assert.equal(first.statusCode, 200, first.body);

  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code },
  });
  assert.equal(second.statusCode, 400, second.body);
  assert.equal(second.json().code, 'claim_invalid');
});

test('the code is not stored in a form that still works, and is dropped once spent', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'checking the code is hashed at rest like every other opaque token',
    scope: 'read_only',
  });
  const code = new URL(minted.json().handover_url).hash.replace(/^#c=/, '');
  const sessionId = minted.json().session.id as string;

  const before = await unscopedPrisma.impersonation_sessions.findUniqueOrThrow({
    where: { id: sessionId },
    select: { claim_code_hash: true, claimed_at: true },
  });
  assert.ok(before.claim_code_hash, 'a hash is stored');
  assert.notEqual(before.claim_code_hash, code, 'the code itself is never stored');
  assert.equal(before.claimed_at, null);

  await claim(minted);

  const after = await unscopedPrisma.impersonation_sessions.findUniqueOrThrow({
    where: { id: sessionId },
    select: { claim_code_hash: true, claimed_at: true },
  });
  assert.equal(after.claim_code_hash, null, 'the hash goes once the code is spent');
  assert.ok(after.claimed_at, 'and the record that it was used stays');
});

test('an expired code is refused, and says nothing about which failure it was', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'checking the sixty-second window is enforced',
    scope: 'read_only',
  });
  const code = new URL(minted.json().handover_url).hash.replace(/^#c=/, '');

  await unscopedPrisma.impersonation_sessions.update({
    where: { id: minted.json().session.id },
    data: { claim_expires_at: new Date(Date.now() - 1000) },
  });

  const expired = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code },
  });
  assert.equal(expired.statusCode, 400, expired.body);
  assert.equal(expired.json().code, 'claim_invalid');

  // Same code and message as a nonexistent one: a tab that cannot tell them apart cannot
  // be used to probe which codes exist.
  const nonsense = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code: 'this-code-never-existed-at-all' },
  });
  assert.equal(nonsense.statusCode, 400, nonsense.body);
  assert.equal(nonsense.json().error, expired.json().error);
});

test('redeeming late does not extend the window the operator agreed to', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'checking the token inherits what remains rather than a fresh ttl',
    scope: 'read_only',
    ttl_minutes: 20,
  });
  const sessionId = minted.json().session.id as string;

  // Five minutes of the session have gone by the time the tab opens.
  await unscopedPrisma.impersonation_sessions.update({
    where: { id: sessionId },
    data: { expires_at: new Date(Date.now() + 15 * 60_000) },
  });

  const token = await claim(minted);
  const claims = jwt.decode(token) as { exp: number };
  const remaining = claims.exp * 1000 - Date.now();
  assert.ok(
    remaining <= 15 * 60_000 + 5_000,
    `the token must expire with the session, not 20 minutes from redemption — got ${Math.round(remaining / 1000)}s`,
  );
});

test('a code for a session that was already ended is refused', async () => {
  const minted = await impersonate(workspaceA, {
    reason: 'checking an ended session cannot be opened afterwards',
    scope: 'read_only',
  });
  const ended = await app.inject({
    method: 'POST',
    url: `/platform/impersonations/${minted.json().session.id}/end`,
    headers: staffAuth(),
  });
  assert.equal(ended.statusCode, 200, ended.body);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/impersonation/claim',
    payload: { code: new URL(minted.json().handover_url).hash.replace(/^#c=/, '') },
  });
  assert.equal(res.statusCode, 400, res.body);
});
