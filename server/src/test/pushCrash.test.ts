import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { isPushEnabled, pushKeyError, pushVisitorMessage } from '../services/push.js';
import { updateSettings } from '../services/platform/settings.js';
import { healthReport } from '../services/platform/health.js';

/**
 * The 502 this file exists to prevent.
 *
 * A visitor sent the first message in a conversation and got `502 Bad Gateway`; the widget
 * said "something went wrong". The request handler was fine. What happened was:
 *
 *   1. a malformed VAPID private key had been saved in the ops panel,
 *   2. `webpush.setVapidDetails` validates and THROWS on it,
 *   3. the sender is called as `void pushVisitorMessage(…)` — correctly, since whether an
 *      agent's phone buzzes is not part of whether the message was accepted,
 *   4. an unhandled rejection terminates the process in Node ≥15.
 *
 * So one bad settings value killed the container mid-request, taking every other
 * customer's in-flight request with it. Four things had to change, and each has a test
 * here: the key must not throw, the sender must not reject, the process must not die, and
 * the panel must refuse the value in the first place.
 */

let app: FastifyInstance;
let staffToken: string;
let workspaceId: string;
let websiteId: string;
let conversationId: string;

const SECRET = generateTotpSecret();
const PASSWORD = 'staff password long enough';

/** Correct length, correct alphabet, wrong everything else — exactly the reported shape. */
const BAD_PRIVATE_KEY = 'this-is-not-a-32-byte-key';
const GOOD_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const GOOD_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls';

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });
  await unscopedPrisma.$executeRawUnsafe('DELETE FROM platform_settings');

  app = await buildServer();
  await app.ready();

  await unscopedPrisma.platform_users.create({
    data: {
      email: 'ops@nestled.chat',
      name: 'Ops',
      role: 'superadmin',
      password_hash: await hashPassword(PASSWORD),
      totp_secret: SECRET,
      totp_enabled: true,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'ops@nestled.chat', password: PASSWORD, totp: currentCode(SECRET) },
  });
  staffToken = login.json().token;

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery', workspace_name: 'Acme' },
  });
  const token = signup.json().access_token as string;
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
  workspaceId = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Main site' },
  });
  websiteId = site.json().website.id;

  const conv = await unscopedPrisma.conversations.create({
    data: { workspace_id: workspaceId, website_id: websiteId, visitor_id: 'v-1', status: 'open' },
    select: { id: true },
  });
  conversationId = conv.id;
});

after(async () => {
  await unscopedPrisma.$executeRawUnsafe('DELETE FROM platform_settings');
  await app.close();
  await unscopedPrisma.$disconnect();
});

test('a malformed VAPID key turns push off instead of throwing', async () => {
  await updateSettings(
    { vapid_public_key: GOOD_PUBLIC_KEY, vapid_private_key: BAD_PRIVATE_KEY, vapid_subject: 'mailto:ops@nestled.chat' },
    undefined,
  );

  // The call that used to end the process. Resolving — at all — is the assertion.
  await pushVisitorMessage(workspaceId, websiteId, conversationId, 'Kaya', 'hello');

  assert.equal(isPushEnabled(), false, 'a pair that cannot be loaded is not enabled');
  assert.match(String(pushKeyError()), /32 bytes/, 'and the reason is available for the health page');
});

test('ops → Health reports it as a fault, distinctly from "not configured"', async () => {
  const report = await healthReport();
  assert.equal(report.push.configured, false);
  assert.equal(report.push.status, 'fail', 'somebody set this up expecting it to work');
  assert.match(String(report.push.key_error), /32 bytes/);
  assert.match(report.push.detail, /invalid/i);

  // Clearing the keys is the other state, and it is only a warning.
  await updateSettings({ vapid_public_key: '', vapid_private_key: '' }, undefined);
  const cleared = await healthReport();
  assert.equal(cleared.push.status, 'warn');
  assert.equal(cleared.push.key_error, null);
  assert.match(cleared.push.detail, /not configured/);
});

test('a valid pair loads, and fixing it needs no restart', async () => {
  await updateSettings(
    { vapid_public_key: GOOD_PUBLIC_KEY, vapid_private_key: GOOD_PRIVATE_KEY, vapid_subject: 'mailto:ops@nestled.chat' },
    undefined,
  );
  assert.equal(isPushEnabled(), true);
  assert.equal(pushKeyError(), null);

  // Break it and fix it again in-process: the rejected pair must not be remembered past
  // the value that caused it, or correcting the panel would need a redeploy.
  await updateSettings({ vapid_private_key: BAD_PRIVATE_KEY }, undefined);
  assert.equal(isPushEnabled(), false);
  await updateSettings({ vapid_private_key: GOOD_PRIVATE_KEY }, undefined);
  assert.equal(isPushEnabled(), true, 'correcting the key takes effect without a restart');
});

test('the ops panel refuses a key web-push will not load', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: { authorization: `Bearer ${staffToken}` },
    payload: { vapid_public_key: GOOD_PUBLIC_KEY, vapid_private_key: BAD_PRIVATE_KEY },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, 'vapid_invalid');
  assert.match(res.json().error, /32 bytes/);

  // And the refusal left the working pair in place rather than half-applying.
  assert.equal(isPushEnabled(), true);

  // Clearing both is a legitimate save — that is how push gets turned off.
  const off = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: { authorization: `Bearer ${staffToken}` },
    payload: { vapid_public_key: '', vapid_private_key: '' },
  });
  assert.equal(off.statusCode, 200, off.body);
});

/**
 * The backstop, in a child process because it is the process-level behaviour under test:
 * an unhandled rejection must be contained, not fatal.
 *
 * Without `installCrashGuard`, node exits non-zero and prints nothing after the
 * rejection. This asserts the opposite — the script reaches its last line.
 */
test('an unhandled rejection no longer takes the process down', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverRoot = join(here, '..', '..');

  const script = `
    import { installCrashGuard } from './src/lib/crashGuard.js';
    import { counter } from './src/services/platform/metrics.js';
    installCrashGuard();
    void Promise.reject(new Error('Vapid private key should be 32 bytes long when decoded.'));
    setTimeout(() => {
      console.log('SURVIVED', counter('process.unhandled_rejections'));
    }, 50);
  `;

  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: serverRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  assert.match(out, /SURVIVED 1/, `expected the process to survive and count it, got: ${out}`);
});
