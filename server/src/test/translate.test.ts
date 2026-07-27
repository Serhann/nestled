import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { invalidateWorkspaceCache } from '../plugins/auth.js';
import { checkUsageLimit, readUsage } from '../lib/usage.js';

/**
 * Live translation.
 *
 * No AI provider is configured in tests, so every call lands in the
 * `translated: false, reason: 'unavailable'` branch. That is the branch worth
 * having tests for anyway, because it is the one that must not look like success:
 * the endpoint hands back the ORIGINAL text, and an agent who is told that is a
 * translation would send a customer the wrong thing.
 *
 * The other three properties pinned here are the ones that cost money or leak:
 * the endpoint is metered, it refuses over the AI allowance without erroring, and
 * it needs `conversation:reply` in the caller's own workspace.
 */

let app: FastifyInstance;
let adaToken: string;
let bobToken: string;
let adaWs: string;

const PASSWORD = 'correct horse battery';

async function signup(name: string, email: string, workspace: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  await unscopedPrisma.users.update({ where: { email }, data: { email_verified_at: new Date() } });
  return res.json().access_token as string;
}

async function workspaceOf(token: string): Promise<string> {
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return me.json().workspaces[0].id as string;
}

function post(token: string, workspaceId: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/translate`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
}

/**
 * Put the workspace's AI allowance at a known number.
 *
 * A throwaway plan rather than an edit to `starter`: the seeded catalog is shared
 * by every other test file in the run, and moving a number on it would make this
 * file's setup somebody else's flaky failure. Fields are listed rather than spread
 * from an existing row — a read row carries nullable Json columns that the create
 * input will not take.
 */
async function setAiAllowance(workspaceId: string, max: number): Promise<void> {
  const clone = await unscopedPrisma.plans.upsert({
    where: { code: `test-ai-${max}` },
    create: {
      code: `test-ai-${max}`,
      name: `Test AI ${max}`,
      is_public: false,
      is_trial_default: false,
      max_ai_replies_month: max,
      max_seats: 10,
      max_websites: 5,
      max_conversations_month: 5000,
    },
    update: { max_ai_replies_month: max },
  });
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: { plan_id: clone.id },
  });
  invalidateWorkspaceCache(workspaceId);
}

async function setUsage(workspaceId: string, value: number): Promise<void> {
  const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  await unscopedPrisma.usage_counters.upsert({
    where: {
      workspace_id_metric_period_start: {
        workspace_id: workspaceId,
        metric: 'ai_replies',
        period_start: period,
      },
    },
    create: {
      workspace_id: workspaceId,
      metric: 'ai_replies',
      period_start: period,
      value: BigInt(value),
    },
    update: { value: BigInt(value) },
  });
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  adaToken = await signup('Ada', 'ada@example.com', 'Acme');
  bobToken = await signup('Bob', 'bob@example.com', 'Globex');
  adaWs = await workspaceOf(adaToken);
});

after(async () => {
  await app.close();
  // Workspaces first: they hold an FK to the throwaway plans, so deleting the
  // plans while a workspace still points at one is a constraint violation, not a
  // cleanup. Leaving the plans behind would leak non-public rows into every later
  // test file's plan catalog.
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { code: { startsWith: 'test-ai-' } } });
  await unscopedPrisma.$disconnect();
});

test('with no provider configured it reports failure rather than passing the original off as a translation', async () => {
  await setAiAllowance(adaWs, 500);
  await setUsage(adaWs, 0);

  const res = await post(adaToken, adaWs, { text: 'Merhaba, siparişim nerede?', to: 'English' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  // The original comes back — but flagged, which is the whole point.
  assert.equal(body.translated, false);
  assert.equal(body.reason, 'unavailable');
  assert.equal(body.text, 'Merhaba, siparişim nerede?');
});

test('a failed translation is not billed', async () => {
  await setAiAllowance(adaWs, 500);
  await setUsage(adaWs, 0);

  await post(adaToken, adaWs, { text: 'Bonjour', to: 'English' });

  // Charging a customer's AI allowance because our provider is not configured
  // would be the wrong way round.
  assert.equal(await readUsage(adaWs, 'ai_replies'), 0);
});

test('over the AI allowance it refuses without erroring, so an agent is never blocked mid-reply', async () => {
  await setAiAllowance(adaWs, 10);
  await setUsage(adaWs, 10);

  const res = await post(adaToken, adaWs, { text: 'Hola', to: 'English' });
  // 200, not 402: a plan problem of ours must not surface as a broken control while
  // the agent is answering somebody's customer.
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().translated, false);
  assert.equal(res.json().reason, 'plan_limit');
  assert.equal(res.json().text, 'Hola');
});

test('an unlimited plan (allowance 0) does not read as "nothing allowed"', async () => {
  // The regression this guards: `limit <= 0` means unlimited, but the arithmetic in
  // checkUsageLimit computed a ceiling of 0 and refused everything. An operator
  // setting a plan's AI allowance to 0 to mean "no cap" switched the assistant off.
  await setUsage(adaWs, 5_000);
  assert.equal(await checkUsageLimit(adaWs, 'ai_replies', 0), null);
  assert.notEqual(await checkUsageLimit(adaWs, 'ai_replies', 100), null);
});

test('a workspace id the caller does not belong to is refused', async () => {
  const res = await post(bobToken, adaWs, { text: 'hello', to: 'French' });
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `got ${res.statusCode}`);
});

test('an anonymous caller cannot spend a workspace’s AI allowance', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/translate`,
    payload: { text: 'hello', to: 'French' },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('the body is validated', async () => {
  await setAiAllowance(adaWs, 500);
  await setUsage(adaWs, 0);

  assert.equal((await post(adaToken, adaWs, { text: '', to: 'English' })).statusCode, 400);
  assert.equal((await post(adaToken, adaWs, { text: 'hi', to: '' })).statusCode, 400);
  assert.equal((await post(adaToken, adaWs, { text: 'hi' })).statusCode, 400);
  // 4000 characters is the ceiling; a whole transcript pasted in is not a message.
  assert.equal(
    (await post(adaToken, adaWs, { text: 'x'.repeat(4001), to: 'English' })).statusCode,
    400,
  );
});
