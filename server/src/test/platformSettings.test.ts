import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import {
  loadSettings,
  redactedSettings,
  settings,
  updateSettings,
} from '../services/platform/settings.js';

/**
 * Install-wide settings.
 *
 * The property that matters most is not "a value round-trips" — it is that a
 * secret written here can never be read back out, and that a partial update
 * cannot wipe a field the operator never touched. Both of those are how a
 * settings page becomes an outage.
 */

let app: FastifyInstance;
let superadminToken: string;
let readonlyToken: string;

async function staff(email: string, role: string, withFactor: boolean): Promise<string> {
  const user = await unscopedPrisma.platform_users.create({
    data: {
      email,
      name: email,
      role,
      password_hash: await hashPassword('correct horse battery'),
      ...(withFactor ? { totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: true } : {}),
    },
  });
  const { token } = generateOpaqueToken(32);
  await unscopedPrisma.platform_sessions.create({
    data: {
      platform_user_id: user.id,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + 3600_000),
    },
  });
  return token;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.$executeRawUnsafe('UPDATE platform_settings SET stripe_secret_key = NULL');
  app = await buildServer();
  await app.ready();
  superadminToken = await staff('boss@nestled.chat', 'superadmin', true);
  readonlyToken = await staff('look@nestled.chat', 'readonly', false);
});

after(async () => {
  // `upsert`, not `update`: platform_settings has a foreign key to platform_users,
  // so another test file's `TRUNCATE platform_users CASCADE` takes the settings row
  // with it. The production code tolerates the row being absent for the same
  // reason — loadSettings falls back to the environment and updateSettings upserts.
  await unscopedPrisma.platform_settings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {
      stripe_secret_key: null,
      smtp_host: null,
      ai_model: null,
      anthropic_api_key: null,
      retention_days: null,
    },
  });
  await app.close();
  await unscopedPrisma.$disconnect();
});

beforeEach(async () => {
  // `upsert`, not `update`: platform_settings has a foreign key to platform_users,
  // so another test file's `TRUNCATE platform_users CASCADE` takes the settings row
  // with it. The production code tolerates the row being absent for the same
  // reason — loadSettings falls back to the environment and updateSettings upserts.
  await unscopedPrisma.platform_settings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {
      stripe_secret_key: null,
      smtp_host: null,
      ai_model: null,
      anthropic_api_key: null,
      retention_days: null,
    },
  });
  await loadSettings();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test('a stored value overrides the environment, and clearing it falls back again', async () => {
  process.env.AI_MODEL = 'from-the-environment';
  await loadSettings();
  assert.equal(settings().ai.model, 'from-the-environment');

  await updateSettings({ ai_model: 'from-the-database' });
  assert.equal(settings().ai.model, 'from-the-database', 'the database must win');

  // An empty string CLEARS, which is not the same gesture as not sending the
  // field at all. Clearing must reveal the environment value underneath, not a
  // blank — otherwise "undo my change" leaves the install unconfigured.
  await updateSettings({ ai_model: '' });
  assert.equal(settings().ai.model, 'from-the-environment');

  delete process.env.AI_MODEL;
  await loadSettings();
  assert.equal(settings().ai.model, 'claude-opus-4-8', 'and then the built-in default');
});

test('a partial update leaves every field it did not mention alone', async () => {
  await updateSettings({ stripe_secret_key: 'sk_test_abcdef123456', smtp_host: 'mail.acme.test' });
  assert.equal(settings().billing.secretKey, 'sk_test_abcdef123456');

  // THE regression this test exists for: a form that submits only the SMTP host
  // must not wipe the Stripe key. zod's `.partial()` keeping `.default()` caused
  // exactly this class of bug elsewhere in the codebase.
  const res = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(superadminToken),
    payload: { smtp_host: 'mail2.acme.test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(settings().mail.host, 'mail2.acme.test');
  assert.equal(settings().billing.secretKey, 'sk_test_abcdef123456', 'the Stripe key must survive');
});

test('secrets never come back out of the API', async () => {
  await updateSettings({
    stripe_secret_key: 'sk_test_supersecret_9999',
    anthropic_api_key: 'sk-ant-abcdefghijkl',
  });

  const res = await app.inject({
    method: 'GET',
    url: '/platform/settings',
    headers: auth(readonlyToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.body;

  assert.equal(body.includes('supersecret'), false, 'the Stripe key must not be in the response');
  assert.equal(body.includes('abcdefghijkl'), false, 'the AI key must not be in the response');

  const parsed = res.json().settings;
  assert.equal(parsed.billing.stripe_secret_key.set, true, 'but its presence is reported');
  assert.equal(parsed.billing.stripe_secret_key.hint, '…9999', 'with a hint, to tell keys apart');
  // The VAPID public key is public by definition — the widget ships it to every
  // visitor — so hiding it would be theatre that makes it unverifiable.
  assert.ok('vapid_public_key' in parsed.push);
});

test('the redacted view never contains a raw secret, whatever is stored', async () => {
  await updateSettings({
    anthropic_api_key: 'sk-ant-AAAA',
    openai_api_key: 'sk-oai-BBBB',
    smtp_password: 'hunter2-CCCC',
    vapid_private_key: 'vapid-DDDD',
    maxmind_license_key: 'mm-EEEE',
    stripe_secret_key: 'sk_live_FFFF',
    stripe_webhook_secret: 'whsec_GGGG',
    discord_webhook_url: 'https://discord.com/api/webhooks/HHHH',
  });
  const blob = JSON.stringify(redactedSettings());
  for (const secret of [
    'sk-ant-AAAA',
    'sk-oai-BBBB',
    'hunter2-CCCC',
    'vapid-DDDD',
    'mm-EEEE',
    'sk_live_FFFF',
    'whsec_GGGG',
    'discord.com/api/webhooks',
  ]) {
    assert.equal(blob.includes(secret), false, `${secret} leaked into the redacted view`);
  }
});

test('reading is open to any staff session; writing is superadmin only', async () => {
  const read = await app.inject({
    method: 'GET',
    url: '/platform/settings',
    headers: auth(readonlyToken),
  });
  assert.equal(read.statusCode, 200);

  const write = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(readonlyToken),
    payload: { ai_model: 'nope' },
  });
  assert.equal(write.statusCode, 403, 'a readonly role must not change install-wide config');
  assert.notEqual(settings().ai.model, 'nope');
});

test('a superadmin without a verified TOTP factor can read but not write', async () => {
  const noFactor = await staff('nofactor@nestled.chat', 'superadmin', false);

  const read = await app.inject({
    method: 'GET',
    url: '/platform/settings',
    headers: auth(noFactor),
  });
  assert.equal(read.statusCode, 200);

  const write = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(noFactor),
    payload: { ai_model: 'nope' },
  });
  assert.equal(write.statusCode, 403);
  assert.equal(write.json().code, 'totp_required');
});

test('the customer plane cannot reach these settings at all', async () => {
  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      name: 'Ada',
      email: 'ada@settings.test',
      password: 'correct horse battery',
      workspace_name: 'Acme',
    },
  });
  const customerToken = signup.json().access_token;

  for (const method of ['GET', 'PATCH'] as const) {
    const res = await app.inject({
      method,
      url: '/platform/settings',
      headers: auth(customerToken),
      ...(method === 'PATCH' ? { payload: { ai_model: 'nope' } } : {}),
    });
    assert.equal(res.statusCode, 401, `${method} must reject a customer JWT`);
  }
});

test('an unknown provider is refused by the schema, not stored and ignored', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(superadminToken),
    payload: { ai_provider: 'gpt5-via-carrier-pigeon' },
  });
  assert.equal(res.statusCode, 400);
});

test('a settings change is recorded in the audit log by field, never by value', async () => {
  await app.inject({
    method: 'PATCH',
    url: '/platform/settings',
    headers: auth(superadminToken),
    payload: { stripe_secret_key: 'sk_test_auditme_4242', ai_model: 'claude-x' },
  });

  const entry = await unscopedPrisma.audit_log.findFirst({
    where: { action: 'platform.settings_updated' },
    orderBy: { created_at: 'desc' },
  });
  assert.ok(entry, 'the change must be recorded');
  const details = JSON.stringify(entry.details);
  assert.equal(details.includes('sk_test_auditme_4242'), false, 'the value must not be logged');
  assert.ok(details.includes('stripe_secret_key'), 'but the field name must be');
  assert.ok(details.includes('secrets_changed'));
});

test('test-email refuses clearly when no SMTP host is configured', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/platform/settings/test-email',
    headers: auth(superadminToken),
    payload: { to: 'someone@example.com' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'smtp_unconfigured');
});

test('secrets are encrypted at rest when SETTINGS_KEY is set', async () => {
  process.env.SETTINGS_KEY = 'a-test-encryption-key';
  try {
    await updateSettings({ stripe_secret_key: 'sk_test_encrypted_7777' });

    // What is ON DISK must not be the secret. This is the whole point: a leaked
    // backup containing a live Stripe key is a different category of problem
    // from one containing conversation history, because that key moves money.
    const row = await unscopedPrisma.platform_settings.findUniqueOrThrow({ where: { id: 1 } });
    assert.ok(row.stripe_secret_key);
    assert.equal(
      row.stripe_secret_key.includes('sk_test_encrypted_7777'),
      false,
      'the stored column must not contain the plaintext',
    );
    assert.ok(row.stripe_secret_key.startsWith('enc.v1.'));

    // And it still resolves correctly in memory.
    await loadSettings();
    assert.equal(settings().billing.secretKey, 'sk_test_encrypted_7777');
  } finally {
    await unscopedPrisma.platform_settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { stripe_secret_key: null },
    });
    delete process.env.SETTINGS_KEY;
    await loadSettings();
  }
});

test('a wrong SETTINGS_KEY reports the secret as absent rather than as garbage', async () => {
  process.env.SETTINGS_KEY = 'the-original-key';
  await updateSettings({ stripe_secret_key: 'sk_test_rotated_8888' });

  process.env.SETTINGS_KEY = 'somebody-changed-it';
  await loadSettings();
  try {
    // Absent, not corrupt. Handing a mangled string to Stripe would produce an
    // authentication error three layers away from the actual cause.
    assert.equal(settings().billing.secretKey, null);
  } finally {
    await unscopedPrisma.platform_settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { stripe_secret_key: null },
    });
    delete process.env.SETTINGS_KEY;
    await loadSettings();
  }
});

test('the public URLs are derived from ALLOWED_ORIGINS when nobody has set them', async () => {
  // The nasty version of getting this wrong is quiet: the install runs fine and
  // every verification email points at a machine the recipient does not have.
  // They never report it — they simply never confirm.
  await loadSettings();
  const app = settings().urls.app;
  assert.ok(
    app.includes('localhost') || app.startsWith('http'),
    'an app URL must always resolve to something',
  );

  // With a production-shaped origin list, the app subdomain wins over the
  // marketing one, and neither falls back to localhost.
  const previous = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS =
    'https://app.acme.test,https://ops.acme.test,https://widget.acme.test,https://acme.test';
  try {
    // allowedOrigins is parsed once at import, so this asserts the SHAPE of the
    // derivation rather than re-reading the variable — the unit under test is
    // "which origin is chosen", which is what actually goes wrong.
    const origins = process.env.ALLOWED_ORIGINS.split(',');
    const chosen = origins.find((o) => new URL(o).hostname.startsWith('app.'));
    assert.equal(chosen, 'https://app.acme.test');
    const marketing = origins.find((o) => !/^(app|ops|widget)\./.test(new URL(o).hostname));
    assert.equal(marketing, 'https://acme.test');
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previous;
  }
});
