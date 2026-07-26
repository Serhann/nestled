import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { signAccessToken, hashToken } from '../auth/tokens.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { ensureSeedPlatformUser } from '../db/seedPlatform.js';

/**
 * The vendor plane's authentication, and the wall between it and the customer one.
 *
 * The central claim of Phase 13 is that staff auth is a different MECHANISM, not a
 * different secret. Two assertions carry that claim and everything else here is
 * support for them:
 *
 *   - a valid customer JWT is rejected on /platform/*
 *   - a valid staff session is rejected on /api/*
 *
 * Both must hold even though the two planes share a process, a database and (for
 * the JWT) a signing key. They hold because neither plane contains code that can
 * read the other's credential: /platform/* has no JWT verifier mounted, and /api/*
 * never queries platform_sessions.
 */

let app: FastifyInstance;

const STAFF_EMAIL = 'ops@nestled.chat';
const STAFF_PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

let staffId: string;
let staffToken: string;
let customerToken: string;
let workspaceId: string;

async function login(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/platform/auth/login', payload });
}

const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });

  app = await buildServer();
  await app.ready();

  const staff = await unscopedPrisma.platform_users.create({
    data: {
      email: STAFF_EMAIL,
      name: 'Ops',
      role: 'superadmin',
      password_hash: await hashPassword(STAFF_PASSWORD),
    },
    select: { id: true },
  });
  staffId = staff.id;

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      name: 'Ada',
      email: 'ada@example.com',
      password: CUSTOMER_PASSWORD,
      workspace_name: 'Acme',
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  customerToken = signup.json().access_token;

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${customerToken}` },
  });
  workspaceId = me.json().workspaces[0].id;

  const res = await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
  staffToken = res.json().token;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

// ── The wall ─────────────────────────────────────────────────────────────────

test('a valid CUSTOMER token is rejected on the platform plane', async () => {
  // The token below authenticates perfectly on /api/*. It is signed with the same
  // JWT_ACCESS_SECRET the server uses. It still cannot open /platform/me, because
  // requirePlatform does not verify JWTs at all — it looks the presented string up
  // in platform_sessions, and a JWT is not a session token.
  const onCustomerPlane = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${customerToken}` },
  });
  assert.equal(onCustomerPlane.statusCode, 200, 'precondition: the customer token is valid');

  for (const url of ['/platform/me', '/platform/workspaces', '/platform/health', '/platform/search?q=acme']) {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${customerToken}` } });
    assert.equal(res.statusCode, 401, `${url} accepted a customer token: ${res.body}`);
  }
});

test('a forged customer token claiming staff-shaped fields is still rejected', async () => {
  // Belt and braces: even a token whose payload names a real platform user gets
  // nowhere, because nothing on this plane reads a JWT payload.
  const forged = signAccessToken({ sub: staffId, typ: 'user', email: STAFF_EMAIL });
  const res = await app.inject({
    method: 'GET',
    url: '/platform/me',
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('a valid PLATFORM session is rejected on the customer plane', async () => {
  const onPlatform = await app.inject({ method: 'GET', url: '/platform/me', headers: staffAuth() });
  assert.equal(onPlatform.statusCode, 200, 'precondition: the staff token is valid');

  for (const url of ['/api/v1/me', `/api/v1/w/${workspaceId}`, `/api/v1/w/${workspaceId}/conversations`]) {
    const res = await app.inject({ method: 'GET', url, headers: staffAuth() });
    assert.equal(res.statusCode, 401, `${url} accepted a staff session token: ${res.body}`);
  }
});

test('the customer plane never reads platform_sessions', async () => {
  // The structural version of the assertion above: the staff token exists as a row,
  // so if /api/* consulted that table at all this request would succeed.
  const row = await unscopedPrisma.platform_sessions.findUnique({
    where: { token_hash: hashToken(staffToken) },
    select: { id: true },
  });
  assert.ok(row, 'precondition: the session row exists');

  const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: staffAuth() });
  assert.equal(res.statusCode, 401);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

test('login refuses bad credentials with one indistinguishable answer', async () => {
  const wrongPassword = await login({ email: STAFF_EMAIL, password: 'nope nope nope' });
  const unknownUser = await login({ email: 'nobody@nestled.chat', password: STAFF_PASSWORD });

  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(unknownUser.statusCode, 401);
  // Identical, so the panel cannot be used to enumerate which addresses are staff.
  assert.deepEqual(wrongPassword.json(), unknownUser.json());
});

test('the session token is stored only as a hash', async () => {
  const stored = await unscopedPrisma.platform_sessions.findFirst({
    where: { platform_user_id: staffId },
    select: { token_hash: true },
  });
  assert.ok(stored);
  assert.notEqual(stored.token_hash, staffToken);
  assert.equal(stored.token_hash, hashToken(staffToken));
  // A database dump must not be replayable against the panel.
  const byPlaintext = await unscopedPrisma.platform_sessions.findFirst({
    where: { token_hash: staffToken },
  });
  assert.equal(byPlaintext, null);
});

test('logout revokes the session immediately, not at expiry', async () => {
  const fresh = (await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD })).json().token as string;
  const headers = { authorization: `Bearer ${fresh}` };

  assert.equal((await app.inject({ method: 'GET', url: '/platform/me', headers })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/platform/auth/logout', headers })).statusCode,
    200,
  );
  // No TTL wait, no cache to expire — the next request loses.
  assert.equal((await app.inject({ method: 'GET', url: '/platform/me', headers })).statusCode, 401);
});

test('an expired or disabled account cannot use a live session token', async () => {
  const fresh = (await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD })).json().token as string;
  const headers = { authorization: `Bearer ${fresh}` };

  await unscopedPrisma.platform_users.update({
    where: { id: staffId },
    data: { disabled_at: new Date() },
  });
  assert.equal((await app.inject({ method: 'GET', url: '/platform/me', headers })).statusCode, 401);
  await unscopedPrisma.platform_users.update({ where: { id: staffId }, data: { disabled_at: null } });

  await unscopedPrisma.platform_sessions.updateMany({
    where: { token_hash: hashToken(fresh) },
    data: { expires_at: new Date(Date.now() - 1000) },
  });
  assert.equal((await app.inject({ method: 'GET', url: '/platform/me', headers })).statusCode, 401);
});

// ── TOTP gates writes, not reads ─────────────────────────────────────────────

test('without a verified factor a staff session is read-only, whatever the role', async () => {
  const me = await app.inject({ method: 'GET', url: '/platform/me', headers: staffAuth() });
  assert.equal(me.json().user.role, 'superadmin');
  assert.equal(me.json().user.can_write, false);

  // Reads are fine.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/platform/workspaces', headers: staffAuth() })).statusCode,
    200,
  );

  // Every write is refused with a code the client can act on, including the ones a
  // superadmin would use to escalate.
  const writes: [string, string, Record<string, unknown>][] = [
    ['POST', `/platform/workspaces/${workspaceId}/notes`, { body: 'hello' }],
    ['POST', '/platform/users', { email: 'x@y.co', name: 'X', password: 'a'.repeat(14), role: 'superadmin' }],
    [
      'POST',
      `/platform/workspaces/${workspaceId}/impersonate`,
      { reason: 'investigating a billing report', scope: 'read_only' },
    ],
  ];
  for (const [method, url, payload] of writes) {
    const res = await app.inject({ method: method as 'POST', url, headers: staffAuth(), payload });
    assert.equal(res.statusCode, 403, `${method} ${url} was allowed without TOTP: ${res.body}`);
    assert.equal(res.json().code, 'totp_required');
  }
});

test('enrolling a factor lifts the read-only restriction', async () => {
  const start = await app.inject({ method: 'POST', url: '/platform/me/totp', headers: staffAuth() });
  assert.equal(start.statusCode, 200, start.body);
  const { secret, otpauth_uri } = start.json();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(otpauth_uri, /^otpauth:\/\/totp\//);

  // Starting enrollment alone must not grant anything — otherwise "call the enroll
  // endpoint" would be the whole bypass.
  const stillBlocked = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/notes`,
    headers: staffAuth(),
    payload: { body: 'too soon' },
  });
  assert.equal(stillBlocked.statusCode, 403);

  const wrong = await app.inject({
    method: 'POST',
    url: '/platform/me/totp/verify',
    headers: staffAuth(),
    payload: { code: '000000' },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().code, 'totp_invalid');

  const verified = await app.inject({
    method: 'POST',
    url: '/platform/me/totp/verify',
    headers: staffAuth(),
    payload: { code: currentCode(secret) },
  });
  assert.equal(verified.statusCode, 200, verified.body);

  const note = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/notes`,
    headers: staffAuth(),
    payload: { body: 'Customer asked about their trial end date.' },
  });
  assert.equal(note.statusCode, 201, note.body);
});

test('once enrolled, login itself demands the second factor', async () => {
  const withoutCode = await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
  assert.equal(withoutCode.statusCode, 401);
  assert.equal(withoutCode.json().code, 'totp_required');

  const badCode = await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD, totp: '000000' });
  assert.equal(badCode.statusCode, 401);

  const secret = (
    await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { id: staffId },
      select: { totp_secret: true },
    })
  ).totp_secret!;
  const good = await login({ email: STAFF_EMAIL, password: STAFF_PASSWORD, totp: currentCode(secret) });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().user.can_write, true);
  // Keep using the freshest token for the remaining tests in this file.
  staffToken = good.json().token;
});

test('a superadmin cannot demote or disable their own account', async () => {
  for (const payload of [{ role: 'support' }, { disabled: true }]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/platform/users/${staffId}`,
      headers: staffAuth(),
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('creating a staff account revokes nothing and starts read-only', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/platform/users',
    headers: staffAuth(),
    payload: {
      email: 'support@nestled.chat',
      name: 'Sam',
      password: 'another long staff password',
      role: 'support',
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const login2 = await login({ email: 'support@nestled.chat', password: 'another long staff password' });
  assert.equal(login2.statusCode, 200, login2.body);
  assert.equal(login2.json().user.can_write, false, 'a new account has no factor, so it cannot write');
  assert.equal(login2.json().user.role, 'support');

  const supportHeaders = { authorization: `Bearer ${login2.json().token}` };
  // Role gating is independent of the TOTP gate: support is not superadmin, so the
  // staff-account list is refused on role grounds.
  const forbidden = await app.inject({ method: 'GET', url: '/platform/users', headers: supportHeaders });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test('a factor cannot be removed without presenting a current code', async () => {
  const secret = generateTotpSecret();
  const victim = await unscopedPrisma.platform_users.create({
    data: {
      email: 'victim@nestled.chat',
      name: 'V',
      role: 'support',
      password_hash: await hashPassword('victim password is long'),
      totp_secret: secret,
      totp_enabled: true,
    },
    select: { id: true },
  });
  const session = (
    await login({ email: 'victim@nestled.chat', password: 'victim password is long', totp: currentCode(secret) })
  ).json().token as string;
  const headers = { authorization: `Bearer ${session}` };

  const wrong = await app.inject({ method: 'DELETE', url: '/platform/me/totp', headers, payload: { code: '000000' } });
  assert.equal(wrong.statusCode, 400);

  const right = await app.inject({
    method: 'DELETE',
    url: '/platform/me/totp',
    headers,
    payload: { code: currentCode(secret) },
  });
  assert.equal(right.statusCode, 200, right.body);
  assert.equal(right.json().can_write, false);

  await unscopedPrisma.platform_users.delete({ where: { id: victim.id } });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

test('the bootstrap seeds once on an empty table, then no-ops forever', async () => {
  const before_ = await unscopedPrisma.platform_users.count();
  assert.ok(before_ > 0, 'precondition: accounts already exist');

  process.env.SEED_PLATFORM_EMAIL = 'first@nestled.chat';
  process.env.SEED_PLATFORM_PASSWORD = 'bootstrap password value';
  try {
    await ensureSeedPlatformUser();
    assert.equal(await unscopedPrisma.platform_users.count(), before_, 'must not seed into a non-empty table');

    // Now on a genuinely empty table. Sessions cascade from platform_users, so this
    // also invalidates every token in this file — hence the re-login below.
    await unscopedPrisma.platform_users.deleteMany({});
    await ensureSeedPlatformUser();

    const seeded = await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { email: 'first@nestled.chat' },
    });
    assert.equal(seeded.role, 'superadmin');
    // Provisioned from an environment variable, so it starts unable to change
    // anything until somebody enrolls a factor interactively.
    assert.equal(seeded.totp_enabled, false);
    assert.equal(seeded.totp_secret, null);

    await ensureSeedPlatformUser();
    assert.equal(await unscopedPrisma.platform_users.count(), 1, 'a second call must be a no-op');
  } finally {
    delete process.env.SEED_PLATFORM_EMAIL;
    delete process.env.SEED_PLATFORM_PASSWORD;
  }
});
