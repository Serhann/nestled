import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { currentCode } from '../lib/totp.js';

/**
 * Two-step verification on a customer account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The claim being tested is narrow and worth stating, because most of what a 2FA
 * feature does is visible on screen and therefore easy to believe without checking:
 *
 *   **After enrolment, the password alone stops working.**
 *
 * Everything else here exists to make sure that claim cannot be true by accident and
 * cannot be undone by a side door — an unconfirmed secret counting as enabled, a
 * replayed code, a recovery code spent twice, a support session removing the factor,
 * or a password reset walking straight past it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

let app: FastifyInstance;
let token: string;
let userId: string;

const EMAIL = 'grace@example.com';
const PASSWORD = 'correct horse battery';

const auth = () => ({ authorization: `Bearer ${token}` });

const login = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });

/** The secret only ever leaves the server once, during enrolment. */
async function storedSecret(): Promise<string> {
  const row = await unscopedPrisma.users.findUniqueOrThrow({
    where: { id: userId },
    select: { totp_secret: true },
  });
  assert.ok(row.totp_secret, 'expected a secret to be stored');
  return row.totp_secret;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Grace', email: EMAIL, password: PASSWORD, workspace_name: 'Acme' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  token = signup.json().access_token;

  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() });
  userId = me.json().user.id;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

test('a fresh account has no second factor, and login needs only a password', async () => {
  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().enabled, false);

  const res = await login({ email: EMAIL, password: PASSWORD });
  assert.equal(res.statusCode, 200, res.body);
});

test('enrolment needs the password, not just the session', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/totp',
    headers: auth(),
    payload: { password: 'not the password' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'bad_password');
});

test('a scanned-but-unconfirmed secret is not an enabled factor', async () => {
  const start = await app.inject({
    method: 'POST',
    url: '/api/v1/me/totp',
    headers: auth(),
    payload: { password: PASSWORD },
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.match(start.json().otpauth_uri, /^otpauth:\/\/totp\//);
  assert.ok(start.json().secret.length >= 32);

  // The secret is stored — but the account is untouched until a live code proves the
  // scan worked. Enabling on the POST would lock out anyone whose scan failed.
  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().enabled, false);

  const stillFine = await login({ email: EMAIL, password: PASSWORD });
  assert.equal(stillFine.statusCode, 200);
});

test('a wrong confirmation code does not enable it', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/totp/verify',
    headers: auth(),
    payload: { code: '000000' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'totp_invalid');

  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().enabled, false);
});

let recoveryCodes: string[] = [];

test('confirming with a live code turns it on and issues recovery codes', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/totp/verify',
    headers: auth(),
    payload: { code: currentCode(await storedSecret()) },
  });
  assert.equal(res.statusCode, 200, res.body);
  recoveryCodes = res.json().recovery_codes;
  assert.equal(recoveryCodes.length, 10);
  // Shown once, stored hashed. If the plaintext were in the table, a database dump
  // would hand over ten working bypasses per account.
  const stored = await unscopedPrisma.user_recovery_codes.findMany({
    where: { user_id: userId },
    select: { code_hash: true },
  });
  assert.equal(stored.length, 10);
  for (const row of stored) {
    assert.ok(!recoveryCodes.includes(row.code_hash), 'a recovery code was stored in plaintext');
  }

  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().enabled, true);
  assert.equal(status.json().recovery_codes_left, 10);
});

test('THE CLAIM: the password alone no longer signs in', async () => {
  const res = await login({ email: EMAIL, password: PASSWORD });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'totp_required');
  assert.ok(!res.json().access_token);
});

test('a wrong password is still just a wrong password — no hint that a factor exists', async () => {
  // Otherwise login becomes an oracle for which accounts have 2FA, and therefore
  // which ones are worth someone's time.
  const res = await login({ email: EMAIL, password: 'wrong' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, undefined);
  assert.match(res.json().error, /invalid email or password/i);
});

let spentCode = '';

test('password plus a live code signs in', async () => {
  /*
    The NEXT step's code, not this one's.

    Confirming enrolment a moment ago spent the current step, and the ±1-step
    acceptance window means the next one is already valid — so this is what "wait for
    your app to show the next code" actually looks like, not a workaround for the
    test. Reaching for the current code here fails, which is the replay rule doing
    its job on the very first login after enrolment.
  */
  spentCode = currentCode(await storedSecret(), new Date(Date.now() + 30_000));
  const res = await login({ email: EMAIL, password: PASSWORD, totp: spentCode });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().access_token);
});

test('the same code cannot be presented twice', async () => {
  // RFC 6238 §5.2. A code stays valid for the whole window, so without this anyone
  // who observes one can spend it again before it expires. Same string, second time.
  const again = await login({ email: EMAIL, password: PASSWORD, totp: spentCode });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().code, 'totp_invalid');
  assert.match(again.json().error, /already been used/i);
});

test('a recovery code works once, and only once', async () => {
  const code = recoveryCodes[0]!;

  const first = await login({ email: EMAIL, password: PASSWORD, recovery_code: code });
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.json().access_token);

  const second = await login({ email: EMAIL, password: PASSWORD, recovery_code: code });
  assert.equal(second.statusCode, 401);

  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().recovery_codes_left, 9);
});

test('recovery codes are matched without regard to case or dashes', async () => {
  // People retype these off paper. Refusing a correct code because it was typed in
  // lower case is a lockout caused by nothing.
  const code = recoveryCodes[1]!;
  const res = await login({
    email: EMAIL,
    password: PASSWORD,
    recovery_code: code.toLowerCase().replace('-', ''),
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('regenerating replaces the old set rather than adding to it', async () => {
  const stale = recoveryCodes[5]!;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/totp/recovery-codes',
    headers: auth(),
    payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const fresh: string[] = res.json().recovery_codes;
  assert.equal(fresh.length, 10);
  assert.ok(!fresh.includes(stale));

  // Somebody regenerating because they think the old list leaked must end up with the
  // old list DEAD. "Adds ten more" would be the opposite of what they asked for.
  const rejected = await login({ email: EMAIL, password: PASSWORD, recovery_code: stale });
  assert.equal(rejected.statusCode, 401);
  recoveryCodes = fresh;
});

test('turning it off needs the password AND a factor', async () => {
  const noCode = await app.inject({
    method: 'DELETE',
    url: '/api/v1/me/totp',
    headers: auth(),
    payload: { password: PASSWORD },
  });
  assert.equal(noCode.statusCode, 400);

  const noPassword = await app.inject({
    method: 'DELETE',
    url: '/api/v1/me/totp',
    headers: auth(),
    payload: { password: 'wrong', totp: currentCode(await storedSecret()) },
  });
  assert.equal(noPassword.statusCode, 403);

  // Still on after both refusals.
  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().enabled, true);
});

test('a support session cannot add or remove the factor', async () => {
  /*
    Impersonation is refused outright rather than merely stripped of a capability.
    There is no legitimate version of Nestled staff changing what protects a
    customer's account: if they are locked out, the answer is their recovery codes.
  */
  const staff = await unscopedPrisma.platform_users.create({
    data: {
      email: 'ops@nestled.chat',
      name: 'Ops',
      role: 'superadmin',
      password_hash: 'x',
    },
    select: { id: true },
  });
  const workspace = await unscopedPrisma.workspace_members.findFirstOrThrow({
    where: { user_id: userId },
    select: { workspace_id: true },
  });
  const session = await unscopedPrisma.impersonation_sessions.create({
    data: {
      platform_user_id: staff.id,
      workspace_id: workspace.workspace_id,
      target_user_id: userId,
      reason: 'test',
      scope: 'full',
      expires_at: new Date(Date.now() + 600_000),
    },
    select: { id: true },
  });

  const { signAccessToken } = await import('../auth/tokens.js');
  const impersonated = signAccessToken({
    sub: userId,
    typ: 'user',
    email: EMAIL,
    act: { pu: staff.id, sid: session.id, scope: 'full', ws: workspace.workspace_id },
  });

  for (const call of [
    { method: 'POST' as const, url: '/api/v1/me/totp' },
    { method: 'DELETE' as const, url: '/api/v1/me/totp' },
    { method: 'POST' as const, url: '/api/v1/me/totp/recovery-codes' },
  ]) {
    const res = await app.inject({
      ...call,
      headers: { authorization: `Bearer ${impersonated}` },
      payload: { password: PASSWORD, totp: '000000' },
    });
    assert.equal(res.statusCode, 403, `${call.method} ${call.url} → ${res.body}`);
    assert.equal(res.json().code, 'impersonated');
  }
});

test('a password reset does not walk past the second factor', async () => {
  /*
    The reset flow deliberately returns no session — it ends at "now sign in", which
    goes through the gate above. If it ever started issuing tokens directly, anyone
    with access to the mailbox would have a way around the factor, and the factor
    would be decorative.
  */
  const request = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email: EMAIL },
  });
  assert.equal(request.statusCode, 200);
  assert.ok(!request.json().access_token);

  const row = await unscopedPrisma.user_tokens.findFirstOrThrow({
    where: { user_id: userId, kind: 'password_reset', consumed_at: null },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  });
  assert.ok(row.id);

  const status = await app.inject({ method: 'GET', url: '/api/v1/me/two-factor', headers: auth() });
  assert.equal(status.json().enabled, true, 'a reset request must not clear the factor');
});

test('turning it off clears the secret and the recovery codes together', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/me/totp',
    headers: auth(),
    payload: { password: PASSWORD, recovery_code: recoveryCodes[0] },
  });
  assert.equal(res.statusCode, 200, res.body);

  const row = await unscopedPrisma.users.findUniqueOrThrow({
    where: { id: userId },
    select: { totp_secret: true, totp_enabled: true, totp_last_step: true },
  });
  assert.equal(row.totp_enabled, false);
  assert.equal(row.totp_secret, null);
  assert.equal(row.totp_last_step, null);

  // Leaving the codes behind would mean a later re-enrolment silently inherited a
  // list the customer believes was retired.
  assert.equal(await unscopedPrisma.user_recovery_codes.count({ where: { user_id: userId } }), 0);

  const back = await login({ email: EMAIL, password: PASSWORD });
  assert.equal(back.statusCode, 200, back.body);
});
