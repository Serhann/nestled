import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { platformCapabilitiesFor, platformRoleCapabilities } from '../permissions.js';

/**
 * Scope-based permissions for staff accounts.
 *
 * Four roles used to be the whole model, and `platformRoleAllows` returned true for a
 * superadmin whatever was asked. The tests worth having are the ones that pin what that
 * could not express:
 *
 *   - a support account GRANTED one scope can do exactly that one extra thing,
 *   - a superadmin DENIED a scope is refused — deny beating superadmin is the only
 *     reason these are more than decoration,
 *   - and nobody can hand out a scope they do not hold, because `staff:manage`
 *     without that rule is a path to every other scope.
 */

let app: FastifyInstance;
let superToken: string;
let workspaceId: string;

const SUPER_SECRET = generateTotpSecret();
const PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A staff account with a verified factor, so it is past the read-only gate. */
async function staff(input: {
  email: string;
  role: 'superadmin' | 'support' | 'billing' | 'readonly';
  granted?: string[];
  denied?: string[];
}): Promise<{ token: string; id: string; secret: string }> {
  const secret = generateTotpSecret();
  const row = await unscopedPrisma.platform_users.create({
    data: {
      email: input.email,
      name: input.email,
      role: input.role,
      granted_scopes: input.granted ?? [],
      denied_scopes: input.denied ?? [],
      password_hash: await hashPassword(PASSWORD),
      totp_secret: secret,
      totp_enabled: true,
    },
    select: { id: true },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: input.email, password: PASSWORD, totp: currentCode(secret) },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { token: login.json().token, id: row.id, secret };
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });

  app = await buildServer();
  await app.ready();

  await unscopedPrisma.platform_users.create({
    data: {
      email: 'root@nestled.chat',
      name: 'Root',
      role: 'superadmin',
      password_hash: await hashPassword(PASSWORD),
      totp_secret: SUPER_SECRET,
      totp_enabled: true,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'root@nestled.chat', password: PASSWORD, totp: currentCode(SUPER_SECRET) },
  });
  superToken = login.json().token;

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: CUSTOMER_PASSWORD, workspace_name: 'Acme' },
  });
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: auth(signup.json().access_token),
  });
  workspaceId = me.json().workspaces[0].id;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

const deleteAttempt = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/platform/deletions',
    headers: auth(token),
    payload: { type: 'workspace', id: workspaceId, reason: 'testing the permission' },
  });

test('the role bundles are what the panel is told they are', () => {
  // Cheap, and it is the table every other test in this file leans on.
  assert.ok(platformRoleCapabilities('readonly').has('panel:read'));
  assert.ok(!platformRoleCapabilities('readonly').has('note:write'));
  assert.ok(platformRoleCapabilities('support').has('workspace:lifecycle'));
  assert.ok(!platformRoleCapabilities('support').has('deletion:create'), 'deleting is not a support default');
  assert.ok(platformRoleCapabilities('billing').has('plan:write'));
  assert.ok(!platformRoleCapabilities('billing').has('impersonate:full'));
  assert.ok(platformRoleCapabilities('superadmin').has('staff:manage'));
});

test('deny wins over a grant, and over superadmin', () => {
  const both = platformCapabilitiesFor('support', ['deletion:create'], ['deletion:create']);
  assert.ok(!both.has('deletion:create'), 'the same scope granted and denied stays denied');

  const restricted = platformCapabilitiesFor('superadmin', [], ['panel:read']);
  assert.ok(!restricted.has('panel:read'), 'a superadmin can be restricted');
  assert.ok(restricted.has('staff:manage'), 'and keeps everything else');
});

test('an unknown stored scope is ignored rather than fatal', () => {
  // These are values in a column. A capability dropped in a later release must not stop
  // an account from signing in.
  const caps = platformCapabilitiesFor('support', ['nonsense:write'], ['also:gone']);
  assert.ok(caps.has('workspace:lifecycle'));
  assert.ok(!caps.has('nonsense:write' as never));
});

test('a support account cannot delete a customer, and the 403 names the scope', async () => {
  const support = await staff({ email: 'support@nestled.chat', role: 'support' });
  const res = await deleteAttempt(support.token);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().code, 'missing_capability');
  assert.equal(res.json().capability, 'deletion:create');
});

test('granting that one scope is enough — no promotion required', async () => {
  const lead = await staff({
    email: 'lead@nestled.chat',
    role: 'support',
    granted: ['deletion:create'],
  });

  const res = await deleteAttempt(lead.token);
  assert.equal(res.statusCode, 201, res.body);

  // And it granted only that. Install-wide settings are still refused.
  const settings = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(lead.token),
    payload: { ops: { retention_days: 30 } },
  });
  assert.equal(settings.statusCode, 403, settings.body);
  assert.equal(settings.json().capability, 'settings:write');

  // Put the workspace back so later tests still have a customer to act on.
  const event = await unscopedPrisma.deletion_events.findFirstOrThrow({
    where: { target_id: workspaceId },
    orderBy: { created_at: 'desc' },
  });
  const restore = await app.inject({
    method: 'POST',
    url: `/platform/deletions/${event.id}/restore`,
    headers: auth(superToken),
    payload: { reason: 'putting the fixture back' },
  });
  assert.equal(restore.statusCode, 200, restore.body);
});

test('a denied scope is refused even on a superadmin', async () => {
  const restricted = await staff({
    email: 'restricted@nestled.chat',
    role: 'superadmin',
    denied: ['deletion:create'],
  });
  const res = await deleteAttempt(restricted.token);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().capability, 'deletion:create');

  // Still a superadmin for everything else.
  const list = await app.inject({ method: 'GET', url: '/platform/users', headers: auth(restricted.token) });
  assert.equal(list.statusCode, 200, list.body);
});

test('impersonating read-only and impersonating for real are different permissions', async () => {
  const watcher = await staff({
    email: 'watcher@nestled.chat',
    role: 'support',
    denied: ['impersonate:full'],
  });

  const readOnly = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/impersonate`,
    headers: auth(watcher.token),
    payload: { reason: 'reproducing the reported widget crash', scope: 'read_only' },
  });
  assert.equal(readOnly.statusCode, 201, readOnly.body);

  const full = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/impersonate`,
    headers: auth(watcher.token),
    payload: { reason: 'reproducing the reported widget crash', scope: 'full' },
  });
  assert.equal(full.statusCode, 403, full.body);
  assert.equal(full.json().capability, 'impersonate:full');
});

test('you cannot hand out a scope you do not hold yourself', async () => {
  // The escalation this rule exists for: `staff:manage` on a non-superadmin, used to
  // create an account with more scopes than the creator, whose password the creator sets.
  const manager = await staff({
    email: 'manager@nestled.chat',
    role: 'support',
    granted: ['staff:manage'],
  });

  const viaRole = await app.inject({
    method: 'POST',
    url: '/platform/users',
    headers: auth(manager.token),
    payload: {
      email: 'puppet@nestled.chat',
      name: 'Puppet',
      password: 'a long enough staff password',
      role: 'superadmin',
    },
  });
  assert.equal(viaRole.statusCode, 403, viaRole.body);
  assert.equal(viaRole.json().code, 'cannot_grant');

  const viaScope = await app.inject({
    method: 'POST',
    url: '/platform/users',
    headers: auth(manager.token),
    payload: {
      email: 'puppet@nestled.chat',
      name: 'Puppet',
      password: 'a long enough staff password',
      role: 'readonly',
      granted_scopes: ['settings:write'],
    },
  });
  assert.equal(viaScope.statusCode, 403, viaScope.body);
  assert.deepEqual(viaScope.json().missing, ['settings:write']);

  // What they CAN do: create an account within their own scopes.
  const allowed = await app.inject({
    method: 'POST',
    url: '/platform/users',
    headers: auth(manager.token),
    payload: {
      email: 'newhire@nestled.chat',
      name: 'New Hire',
      password: 'a long enough staff password',
      role: 'readonly',
      granted_scopes: ['note:write'],
    },
  });
  assert.equal(allowed.statusCode, 201, allowed.body);
  assert.equal(allowed.json().user.must_change_password, true);
});

test('nobody edits their own permissions', async () => {
  const manager = await unscopedPrisma.platform_users.findFirstOrThrow({
    where: { email: 'manager@nestled.chat' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'manager@nestled.chat', password: PASSWORD, totp: currentCode(manager.totp_secret!) },
  });
  const token = login.json().token as string;

  for (const payload of [{ granted_scopes: ['settings:write'] }, { denied_scopes: ['panel:read'] }]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/platform/users/${manager.id}`,
      headers: auth(token),
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload) + ' → ' + res.body);
  }
});

test('changing a scope revokes the account’s live sessions', async () => {
  const victim = await staff({ email: 'victim@nestled.chat', role: 'support' });

  const worksNow = await app.inject({ method: 'GET', url: '/platform/health', headers: auth(victim.token) });
  assert.equal(worksNow.statusCode, 200, worksNow.body);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/platform/users/${victim.id}`,
    headers: auth(superToken),
    payload: { denied_scopes: ['panel:read'] },
  });
  assert.equal(patched.statusCode, 200, patched.body);

  // A removed permission should not wait for the next request to bite, and revoking is
  // the one action that is certainly enough.
  const after = await app.inject({ method: 'GET', url: '/platform/health', headers: auth(victim.token) });
  assert.equal(after.statusCode, 401, after.body);
});

test('a staff member can change their own password, and the old sessions die with it', async () => {
  const person = await staff({ email: 'rotate@nestled.chat', role: 'readonly' });

  const wrong = await app.inject({
    method: 'POST',
    url: '/platform/me/password',
    headers: auth(person.token),
    payload: { current_password: 'not it at all', new_password: 'a brand new long password' },
  });
  assert.equal(wrong.statusCode, 400, wrong.body);

  const changed = await app.inject({
    method: 'POST',
    url: '/platform/me/password',
    headers: auth(person.token),
    payload: { current_password: PASSWORD, new_password: 'a brand new long password' },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const fresh = changed.json().token as string;
  assert.notEqual(fresh, person.token);

  // The token they called with is gone; the one they were handed works.
  const old = await app.inject({ method: 'GET', url: '/platform/me', headers: auth(person.token) });
  assert.equal(old.statusCode, 401, old.body);
  const now = await app.inject({ method: 'GET', url: '/platform/me', headers: auth(fresh) });
  assert.equal(now.statusCode, 200, now.body);
  assert.equal(now.json().user.must_change_password, false, 'the flag clears itself');

  // With the factor this account has enrolled, hence the code — a password change must
  // not become a way around the second factor.
  const relogin = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: {
      email: 'rotate@nestled.chat',
      password: 'a brand new long password',
      totp: currentCode(person.secret),
    },
  });
  assert.equal(relogin.statusCode, 200, relogin.body);

  const stale = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'rotate@nestled.chat', password: PASSWORD, totp: currentCode(person.secret) },
  });
  assert.equal(stale.statusCode, 401, 'the old password stops working');
});

test('the panel is told the vocabulary rather than hardcoding it', async () => {
  const res = await app.inject({ method: 'GET', url: '/platform/users', headers: auth(superToken) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  assert.ok(Array.isArray(body.catalog.capabilities) && body.catalog.capabilities.includes('deletion:create'));
  assert.deepEqual(body.catalog.roles, ['superadmin', 'support', 'billing', 'readonly']);
  assert.ok(body.catalog.by_role.support.includes('workspace:lifecycle'));

  // And each row carries its effective set, so the panel never recomputes the rule.
  const lead = (body.users as { email: string; capabilities: string[] }[]).find(
    (u) => u.email === 'lead@nestled.chat',
  );
  assert.ok(lead?.capabilities.includes('deletion:create'), 'the granted scope shows in the effective set');
});
