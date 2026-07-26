import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { invalidateWorkspaceCache } from '../plugins/auth.js';
import { clearUsageCache, usageState, SOFT_LIMIT_CUTOFF, USAGE_METRICS } from '../lib/limits.js';
import { setStripeForTests, type StripeLike } from '../services/billing/stripe.js';
import { widgetEntitlement } from '../services/billing/entitlement.js';

/**
 * The billing HTTP surface.
 *
 * Two modes are exercised deliberately, because they are two different products:
 *
 *   SELF-HOSTED, no Stripe. Plans, limits, usage and plan changes are database
 *   facts and must all work. Only checkout and the portal answer 503, and they say
 *   what to set. A self-hoster who never signs up for Stripe still gets nestled.
 *
 *   HOSTED, with a fake Stripe. The double is a plain object implementing the six
 *   calls services/billing/stripe.ts declares, which lets the tests assert on the
 *   exact parameters we send — seat quantity, trial carry-over, automatic tax and
 *   the workspace id on both `client_reference_id` and `metadata`. Those are the
 *   fields that are wrong silently: a checkout missing `metadata.workspace_id`
 *   works perfectly right up until the webhook cannot find the tenant.
 */

let app: FastifyInstance;
let ownerToken: string;
let workspaceId: string;
let websiteKey: string;

const PASSWORD = 'correct horse battery';

/** Every call the fake made, so a test can assert on what we sent Stripe. */
interface Recorder {
  customers: Record<string, unknown>[];
  checkout: Record<string, unknown>[];
  portal: Record<string, unknown>[];
  subscriptionUpdates: [string, Record<string, unknown>][];
}
let recorded: Recorder;

function freshRecorder(): Recorder {
  return { customers: [], checkout: [], portal: [], subscriptionUpdates: [] };
}

function fakeStripe(rec: Recorder): StripeLike {
  return {
    customers: {
      create: async (params) => {
        rec.customers.push(params);
        return { id: `cus_fake_${rec.customers.length}` };
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          rec.checkout.push(params);
          return { id: 'cs_fake_1', url: 'https://checkout.stripe.test/session' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          rec.portal.push(params);
          return { url: 'https://portal.stripe.test/session' };
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => ({ id, items: { data: [{ id: 'si_fake' }] } }),
      update: async (id, params) => {
        rec.subscriptionUpdates.push([id, params]);
        return { id, items: { data: [{ id: 'si_fake' }] } };
      },
    },
    webhooks: {
      // The route is what is under test here, not Stripe's HMAC. The double accepts
      // one magic header and rejects everything else, which is exactly the branch
      // the route cares about.
      constructEvent: (payload, header) => {
        if (header !== 'good-signature') throw new Error('bad signature');
        return JSON.parse(payload.toString());
      },
    },
  };
}

const auth = () => ({ authorization: `Bearer ${ownerToken}` });

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, stripe_events CASCADE');
  // `plans` is seeded by migration and survives the truncate, so the fixture plan
  // this suite adds has to be cleared by hand or a second run collides with itself.
  await unscopedPrisma.plans.deleteMany({ where: { code: 'legacy_enterprise' } });

  // Give the catalog Stripe price ids, so "the public catalog leaks no price ids" is
  // testing something rather than passing on absence.
  await unscopedPrisma.plans.updateMany({
    where: { code: 'pro' },
    data: {
      stripe_product_id: 'prod_test_pro',
      stripe_price_monthly_id: 'price_test_pro_monthly',
      stripe_price_yearly_id: 'price_test_pro_yearly',
    },
  });
  await unscopedPrisma.plans.updateMany({
    where: { code: 'starter' },
    data: { stripe_price_monthly_id: 'price_test_starter_monthly' },
  });

  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspace_name: 'Acme' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  ownerToken = signup.json().access_token;
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });

  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth() });
  workspaceId = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: auth(),
    payload: { name: 'Acme Storefront', primary_domain: 'acme.com' },
  });
  websiteKey = site.json().website.public_key;

  recorded = freshRecorder();
});

after(async () => {
  setStripeForTests(undefined);
  // `plans` outlives the truncate, so the price ids this suite invented are cleared
  // rather than left for the next file to trip over.
  await unscopedPrisma.plans.updateMany({
    where: { code: { in: ['pro', 'starter'] } },
    data: { stripe_product_id: null, stripe_price_monthly_id: null, stripe_price_yearly_id: null },
  });
  await unscopedPrisma.plans.deleteMany({ where: { code: 'legacy_enterprise' } });
  await app.close();
  await unscopedPrisma.$disconnect();
});

/** Put the workspace on a named plan without going through billing. */
async function forcePlan(code: string): Promise<void> {
  const plan = await unscopedPrisma.plans.findUniqueOrThrow({ where: { code } });
  await unscopedPrisma.workspaces.update({ where: { id: workspaceId }, data: { plan_id: plan.id } });
  invalidateWorkspaceCache(workspaceId);
}

async function setCounter(metric: string, value: number): Promise<void> {
  const period = metric === 'storage_bytes' ? new Date(0) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  await unscopedPrisma.usage_counters.upsert({
    where: { workspace_id_metric_period_start: { workspace_id: workspaceId, metric, period_start: period } },
    create: { workspace_id: workspaceId, metric, period_start: period, value: BigInt(value) },
    update: { value: BigInt(value) },
  });
  clearUsageCache();
}

// ── The public catalog ───────────────────────────────────────────────────────

test('GET /api/v1/plans is public and publishes nothing Stripe-shaped', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/plans' });
  assert.equal(res.statusCode, 200, res.body);

  const body = res.body;
  assert.ok(!body.includes('sk_'), 'a secret key reached the pricing page');
  assert.ok(!body.includes('whsec_'), 'a webhook secret reached the pricing page');
  assert.ok(!body.includes('price_test_'), 'a Stripe price id reached the pricing page');
  assert.ok(!body.includes('prod_test_'), 'a Stripe product id reached the pricing page');
  assert.ok(!body.includes('stripe_price'), 'a Stripe price field reached the pricing page');

  const plans = res.json().plans as Record<string, unknown>[];
  assert.deepEqual(plans.map((p) => p.code), ['free', 'starter', 'pro', 'business']);
  // The client picks a plan by code, so the primary key has no reason to travel.
  assert.equal(plans[0]!.id, undefined, 'internal ids must not be published either');
  assert.equal((plans[2] as { limits: { seats: number } }).limits.seats, 10);
  assert.equal((plans[2] as { features: { bot: boolean } }).features.bot, true);
});

test('a non-public plan stays out of the catalog', async () => {
  await unscopedPrisma.plans.create({
    data: { code: 'legacy_enterprise', name: 'Legacy', is_public: false, sort_order: 99 },
  });
  const res = await app.inject({ method: 'GET', url: '/api/v1/plans' });
  assert.ok(!res.body.includes('legacy_enterprise'));

  // And it cannot be bought by naming it directly, which is the other half.
  const buy = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'legacy_enterprise' },
  });
  assert.equal(buy.statusCode, 404, buy.body);
});

// ── Self-hosted: no Stripe ───────────────────────────────────────────────────

test('with no Stripe, checkout and portal 503 and say what to set', async () => {
  setStripeForTests(null);

  const checkout = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/checkout`,
    headers: auth(),
    payload: { plan_code: 'pro', interval: 'month' },
  });
  assert.equal(checkout.statusCode, 503, checkout.body);
  assert.equal(checkout.json().code, 'stripe_unconfigured');
  assert.match(checkout.json().error, /STRIPE_SECRET_KEY/);

  const portal = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/portal`,
    headers: auth(),
  });
  assert.equal(portal.statusCode, 503, portal.body);
});

test('with no Stripe, everything else still works', async () => {
  setStripeForTests(null);

  const plans = await app.inject({ method: 'GET', url: '/api/v1/plans' });
  assert.equal(plans.statusCode, 200);

  const billing = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/billing`,
    headers: auth(),
  });
  assert.equal(billing.statusCode, 200, billing.body);
  const body = billing.json();
  assert.equal(body.stripe.configured, false);
  assert.equal(body.plan.code, 'pro', 'the trial plan is still a real plan');
  assert.equal(body.seats.used, 1);
  assert.equal(body.seats.allowed, 10);
  assert.equal(body.usage.length, USAGE_METRICS.length, 'every metered counter is reported');
  assert.ok(body.resources.some((r: { resource: string }) => r.resource === 'websites'));

  // A plan change with no Stripe subscription is a local write — the only way a
  // self-hosted install can ever move between plans.
  const change = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'business', interval: 'month' },
  });
  assert.equal(change.statusCode, 200, change.body);
  assert.equal(change.json().via, 'local');
  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { plan: { select: { code: true } } },
  });
  assert.equal(ws.plan.code, 'business');

  await forcePlan('pro');
});

// ── Hosted: a faked Stripe ───────────────────────────────────────────────────

test('checkout sends the workspace id, the seat count, the trial and automatic tax', async () => {
  recorded = freshRecorder();
  setStripeForTests(fakeStripe(recorded));
  await forcePlan('pro');

  // Two pending invites plus the owner: three seats, and the invoice must say three.
  for (const email of ['bob@example.com', 'cai@example.com']) {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/w/${workspaceId}/invites`,
      headers: auth(),
      payload: { email, role: 'agent' },
    });
    assert.equal(invite.statusCode, 201, invite.body);
  }

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/checkout`,
    headers: auth(),
    payload: { plan_code: 'pro', interval: 'month' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().url, 'https://checkout.stripe.test/session');

  const params = recorded.checkout[0]!;
  assert.equal(params.mode, 'subscription');
  assert.equal(params.client_reference_id, workspaceId);
  assert.equal((params.metadata as Record<string, string>).workspace_id, workspaceId);
  assert.deepEqual(params.line_items, [{ price: 'price_test_pro_monthly', quantity: 3 }]);
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.deepEqual(params.customer_update, { address: 'auto' });

  // The card-free trial is carried into the subscription rather than restarted or
  // dropped: subscribing on day 3 must not cost the customer the other 11 days.
  const subData = params.subscription_data as Record<string, unknown>;
  assert.ok(typeof subData.trial_end === 'number', 'the remaining trial must be carried over');
  const daysOut = ((subData.trial_end as number) * 1000 - Date.now()) / 86_400_000;
  assert.ok(daysOut > 13 && daysOut < 15, `trial_end was ${daysOut} days out`);
  assert.equal((subData.metadata as Record<string, string>).workspace_id, workspaceId);

  // The Customer was created lazily, on first need, exactly as the card-free trial
  // design intends — and stored, so the next call reuses it.
  assert.equal(recorded.customers.length, 1);
  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(ws.stripe_customer_id, 'cus_fake_1');
});

test('a trial with under 48 hours left converts now instead of being rejected by Stripe', async () => {
  recorded = freshRecorder();
  setStripeForTests(fakeStripe(recorded));
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: { trial_ends_at: new Date(Date.now() + 3600_000) },
  });
  invalidateWorkspaceCache(workspaceId);

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/checkout`,
    headers: auth(),
    payload: { plan_code: 'pro' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const subData = recorded.checkout[0]!.subscription_data as Record<string, unknown>;
  assert.equal(subData.trial_end, undefined, 'Stripe rejects a trial_end inside its 48h floor');

  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: { trial_ends_at: new Date(Date.now() + 14 * 864e5) },
  });
  invalidateWorkspaceCache(workspaceId);
});

test('checkout refuses a plan that has no price configured in Stripe', async () => {
  setStripeForTests(fakeStripe(freshRecorder()));
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/checkout`,
    headers: auth(),
    payload: { plan_code: 'starter', interval: 'year' },
  });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'price_missing');
});

test('the portal is a redirect to Stripe, not a screen we rebuilt', async () => {
  recorded = freshRecorder();
  setStripeForTests(fakeStripe(recorded));
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/portal`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().url, 'https://portal.stripe.test/session');
  assert.equal(recorded.portal[0]!.customer, 'cus_fake_1', 'the existing customer is reused');
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('billing:manage is required to spend money; billing:read is not enough', async () => {
  setStripeForTests(fakeStripe(freshRecorder()));

  const invite = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/invites`,
    headers: auth(),
    payload: { email: 'admin@example.com', role: 'admin' },
  });
  const url = invite.json().invite_url as string;
  const token = url.slice(url.lastIndexOf('/') + 1);
  const accept = await app.inject({
    method: 'POST',
    url: `/api/v1/invites/${token}/accept`,
    payload: { name: 'Admin', password: PASSWORD },
  });
  assert.equal(accept.statusCode, 200, accept.body);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'admin@example.com', password: PASSWORD },
  });
  const adminToken = login.json().access_token as string;
  const adminAuth = { authorization: `Bearer ${adminToken}` };

  const read = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/billing`,
    headers: adminAuth,
  });
  assert.equal(read.statusCode, 200, 'an admin may see the bill');

  const spend = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/checkout`,
    headers: adminAuth,
    payload: { plan_code: 'pro' },
  });
  assert.equal(spend.statusCode, 403, 'only an owner may commit the company to a plan');
});

// ── Limits ───────────────────────────────────────────────────────────────────

test('every metered metric is hard at 100%, except conversations which warns', async () => {
  // Asserted against usageState directly, so each metric's rule is pinned
  // independently of whichever route happens to enforce it today.
  for (const metric of USAGE_METRICS) {
    await setCounter(metric, 10);
    const soft = metric === 'conversations';

    const under = await usageState(workspaceId, metric, 20, { soft });
    assert.equal(under.state, 'ok', `${metric} under its limit`);

    const at = await usageState(workspaceId, metric, 10, { soft });
    assert.equal(at.state, soft ? 'soft' : 'hard', `${metric} exactly at its limit`);
    assert.equal(at.ratio, 1);

    const over = await usageState(workspaceId, metric, 10 / SOFT_LIMIT_CUTOFF, { soft });
    assert.equal(over.state, 'hard', `${metric} past the soft cutoff`);

    // 0 is how a plan row spells "unlimited"; every metric must honour it, or a
    // business-tier customer gets a 402 on a plan that promised no cap.
    const unlimited = await usageState(workspaceId, metric, 0, { soft });
    assert.equal(unlimited.state, 'ok');
    assert.equal(unlimited.unlimited, true);

    await setCounter(metric, 0);
  }
});

test('the soft conversation path keeps serving at 100% and stops at 120%', async () => {
  // The product-level version of the rule above, through the real widget plane: at
  // 100% a visitor's conversation is still created, and only at 120% does the widget
  // fall back to collecting an email instead of failing.
  await forcePlan('free'); // 100 conversations a month
  const startSession = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/session',
      payload: { key: websiteKey, href: 'https://acme.com/' },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().session_token as string;
  };

  await setCounter('conversations', 100);
  const atLimit = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: await startSession() },
  });
  assert.equal(atLimit.statusCode, 201, 'a lead at exactly 100% is still a lead');

  await setCounter('conversations', 120);
  const overCutoff = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: await startSession() },
  });
  assert.equal(overCutoff.statusCode, 402, overCutoff.body);
  assert.equal(overCutoff.json().fallback, 'collect_email');

  // And the billing page reports the same two states from the same module.
  await setCounter('conversations', 100);
  let billing = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/billing`,
    headers: auth(),
  });
  let conv = billing.json().usage.find((u: { metric: string }) => u.metric === 'conversations');
  assert.equal(conv.state, 'soft');
  assert.equal(conv.soft, true);

  await setCounter('conversations', 130);
  billing = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/billing`,
    headers: auth(),
  });
  conv = billing.json().usage.find((u: { metric: string }) => u.metric === 'conversations');
  assert.equal(conv.state, 'hard');

  await setCounter('conversations', 0);
  await forcePlan('pro');
});

// ── Downgrade ────────────────────────────────────────────────────────────────

test('a downgrade returns 409 with the specifics, and confirm deactivates rather than deletes', async () => {
  setStripeForTests(null);
  await forcePlan('business'); // 25 websites, 5000 kb entries, 200 triggers

  // Three websites and three KB entries — free allows one website and 25 entries,
  // so websites are the interesting blocker.
  for (const name of ['Second', 'Third']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/w/${workspaceId}/websites`,
      headers: auth(),
      payload: { name },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
  for (let i = 0; i < 2; i++) {
    await app.inject({
      method: 'POST',
      url: `/api/v1/w/${workspaceId}/kb`,
      headers: auth(),
      payload: { question: `Q${i}`, answer: 'A' },
    });
  }

  const blocked = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'free' },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  const body = blocked.json();
  assert.equal(body.code, 'downgrade_blocked');

  const websites = body.blockers.find((b: { resource: string }) => b.resource === 'websites');
  assert.ok(websites, 'the response must name the resource');
  assert.equal(websites.used, 3);
  assert.equal(websites.limit, 1);
  assert.equal(websites.surplus, 2);
  assert.equal(websites.items.length, 2, 'and the exact rows that would go');
  // Newest first: the first website created is the one the customer keeps.
  assert.deepEqual(
    websites.items.map((i: { label: string }) => i.label),
    ['Third', 'Second'],
  );

  // Seats are a manual blocker: three seats against free's one, and no amount of
  // confirming will suspend a colleague on the customer's behalf.
  const seats = body.blockers.find((b: { resource: string }) => b.resource === 'seats');
  assert.ok(seats, 'seat overage must be reported');
  assert.equal(seats.manual, true);
  assert.equal(body.needs_confirmation, false, 'confirming alone cannot clear a manual blocker');

  const stillBlocked = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'free', confirm: true },
  });
  assert.equal(stillBlocked.statusCode, 409, 'people are not deactivated automatically');

  // Clear the seats the way the customer would, then confirm.
  await unscopedPrisma.invites.updateMany({
    where: { workspace_id: workspaceId },
    data: { revoked_at: new Date() },
  });
  await unscopedPrisma.workspace_members.deleteMany({
    where: { workspace_id: workspaceId, role: { not: 'owner' } },
  });

  const websitesBefore = await unscopedPrisma.websites.count({ where: { workspace_id: workspaceId } });
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'free', confirm: true },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().deactivated.websites.length, 2);

  // NOTHING was deleted. The rows are all still there, just switched off, so
  // upgrading again tomorrow is a single UPDATE rather than a restore.
  assert.equal(
    await unscopedPrisma.websites.count({ where: { workspace_id: workspaceId } }),
    websitesBefore,
    'a downgrade must never delete a customer resource',
  );
  const active = await unscopedPrisma.websites.findMany({
    where: { workspace_id: workspaceId, is_active: true },
    select: { name: true },
  });
  assert.deepEqual(active.map((w) => w.name), ['Acme Storefront'], 'the oldest website survives');

  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { plan: { select: { code: true } } },
  });
  assert.equal(ws.plan.code, 'free');
});

test('an upgrade never asks for confirmation', async () => {
  setStripeForTests(null);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/billing/plan`,
    headers: auth(),
    payload: { plan_code: 'business' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().changed, true);
});

// ── The webhook route ────────────────────────────────────────────────────────

test('the webhook verifies the raw body and leaves every other route parsing JSON', async () => {
  setStripeForTests(fakeStripe(freshRecorder()));
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE stripe_events');

  const event = {
    id: 'evt_http_1',
    type: 'customer.subscription.created',
    created: 9_000,
    data: {
      object: {
        id: 'sub_http_1',
        customer: 'cus_fake_1',
        status: 'active',
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        metadata: { workspace_id: workspaceId, plan_code: 'pro', interval: 'month' },
        items: { data: [{ id: 'si_http', quantity: 1, price: { id: 'price_test_pro_monthly' } }] },
      },
    },
  };

  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'forged' },
    payload: JSON.stringify(event),
  });
  assert.equal(bad.statusCode, 400, 'an unsigned body is not a Stripe event');

  const missing = await app.inject({
    method: 'POST',
    url: '/api/v1/stripe/webhook',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(event),
  });
  assert.equal(missing.statusCode, 400);

  const good = await app.inject({
    method: 'POST',
    url: '/api/v1/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'good-signature' },
    payload: JSON.stringify(event),
  });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().result, 'processed');

  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'good-signature' },
    payload: JSON.stringify(event),
  });
  assert.equal(replay.json().result, 'duplicate');

  // The parser is scoped to that one route. If it had been registered globally,
  // this next request would arrive as a Buffer and the handler would 400 on a body
  // it could not read — which is the whole reason the scope exists.
  const stillJson = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/kb`,
    headers: { ...auth(), 'content-type': 'application/json' },
    payload: { question: 'Does JSON still parse?', answer: 'Yes' },
  });
  assert.equal(stillJson.statusCode, 201, stillJson.body);
});

// ── Entitlement, as a pure function ──────────────────────────────────────────

test('widgetEntitlement never breaks a live site before grace runs out', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const future = new Date('2026-06-08T00:00:00Z');
  const past = new Date('2026-05-25T00:00:00Z');

  for (const status of ['trialing', 'active']) {
    const e = widgetEntitlement({ subscription_status: status, grace_until: null }, now);
    assert.equal(e.widget, true);
    assert.equal(e.panelWritable, true);
  }

  for (const status of ['trial_expired', 'past_due', 'unpaid', 'canceled']) {
    const inGrace = widgetEntitlement({ subscription_status: status, grace_until: future }, now);
    assert.equal(inGrace.widget, true, `${status} keeps serving during grace`);
    assert.equal(inGrace.panelWritable, false, `${status} makes the panel read-only`);
    assert.equal(inGrace.reason, 'in_grace');

    const expired = widgetEntitlement({ subscription_status: status, grace_until: past }, now);
    assert.equal(expired.widget, false, `${status} goes dark after grace`);
    assert.equal(expired.reason, 'grace_expired');

    // No grace window at all is the same as one that has run out — a workspace
    // whose status was set by hand must not be treated as entitled forever.
    assert.equal(widgetEntitlement({ subscription_status: status, grace_until: null }, now).widget, false);
  }

  // Suspension is a staff action against abuse, so it bites immediately.
  const suspended = widgetEntitlement({ subscription_status: 'suspended', grace_until: future }, now);
  assert.equal(suspended.widget, false);
  assert.equal(suspended.reason, 'suspended');
});
