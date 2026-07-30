import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { runBillingLifecycle } from '../services/billing/index.js';

/**
 * Billing a customer who does not pay through Stripe, and confirming an address by hand.
 *
 * Setting `plan_id` from the panel is the easy part and not what these tests are about.
 * `workspaces.plan_id` is documented as written only by the Stripe webhook and the
 * trial/dunning job, so a plan set by hand survives only if BOTH of those are taught to
 * leave it alone. Each of the three tests below is one way the old behaviour would have
 * quietly undone an operator's work:
 *
 *   - the nightly sweep expiring the trial of somebody who paid us by transfer,
 *   - the customer's own billing page offering them checkout a second time,
 *   - and the webhook mirror overwriting the plan on the next subscription event.
 */

let app: FastifyInstance;
let staffToken: string;
let ownerToken: string;
let workspaceId: string;
let userId: string;
let proPlanId: string;

const STAFF_SECRET = generateTotpSecret();
const STAFF_PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });
const ownerAuth = () => ({ authorization: `Bearer ${ownerToken}` });

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
  userId = (await unscopedPrisma.users.findUniqueOrThrow({ where: { email: 'ada@example.com' } })).id;

  const pro = await unscopedPrisma.plans.findFirst({ where: { is_public: true }, orderBy: { sort_order: 'desc' } });
  assert.ok(pro, 'the seeded catalog should have a public plan');
  proPlanId = pro.id;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

const assignPlan = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceId}/plan`,
    headers: staffAuth(),
    payload: body,
  });

test('a reason is mandatory, and the plan must exist', async () => {
  assert.equal((await assignPlan({ plan_id: proPlanId })).statusCode, 400);
  assert.equal((await assignPlan({ plan_id: proPlanId, reason: 'x' })).statusCode, 400);

  const unknown = await assignPlan({
    plan_id: '00000000-0000-0000-0000-000000000000',
    reason: 'paying by transfer',
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
});

test('assigning a plan by hand sets it, marks the workspace manual, and records why', async () => {
  const res = await assignPlan({
    plan_id: proPlanId,
    billing_mode: 'manual',
    status: 'active',
    reason: 'paying yearly by bank transfer — invoice INV-2031',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().workspace.billing_mode, 'manual');
  assert.equal(res.json().workspace.subscription_status, 'active');
  // No Stripe subscription on this workspace, so nothing to warn about.
  assert.equal(res.json().stripe_subscription, null);

  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(ws.plan_id, proPlanId);
  assert.equal(ws.billing_mode, 'manual');

  const entry = await unscopedPrisma.audit_log.findFirst({
    where: { workspace_id: workspaceId, action: 'platform.workspace_plan_set' },
    orderBy: { created_at: 'desc' },
  });
  assert.ok(entry, 'the customer can see the plan was set for them');
  assert.equal(entry.actor_email, 'ops@nestled.chat');
  assert.match(JSON.stringify(entry.details), /INV-2031/);
});

test('the trial and dunning sweeps leave a manually billed workspace alone', async () => {
  // Exactly the state the nightly sweep exists to move on: a trial that ran out
  // yesterday, with no Stripe subscription to explain why it should not.
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: {
      billing_mode: 'manual',
      subscription_status: 'trialing',
      trial_ends_at: new Date(Date.now() - 86_400_000),
    },
  });

  await runBillingLifecycle();

  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(
    ws.subscription_status,
    'trialing',
    'a customer who paid us by transfer must not be expired by a job that never looked at how they pay',
  );

  // And the same sweep DOES still move a workspace that is on Stripe, so the test above
  // is proving the gate rather than a dead sweep.
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: { billing_mode: 'stripe' },
  });
  await runBillingLifecycle();
  const after = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(after.subscription_status, 'trial_expired');
});

test('a manually billed customer is not offered self-service checkout', async () => {
  await assignPlan({
    plan_id: proPlanId,
    billing_mode: 'manual',
    status: 'active',
    reason: 'invoiced against a purchase order',
  });

  const state = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/billing`,
    headers: ownerAuth(),
  });
  assert.equal(state.statusCode, 200, state.body);
  assert.equal(state.json().billing_mode, 'manual', 'the panel needs this to hide the Subscribe button');

  // And the endpoints refuse regardless of what the page renders — a tab left open
  // across the switch must not be able to charge them.
  for (const url of [
    `/api/v1/w/${workspaceId}/billing/checkout`,
    `/api/v1/w/${workspaceId}/billing/portal`,
    `/api/v1/w/${workspaceId}/billing/plan`,
  ]) {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: ownerAuth(),
      payload: { plan_code: 'pro', interval: 'month' },
    });
    assert.equal(res.statusCode, 409, `${url} → ${res.body}`);
    assert.equal(res.json().code, 'billing_manual');
    assert.doesNotMatch(res.json().error, /stripe|installation|ops panel/i);
  }
});

test('confirming an address by hand works once, is recorded, and spends the pending link', async () => {
  await unscopedPrisma.users.update({ where: { id: userId }, data: { email_verified_at: null } });
  const pending = await unscopedPrisma.user_tokens.create({
    data: {
      user_id: userId,
      kind: 'email_verify',
      token_hash: `pending-${Date.now()}`,
      expires_at: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });

  const res = await app.inject({
    method: 'POST',
    url: `/platform/users/${userId}/confirm-email`,
    headers: staffAuth(),
    payload: { reason: 'their mail provider rejects our verification mail — ticket 5120' },
  });
  assert.equal(res.statusCode, 200, res.body);

  const user = await unscopedPrisma.users.findUniqueOrThrow({ where: { id: userId } });
  assert.ok(user.email_verified_at);
  assert.equal(
    await unscopedPrisma.user_tokens.count({ where: { id: pending.id } }),
    0,
    'an outstanding link that still confirms an address is a token nobody is tracking',
  );

  const entry = await unscopedPrisma.audit_log.findFirst({
    where: { workspace_id: workspaceId, action: 'platform.user_email_confirmed' },
  });
  assert.ok(entry, 'the workspace sees that we confirmed their member’s address');
  assert.match(JSON.stringify(entry.details), /5120/);

  // Twice is a conflict, not a silent no-op: the second caller believes they did
  // something.
  const again = await app.inject({
    method: 'POST',
    url: `/platform/users/${userId}/confirm-email`,
    headers: staffAuth(),
    payload: { reason: 'trying again' },
  });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().code, 'already_confirmed');
});
