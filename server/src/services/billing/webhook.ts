// A Stripe webhook arrives with no request context at all: no session, no
// workspace, no scoped client. Resolving the tenant IS the first thing this file
// does, from the event's own metadata or from the customer id.
// eslint-disable-next-line no-restricted-imports -- webhooks precede any workspace scope
import { unscopedPrisma } from '../../db/unscoped.js';
import { invalidateWorkspaceCache } from '../../plugins/auth.js';
import { planByCode, planByPriceId, type BillingInterval } from './plans.js';
import type { StripeWebhookEvent } from './stripe.js';

/**
 * Stripe webhook processing.
 *
 * THREE independent idempotency mechanisms. All three are required, and each one
 * catches something the other two cannot:
 *
 *   1. EXACTLY-ONCE. `INSERT INTO stripe_events (id, …) ON CONFLICT (id) DO NOTHING`.
 *      Stripe's event id is the PRIMARY KEY, so the insert itself is the lock —
 *      zero rows affected means another delivery already has it. This is what stops
 *      a retried delivery (Stripe retries for days) from billing twice.
 *
 *   2. OUT-OF-ORDER. Stripe does not guarantee delivery order, and its retries make
 *      reordering routine rather than exotic. Every subscription handler compares
 *      `event.created` against `subscriptions.last_event_at` and drops the older
 *      one. Without this, a `customer.subscription.updated` that was delayed by a
 *      retry lands after the `deleted` and RESURRECTS a cancelled subscription —
 *      the customer keeps a paid product for free and we keep billing a card that
 *      is not there.
 *
 *   3. ARRIVAL-ORDER INDEPENDENCE. `checkout.session.completed` and
 *      `customer.subscription.created` describe the same subscription and arrive in
 *      either order. Both therefore UPSERT on `stripe_subscription_id` and neither
 *      inserts blindly, so whichever lands first creates the row and the other one
 *      fills in what it knows. Mechanism 1 cannot help here: these are two different
 *      event ids describing one object.
 *
 * Mechanism 1 alone would also break retries of a FAILED handler — the row exists,
 * so the retry would be dismissed as a duplicate and the event lost forever. The
 * gate below therefore distinguishes "already processed" from "inserted but never
 * finished", and re-claims the latter with a compare-and-swap on `attempts`.
 */

/** How long a cancelled workspace's data survives. Webhooks never delete anything. */
const PURGE_AFTER_DAYS = 30;
/** How long the widget keeps serving after a cancellation or a failed payment. */
const GRACE_DAYS = 7;

const days = (n: number): number => n * 24 * 60 * 60 * 1000;

export type ProcessResult = 'processed' | 'duplicate' | 'ignored' | 'unroutable';

// ── Shapes ───────────────────────────────────────────────────────────────────
// Hand-written rather than imported from the SDK: these are the fields we read
// off the wire, and writing them out is what makes it obvious how little of a
// Stripe object this codebase actually depends on.

interface StripeRef {
  id: string;
}
type Ref = string | StripeRef | null | undefined;

interface SubscriptionObject {
  id: string;
  customer?: Ref;
  status?: string;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  trial_end?: number | null;
  current_period_start?: number;
  current_period_end?: number;
  metadata?: Record<string, string> | null;
  items?: {
    data?: {
      id?: string;
      quantity?: number;
      current_period_start?: number;
      current_period_end?: number;
      price?: { id?: string; recurring?: { interval?: string } | null } | null;
    }[];
  };
}

interface CheckoutSessionObject {
  id: string;
  mode?: string;
  client_reference_id?: string | null;
  customer?: Ref;
  subscription?: Ref;
  metadata?: Record<string, string> | null;
}

interface InvoiceObject {
  id: string;
  number?: string | null;
  status?: string | null;
  amount_due?: number;
  amount_paid?: number;
  currency?: string;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  customer?: Ref;
  subscription?: Ref;
  parent?: { subscription_details?: { subscription?: Ref } | null } | null;
}

function idOf(ref: Ref): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function secondsToDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

// ── Tenant resolution ────────────────────────────────────────────────────────

async function workspaceIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { stripe_customer_id: customerId },
    select: { id: true },
  });
  return ws?.id ?? null;
}

/**
 * Metadata first, customer id second.
 *
 * Metadata is what we set ourselves at checkout, so it is the reliable path;
 * the customer lookup covers subscriptions created in the Stripe dashboard by
 * support, which carry no metadata of ours.
 */
async function resolveWorkspace(
  metadata: Record<string, string> | null | undefined,
  customerId: string | null,
): Promise<string | null> {
  const fromMetadata = metadata?.workspace_id;
  if (fromMetadata) {
    const exists = await unscopedPrisma.workspaces.findUnique({
      where: { id: fromMetadata },
      select: { id: true },
    });
    if (exists) return exists.id;
  }
  return workspaceIdForCustomer(customerId);
}

/**
 * Stripe's subscription vocabulary, mapped onto the workspace mirror.
 *
 * `null` means "leave the mirror alone". `incomplete` is the important one: it is
 * the state between "customer clicked subscribe" and "the card cleared", and
 * writing it through would knock a workspace out of `trialing` for a purchase that
 * may still succeed.
 */
function mirrorStatus(stripeStatus: string | undefined): string | null {
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'paused':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

/**
 * Update the workspace billing mirror and drop the auth plugin's 30s cache.
 *
 * A workspace on `billing_mode = 'manual'` is skipped, and that is the entire
 * mechanism protecting a plan set by hand. Someone paying by bank transfer may still
 * have an old Stripe subscription attached; without this check the next
 * `customer.subscription.updated` for it would quietly overwrite the plan an operator
 * assigned, and nobody would connect the two events. Skipping is recorded rather than
 * silent — a webhook that changed nothing must be findable later.
 *
 * The subscription and invoice ROWS are still written by their handlers. Only this
 * mirror is gated: keeping the Stripe record accurate is how a workspace can be handed
 * back to Stripe without reconciling anything by hand.
 */
async function mirror(workspaceId: string, data: Record<string, unknown>): Promise<void> {
  if (Object.keys(data).length === 0) return;

  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { billing_mode: true },
  });
  if (ws?.billing_mode === 'manual') {
    await systemAudit(workspaceId, 'billing.mirror_skipped_manual', { would_have_set: data });
    return;
  }

  await unscopedPrisma.workspaces.update({ where: { id: workspaceId }, data });
  invalidateWorkspaceCache(workspaceId);
}

async function systemAudit(
  workspaceId: string | null,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await unscopedPrisma.audit_log
    .create({
      data: {
        workspace_id: workspaceId,
        actor_type: 'system',
        action,
        target_type: 'subscription',
        details: details as object,
      },
    })
    .catch(() => undefined);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Write the subscription row, honouring the out-of-order guard.
 *
 * Keyed on `stripe_subscription_id`, but `subscriptions.workspace_id` is ALSO
 * unique — one workspace, one subscription. A customer who cancels and later
 * resubscribes gets a new Stripe id for the same workspace, so a plain upsert on
 * the Stripe id would collide on the workspace. The row is adopted instead: same
 * row, new Stripe id, full history of who they are preserved.
 */
async function writeSubscription(
  workspaceId: string,
  stripeSubscriptionId: string,
  eventAt: Date,
  fields: Record<string, unknown>,
  /**
   * Columns written ONLY when this event creates the row. This is what makes
   * arrival order irrelevant: the checkout handler must supply a status and a
   * billing period because those columns are NOT NULL, but it does not actually
   * know either, so it must never be allowed to overwrite what a subscription
   * event already established.
   */
  createOnly: Record<string, unknown> = {},
): Promise<'written' | 'stale'> {
  const byStripeId = await unscopedPrisma.subscriptions.findUnique({
    where: { stripe_subscription_id: stripeSubscriptionId },
    select: { id: true, last_event_at: true },
  });
  const existing =
    byStripeId ??
    (await unscopedPrisma.subscriptions.findUnique({
      where: { workspace_id: workspaceId },
      select: { id: true, last_event_at: true },
    }));

  if (existing) {
    if (existing.last_event_at && existing.last_event_at > eventAt) return 'stale';
    await unscopedPrisma.subscriptions.update({
      where: { id: existing.id },
      data: { ...fields, stripe_subscription_id: stripeSubscriptionId, last_event_at: eventAt },
    });
    return 'written';
  }

  await unscopedPrisma.subscriptions.create({
    data: {
      workspace_id: workspaceId,
      stripe_subscription_id: stripeSubscriptionId,
      last_event_at: eventAt,
      ...createOnly,
      ...fields,
    } as never,
  });
  return 'written';
}

async function onSubscriptionEvent(event: StripeWebhookEvent): Promise<ProcessResult> {
  const sub = event.data.object as SubscriptionObject;
  const eventAt = new Date(event.created * 1000);
  const customerId = idOf(sub.customer);
  const workspaceId = await resolveWorkspace(sub.metadata, customerId);
  if (!workspaceId) return 'unroutable';

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  // Plan by metadata first (we set it at checkout), then by price id (a subscription
  // created by support in the dashboard), then leave the plan where it is.
  const plan =
    (sub.metadata?.plan_code ? await planByCode(sub.metadata.plan_code) : null) ??
    (priceId ? await planByPriceId(priceId) : null);

  const interval: BillingInterval =
    item?.price?.recurring?.interval === 'year'
      ? 'year'
      : sub.metadata?.interval === 'year'
        ? 'year'
        : 'month';

  const deleted = event.type === 'customer.subscription.deleted';
  const status = deleted ? 'canceled' : (sub.status ?? 'active');

  // Stripe moved the billing period onto the subscription ITEM in its 2025 API
  // versions and kept it on the subscription in older ones. Reading both means the
  // handler does not silently start writing epoch-zero periods on an API upgrade.
  const periodStart =
    secondsToDate(sub.current_period_start) ?? secondsToDate(item?.current_period_start) ?? eventAt;
  const periodEnd =
    secondsToDate(sub.current_period_end) ?? secondsToDate(item?.current_period_end) ?? eventAt;

  const result = await writeSubscription(workspaceId, sub.id, eventAt, {
    ...(plan ? { plan_id: plan.id } : {}),
    stripe_item_id: item?.id ?? null,
    status,
    interval,
    quantity: item?.quantity ?? 1,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    trial_end: secondsToDate(sub.trial_end),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    canceled_at: deleted ? (secondsToDate(sub.canceled_at) ?? eventAt) : secondsToDate(sub.canceled_at),
  });
  if (result === 'stale') return 'ignored';

  const mirrored = mirrorStatus(status);
  const now = new Date();
  await mirror(workspaceId, {
    ...(plan ? { plan_id: plan.id } : {}),
    ...(mirrored ? { subscription_status: mirrored } : {}),
    ...(sub.trial_end ? { trial_ends_at: secondsToDate(sub.trial_end) } : {}),
    ...(mirrored === 'canceled'
      ? {
          // The widget keeps serving through grace, and the data survives for a
          // month. Coming back is a status flip, not a restore from backup.
          grace_until: new Date(now.getTime() + days(GRACE_DAYS)),
          purge_after: new Date(now.getTime() + days(PURGE_AFTER_DAYS)),
        }
      : {}),
    ...(mirrored === 'active' || mirrored === 'trialing' ? { grace_until: null, purge_after: null } : {}),
  });

  return 'processed';
}

/**
 * The checkout session.
 *
 * It knows what the customer BOUGHT — plan, interval, seats — and nothing reliable
 * about the resulting subscription's lifecycle. It therefore writes only the
 * purchase facts and leaves status and billing periods to the subscription events,
 * so that arriving after them cannot undo what they established.
 */
async function onCheckoutCompleted(event: StripeWebhookEvent): Promise<ProcessResult> {
  const session = event.data.object as CheckoutSessionObject;
  const eventAt = new Date(event.created * 1000);
  const customerId = idOf(session.customer);
  const workspaceId =
    session.client_reference_id ?? (await resolveWorkspace(session.metadata, customerId));
  if (!workspaceId) return 'unroutable';

  if (customerId) {
    await unscopedPrisma.workspaces.updateMany({
      where: { id: workspaceId, stripe_customer_id: null },
      data: { stripe_customer_id: customerId },
    });
  }

  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return 'ignored';

  const plan = session.metadata?.plan_code ? await planByCode(session.metadata.plan_code) : null;
  const interval: BillingInterval = session.metadata?.interval === 'year' ? 'year' : 'month';
  const quantity = Number(session.metadata?.seats ?? '1') || 1;

  const result = await writeSubscription(
    workspaceId,
    subscriptionId,
    eventAt,
    {
      ...(plan ? { plan_id: plan.id } : {}),
      interval,
      quantity,
    },
    // Placeholders, and nothing more. `incomplete` is honest about what a completed
    // checkout actually proves: the customer finished the form, not that the card
    // cleared. The subscription events replace all three.
    { status: 'incomplete', current_period_start: eventAt, current_period_end: eventAt },
  );
  if (result === 'stale') return 'ignored';

  if (plan) {
    await mirror(workspaceId, { plan_id: plan.id });
  }
  return 'processed';
}

async function onInvoiceEvent(event: StripeWebhookEvent, paid: boolean): Promise<ProcessResult> {
  const inv = event.data.object as InvoiceObject;
  const customerId = idOf(inv.customer);
  const workspaceId = await workspaceIdForCustomer(customerId);
  if (!workspaceId) return 'unroutable';

  const fields = {
    number: inv.number ?? null,
    status: inv.status ?? (paid ? 'paid' : 'open'),
    amount_due: inv.amount_due ?? 0,
    amount_paid: inv.amount_paid ?? 0,
    currency: inv.currency ?? 'usd',
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    period_start: secondsToDate(inv.period_start),
    period_end: secondsToDate(inv.period_end),
  };
  await unscopedPrisma.invoices.upsert({
    where: { stripe_invoice_id: inv.id },
    create: { workspace_id: workspaceId, stripe_invoice_id: inv.id, ...fields },
    update: fields,
  });

  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { subscription_status: true },
  });
  if (!ws) return 'processed';

  if (paid) {
    // Only lift a workspace OUT of a dunning state. An invoice.paid delivered late,
    // after a cancellation, must not undo the cancellation — that is what the
    // subscription events are for, and they carry the ordering guard.
    if (['past_due', 'unpaid', 'trialing'].includes(ws.subscription_status)) {
      await mirror(workspaceId, {
        subscription_status: 'active',
        grace_until: null,
        purge_after: null,
      });
    }
    return 'processed';
  }

  if (['active', 'trialing'].includes(ws.subscription_status)) {
    await mirror(workspaceId, {
      subscription_status: 'past_due',
      // Dunning starts the clock rather than stopping the service. See
      // entitlement.ts for why the widget stays up for the whole window.
      grace_until: new Date(Date.now() + days(GRACE_DAYS)),
    });
  }
  return 'processed';
}

/**
 * Seven days before a trial converts.
 *
 * The mirror is refreshed from Stripe's own `trial_end` rather than trusted from
 * signup, because support extending a trial in the dashboard is a normal thing to
 * do and the in-app countdown must not keep showing the original date.
 */
async function onTrialWillEnd(event: StripeWebhookEvent): Promise<ProcessResult> {
  const sub = event.data.object as SubscriptionObject;
  const workspaceId = await resolveWorkspace(sub.metadata, idOf(sub.customer));
  if (!workspaceId) return 'unroutable';

  const trialEnd = secondsToDate(sub.trial_end);
  if (trialEnd) await mirror(workspaceId, { trial_ends_at: trialEnd });
  await systemAudit(workspaceId, 'billing.trial_will_end', {
    trial_end: trialEnd?.toISOString() ?? null,
    stripe_subscription_id: sub.id,
  });
  return 'processed';
}

// ── The gate ─────────────────────────────────────────────────────────────────

async function dispatch(event: StripeWebhookEvent): Promise<ProcessResult> {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionEvent(event);
    case 'customer.subscription.trial_will_end':
      return onTrialWillEnd(event);
    case 'invoice.paid':
      return onInvoiceEvent(event, true);
    case 'invoice.payment_failed':
      return onInvoiceEvent(event, false);
    default:
      // Stripe sends far more than we subscribe to. Recording and ignoring is the
      // right answer: the row is the audit trail for "did we get it and decide
      // nothing, or never get it at all?".
      return 'ignored';
  }
}

/**
 * Record the event, then handle it exactly once.
 *
 * Exported separately from the route so the idempotency guarantees can be tested
 * without a signature, a raw body or an HTTP client — the properties being asserted
 * are about the database, not about Fastify.
 */
export async function processStripeEvent(event: StripeWebhookEvent): Promise<ProcessResult> {
  const inserted = await unscopedPrisma.$executeRaw`
    INSERT INTO stripe_events (id, type, payload, received_at, attempts)
    VALUES (${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb, now(), 1)
    ON CONFLICT (id) DO NOTHING
  `;

  if (inserted === 0) {
    const row = await unscopedPrisma.stripe_events.findUnique({
      where: { id: event.id },
      select: { processed_at: true, attempts: true },
    });
    if (!row || row.processed_at) return 'duplicate';
    // A previous attempt inserted the row and then failed. Re-claim it with a
    // compare-and-swap on `attempts`, so that two concurrent redeliveries of the
    // same unfinished event still produce exactly one winner.
    const claimed = await unscopedPrisma.$executeRaw`
      UPDATE stripe_events SET attempts = attempts + 1
      WHERE id = ${event.id} AND processed_at IS NULL AND attempts = ${row.attempts}
    `;
    if (claimed === 0) return 'duplicate';
  }

  try {
    const result = await dispatch(event);
    await unscopedPrisma.stripe_events.update({
      where: { id: event.id },
      data: { processed_at: new Date(), error: null },
    });
    return result;
  } catch (err) {
    // The row keeps `processed_at` NULL, so Stripe's next retry re-claims it above.
    // Rethrowing is what makes Stripe retry at all: a 200 here would be us telling
    // Stripe we handled an event we dropped.
    await unscopedPrisma.stripe_events
      .update({ where: { id: event.id }, data: { error: (err as Error).message.slice(0, 1000) } })
      .catch(() => undefined);
    throw err;
  }
}
