import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unscopedPrisma } from '../db/unscoped.js';
import { processStripeEvent } from '../services/billing/webhook.js';
import { runBillingLifecycle } from '../services/billing/lifecycle.js';
import { widgetEntitlement } from '../services/billing/entitlement.js';
import type { StripeWebhookEvent } from '../services/billing/stripe.js';

/**
 * Stripe webhook idempotency, and the nightly lifecycle sweep.
 *
 * These are the tests that matter most in billing, because every failure they
 * describe is one a human notices on an invoice weeks later rather than in a stack
 * trace. Each of the three idempotency mechanisms in services/billing/webhook.ts is
 * exercised against the ONE failure it alone prevents:
 *
 *   redelivery        → the same event twice produces exactly one effect
 *   reordering        → a late `updated` cannot resurrect a cancelled subscription
 *   arrival order     → checkout and subscription.created converge either way round
 *
 * `processStripeEvent` is called directly rather than through HTTP: the properties
 * being asserted are about rows in Postgres, and routing them through a signature
 * and a Buffer would only add ways for the test to fail for unrelated reasons. The
 * HTTP surface (raw body, signature, scoped parser) is covered in billing.test.ts.
 */

const CUSTOMER = 'cus_test_webhook';
let workspaceId: string;
let proPlanId: string;
let starterPlanId: string;

/** A workspace with no Stripe history, ready for a subscription to land on. */
async function makeWorkspace(slug: string, customerId: string | null): Promise<string> {
  const ws = await unscopedPrisma.workspaces.create({
    data: {
      name: slug,
      slug,
      plan_id: proPlanId,
      subscription_status: 'trialing',
      stripe_customer_id: customerId,
    },
    select: { id: true },
  });
  return ws.id;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, stripe_events CASCADE');
  proPlanId = (await unscopedPrisma.plans.findUniqueOrThrow({ where: { code: 'pro' } })).id;
  starterPlanId = (await unscopedPrisma.plans.findUniqueOrThrow({ where: { code: 'starter' } })).id;
  workspaceId = await makeWorkspace('acme', CUSTOMER);
});

after(async () => {
  await unscopedPrisma.$disconnect();
});

// ── Event fixtures ───────────────────────────────────────────────────────────

interface SubOptions {
  status?: string;
  planCode?: string;
  quantity?: number;
  customer?: string;
  workspaceId?: string;
  subscriptionId?: string;
}

function subscriptionEvent(
  eventId: string,
  type: string,
  createdSeconds: number,
  opts: SubOptions = {},
): StripeWebhookEvent {
  const periodStart = 1_700_000_000;
  return {
    id: eventId,
    type,
    created: createdSeconds,
    data: {
      object: {
        id: opts.subscriptionId ?? 'sub_test_1',
        customer: opts.customer ?? CUSTOMER,
        status: opts.status ?? 'active',
        cancel_at_period_end: false,
        current_period_start: periodStart,
        current_period_end: periodStart + 2_592_000,
        metadata: {
          workspace_id: opts.workspaceId ?? workspaceId,
          plan_code: opts.planCode ?? 'pro',
          interval: 'month',
        },
        items: {
          data: [
            {
              id: 'si_test_1',
              quantity: opts.quantity ?? 1,
              price: { id: 'price_pro_monthly', recurring: { interval: 'month' } },
            },
          ],
        },
      },
    },
  };
}

function checkoutEvent(
  eventId: string,
  createdSeconds: number,
  opts: { workspaceId?: string; subscriptionId?: string; planCode?: string; seats?: number } = {},
): StripeWebhookEvent {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    created: createdSeconds,
    data: {
      object: {
        id: 'cs_test_1',
        mode: 'subscription',
        client_reference_id: opts.workspaceId ?? workspaceId,
        customer: CUSTOMER,
        subscription: opts.subscriptionId ?? 'sub_test_1',
        metadata: {
          workspace_id: opts.workspaceId ?? workspaceId,
          plan_code: opts.planCode ?? 'pro',
          interval: 'month',
          seats: String(opts.seats ?? 1),
        },
      },
    },
  };
}

// ── 1. Exactly-once ──────────────────────────────────────────────────────────

test('the same event delivered twice produces exactly one effect', async () => {
  const first = subscriptionEvent('evt_dup_1', 'customer.subscription.created', 1_700_000_100, {
    quantity: 3,
  });
  assert.equal(await processStripeEvent(first), 'processed');

  // The redelivery carries a MUTATED payload under the same event id. Stripe would
  // never do that, but it is what makes this test prove the row was not reprocessed
  // rather than merely reprocessed to the same value.
  const replay = subscriptionEvent('evt_dup_1', 'customer.subscription.created', 1_700_000_100, {
    quantity: 99,
    status: 'canceled',
  });
  assert.equal(await processStripeEvent(replay), 'duplicate');

  const subs = await unscopedPrisma.subscriptions.findMany({ where: { workspace_id: workspaceId } });
  assert.equal(subs.length, 1, 'a redelivery must not create a second subscription');
  assert.equal(subs[0]!.quantity, 3, 'the redelivered payload must not have been applied');
  assert.equal(subs[0]!.status, 'active');

  const row = await unscopedPrisma.stripe_events.findUniqueOrThrow({ where: { id: 'evt_dup_1' } });
  assert.equal(row.attempts, 1);
  assert.ok(row.processed_at, 'a handled event must be marked processed');
});

test('an event recorded but never processed is re-claimed rather than dismissed', async () => {
  // This is the failure mechanism 1 would cause on its own: a handler that threw
  // left the row behind, and every Stripe retry would then be waved through as a
  // duplicate, losing the event permanently.
  await unscopedPrisma.$executeRaw`
    INSERT INTO stripe_events (id, type, payload, received_at, attempts)
    VALUES ('evt_retry_1', 'customer.subscription.updated', '{}'::jsonb, now(), 1)
  `;
  const event = subscriptionEvent('evt_retry_1', 'customer.subscription.updated', 1_700_000_200, {
    quantity: 5,
  });
  assert.equal(await processStripeEvent(event), 'processed');

  const sub = await unscopedPrisma.subscriptions.findUniqueOrThrow({ where: { workspace_id: workspaceId } });
  assert.equal(sub.quantity, 5);
  const row = await unscopedPrisma.stripe_events.findUniqueOrThrow({ where: { id: 'evt_retry_1' } });
  assert.equal(row.attempts, 2, 'the re-claim must be visible in the attempt count');
});

// ── 2. Out-of-order ──────────────────────────────────────────────────────────

test('an older customer.subscription.updated cannot resurrect a cancelled subscription', async () => {
  const ws = await makeWorkspace('reorder', 'cus_reorder');
  const opts = { customer: 'cus_reorder', workspaceId: ws, subscriptionId: 'sub_reorder' };

  await processStripeEvent(
    subscriptionEvent('evt_ro_created', 'customer.subscription.created', 2_000, { ...opts }),
  );
  await processStripeEvent(
    subscriptionEvent('evt_ro_deleted', 'customer.subscription.deleted', 3_000, {
      ...opts,
      status: 'canceled',
    }),
  );

  const cancelled = await unscopedPrisma.subscriptions.findUniqueOrThrow({ where: { workspace_id: ws } });
  assert.equal(cancelled.status, 'canceled');

  // Delivered LAST, but created BEFORE the cancellation. Stripe reorders under
  // retry; without the guard this would hand the customer a free subscription and
  // clear the purge date on a workspace that has already left.
  const result = await processStripeEvent(
    subscriptionEvent('evt_ro_stale', 'customer.subscription.updated', 2_500, {
      ...opts,
      status: 'active',
    }),
  );
  assert.equal(result, 'ignored', 'a stale event must be recorded and dropped, not applied');

  const after_ = await unscopedPrisma.subscriptions.findUniqueOrThrow({ where: { workspace_id: ws } });
  assert.equal(after_.status, 'canceled', 'the cancellation must survive a late update');

  const workspace = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws } });
  assert.equal(workspace.subscription_status, 'canceled');
  assert.ok(workspace.purge_after, 'a cancellation must schedule a purge');
  assert.ok(workspace.grace_until, 'the widget keeps serving through grace after a cancellation');
});

test('a cancellation schedules a purge instead of deleting anything', async () => {
  const ws = await unscopedPrisma.workspaces.findFirstOrThrow({ where: { slug: 'reorder' } });
  assert.equal(ws.deleted_at, null, 'webhooks never delete customer data');
  const roughlyThirtyDays = (ws.purge_after!.getTime() - Date.now()) / 86_400_000;
  assert.ok(roughlyThirtyDays > 29 && roughlyThirtyDays < 31, `purge_after was ${roughlyThirtyDays} days out`);
  // And the widget is still up, which is the whole point of the grace window.
  assert.equal(widgetEntitlement(ws).widget, true);
});

// ── 3. Arrival-order independence ────────────────────────────────────────────

test('checkout.session.completed and customer.subscription.created converge in both orders', async () => {
  const wsA = await makeWorkspace('order-a', 'cus_order_a');
  const wsB = await makeWorkspace('order-b', 'cus_order_b');

  const at = 5_000;
  const forA = { customer: 'cus_order_a', workspaceId: wsA, subscriptionId: 'sub_order_a' };
  const forB = { customer: 'cus_order_b', workspaceId: wsB, subscriptionId: 'sub_order_b' };

  // A: checkout first.
  await processStripeEvent(
    checkoutEvent('evt_a_checkout', at, { workspaceId: wsA, subscriptionId: 'sub_order_a', seats: 4 }),
  );
  await processStripeEvent(
    subscriptionEvent('evt_a_created', 'customer.subscription.created', at, { ...forA, quantity: 4 }),
  );

  // B: subscription first.
  await processStripeEvent(
    subscriptionEvent('evt_b_created', 'customer.subscription.created', at, { ...forB, quantity: 4 }),
  );
  await processStripeEvent(
    checkoutEvent('evt_b_checkout', at, { workspaceId: wsB, subscriptionId: 'sub_order_b', seats: 4 }),
  );

  const a = await unscopedPrisma.subscriptions.findUniqueOrThrow({ where: { workspace_id: wsA } });
  const b = await unscopedPrisma.subscriptions.findUniqueOrThrow({ where: { workspace_id: wsB } });

  const comparable = (s: typeof a) => ({
    plan_id: s.plan_id,
    status: s.status,
    interval: s.interval,
    quantity: s.quantity,
    item: s.stripe_item_id,
    period_start: s.current_period_start.toISOString(),
    period_end: s.current_period_end.toISOString(),
    cancel_at_period_end: s.cancel_at_period_end,
  });
  assert.deepEqual(comparable(a), comparable(b), 'arrival order must not change the resulting row');
  // Specifically: the placeholder period the checkout handler writes when it lands
  // first must not survive, and it must not overwrite the real one when it lands second.
  assert.equal(a.status, 'active');
  assert.equal(a.current_period_start.getTime(), 1_700_000_000_000);
  assert.equal(a.plan_id, proPlanId);
});

// ── Invoices and dunning ─────────────────────────────────────────────────────

function invoiceEvent(eventId: string, type: string, created: number, customer: string, paid: boolean) {
  return {
    id: eventId,
    type,
    created,
    data: {
      object: {
        id: `in_${eventId}`,
        number: 'NST-0001',
        status: paid ? 'paid' : 'open',
        amount_due: 4900,
        amount_paid: paid ? 4900 : 0,
        currency: 'usd',
        hosted_invoice_url: 'https://invoice.stripe.com/i/test',
        invoice_pdf: 'https://invoice.stripe.com/i/test.pdf',
        period_start: 1_700_000_000,
        period_end: 1_702_592_000,
        customer,
      },
    },
  } satisfies StripeWebhookEvent;
}

test('a failed payment starts dunning without taking the widget down', async () => {
  const ws = await makeWorkspace('dunning', 'cus_dunning');
  await unscopedPrisma.workspaces.update({
    where: { id: ws },
    data: { subscription_status: 'active' },
  });

  await processStripeEvent(invoiceEvent('evt_fail_1', 'invoice.payment_failed', 6_000, 'cus_dunning', false));

  const after_ = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws } });
  assert.equal(after_.subscription_status, 'past_due');
  assert.ok(after_.grace_until && after_.grace_until > new Date());
  assert.equal(widgetEntitlement(after_).widget, true, 'never break a live site over a failed card');
  assert.equal(widgetEntitlement(after_).panelWritable, false, 'the panel goes read-only');

  const invoices = await unscopedPrisma.invoices.findMany({ where: { workspace_id: ws } });
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0]!.amount_due, 4900);
});

test('a paid invoice clears dunning, but cannot revive a cancelled workspace', async () => {
  const ws = await unscopedPrisma.workspaces.findFirstOrThrow({ where: { slug: 'dunning' } });
  await processStripeEvent(invoiceEvent('evt_paid_1', 'invoice.paid', 6_100, 'cus_dunning', true));
  const recovered = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.equal(recovered.subscription_status, 'active');
  assert.equal(recovered.grace_until, null);

  // The same event type against a cancelled workspace must be inert: only the
  // subscription events, which carry the ordering guard, may undo a cancellation.
  await processStripeEvent(invoiceEvent('evt_paid_2', 'invoice.paid', 6_200, 'cus_reorder', true));
  const cancelled = await unscopedPrisma.workspaces.findFirstOrThrow({ where: { slug: 'reorder' } });
  assert.equal(cancelled.subscription_status, 'canceled');
});

test('trial_will_end refreshes the mirrored trial date from Stripe', async () => {
  const ws = await makeWorkspace('trialwarn', 'cus_trialwarn');
  const extended = 1_800_000_000;
  await processStripeEvent({
    id: 'evt_trial_warn',
    type: 'customer.subscription.trial_will_end',
    created: 7_000,
    data: {
      object: {
        id: 'sub_trialwarn',
        customer: 'cus_trialwarn',
        status: 'trialing',
        trial_end: extended,
        metadata: { workspace_id: ws },
      },
    },
  });
  const after_ = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws } });
  assert.equal(after_.trial_ends_at?.getTime(), extended * 1000);
});

test('an event for an unknown customer is recorded, not thrown away', async () => {
  const result = await processStripeEvent(
    invoiceEvent('evt_orphan', 'invoice.paid', 8_000, 'cus_nobody_here', true),
  );
  assert.equal(result, 'unroutable');
  const row = await unscopedPrisma.stripe_events.findUniqueOrThrow({ where: { id: 'evt_orphan' } });
  assert.ok(row.processed_at, 'an unroutable event must still be closed out, or Stripe retries forever');
});

// ── The lifecycle job ────────────────────────────────────────────────────────

test('the trial-expiry job moves a workspace into grace and then onto free', async () => {
  const ws = await unscopedPrisma.workspaces.create({
    data: {
      name: 'Lapsing',
      slug: 'lapsing',
      plan_id: proPlanId,
      subscription_status: 'trialing',
      trial_ends_at: new Date('2026-01-01T00:00:00Z'),
    },
    select: { id: true },
  });

  const dayAfter = new Date('2026-01-02T00:00:00Z');
  const first = await runBillingLifecycle(dayAfter);
  assert.equal(first.trialsExpired, 1);

  const inGrace = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.equal(inGrace.subscription_status, 'trial_expired');
  assert.equal(inGrace.plan_id, proPlanId, 'grace keeps the trial plan — nothing is taken away yet');
  assert.equal(
    inGrace.grace_until?.toISOString(),
    new Date('2026-01-09T00:00:00Z').toISOString(),
    'seven days of grace',
  );
  assert.equal(widgetEntitlement(inGrace, dayAfter).widget, true, 'the widget keeps serving during grace');
  assert.equal(widgetEntitlement(inGrace, dayAfter).panelWritable, false);

  // Re-running inside the window must change nothing — the sweep is idempotent.
  const midGrace = await runBillingLifecycle(new Date('2026-01-05T00:00:00Z'));
  assert.equal(midGrace.trialsExpired, 0);
  assert.equal(midGrace.droppedToFree, 0);

  const afterGrace = new Date('2026-01-10T00:00:00Z');
  const second = await runBillingLifecycle(afterGrace);
  assert.equal(second.droppedToFree, 1);

  const free = await unscopedPrisma.plans.findUniqueOrThrow({ where: { code: 'free' } });
  const dropped = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.equal(dropped.plan_id, free.id);
  assert.equal(dropped.subscription_status, 'active', 'a lapsed trial becomes a free customer, not a corpse');
  assert.equal(dropped.grace_until, null);
  assert.equal(widgetEntitlement(dropped, afterGrace).widget, true);
});

test('a workspace that converted mid-trial is not expired by the job', async () => {
  // The subscription created earlier belongs to `acme`, whose trial_ends_at is null;
  // give it a lapsed date and prove the subscription is what protects it.
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceId },
    data: { subscription_status: 'trialing', trial_ends_at: new Date('2026-01-01T00:00:00Z') },
  });
  await runBillingLifecycle(new Date('2026-02-01T00:00:00Z'));
  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceId } });
  assert.equal(ws.subscription_status, 'trialing', 'a paying customer must not be marked trial_expired');
});

test('the dunning ladder walks past_due to unpaid to suspended', async () => {
  const ws = await unscopedPrisma.workspaces.create({
    data: {
      name: 'Deadbeat',
      slug: 'deadbeat',
      plan_id: starterPlanId,
      subscription_status: 'past_due',
      grace_until: new Date('2026-03-01T00:00:00Z'),
    },
    select: { id: true },
  });

  await runBillingLifecycle(new Date('2026-03-02T00:00:00Z'));
  let row = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.equal(row.subscription_status, 'unpaid');
  assert.equal(widgetEntitlement(row, new Date('2026-03-02T00:00:00Z')).widget, true);

  await runBillingLifecycle(new Date('2026-03-20T00:00:00Z'));
  row = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.equal(row.subscription_status, 'suspended');
  assert.equal(row.grace_until, null);
  assert.equal(widgetEntitlement(row).widget, false, 'only after grace does the widget go dark');
});

test('the purge sweep soft-deletes a workspace past purge_after, and only then', async () => {
  const ws = await unscopedPrisma.workspaces.create({
    data: {
      name: 'Gone',
      slug: 'gone',
      plan_id: starterPlanId,
      subscription_status: 'canceled',
      purge_after: new Date('2026-04-01T00:00:00Z'),
    },
    select: { id: true },
  });

  await runBillingLifecycle(new Date('2026-03-31T00:00:00Z'));
  assert.equal(
    (await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } })).deleted_at,
    null,
    'a day early is still too early',
  );

  await runBillingLifecycle(new Date('2026-04-02T00:00:00Z'));
  const purged = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: ws.id } });
  assert.ok(purged.deleted_at, 'past its purge date the workspace is soft-deleted');
  // Soft, not hard: the rows are still there for a support-led restore.
  assert.equal(widgetEntitlement(purged).reason, 'deleted');
});
