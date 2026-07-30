import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// Three reasons, all of them structural rather than convenient:
//   - the plan catalog is reference data shared by every tenant;
//   - `subscriptions` and `invoices` are in INTENTIONALLY_UNSCOPED (see
//     db/tenant.ts), so req.db would NOT scope them — every query below therefore
//     names its workspace_id explicitly, which is the honest spelling;
//   - the Stripe webhook arrives with no session, no workspace and no scoped client.
// eslint-disable-next-line no-restricted-imports -- plan catalog, unscoped billing tables, and a webhook with no request context
import { unscopedPrisma } from '../../db/unscoped.js';
import { requireWorkspace, can, invalidateWorkspaceCache } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { usageState, USAGE_METRICS, type UsageMetric, type LimitState } from '../../lib/limits.js';
import {
  listPublicPlans,
  planByCode,
  planById,
  priceIdFor,
  seatsInUse,
  syncSeats,
  ensureStripeCustomer,
  stripeClient,
  stripeConfigured,
  webhookSecret,
  returnUrl,
  STRIPE_UNCONFIGURED,
  BILLING_HANDLED_MANUALLY,
  assessDowngrade,
  applyDowngrade,
  manualBlockers,
  processStripeEvent,
  widgetEntitlement,
  type BillingInterval,
  type StripeWebhookEvent,
} from '../../services/billing/index.js';

/**
 * Billing: the plan catalog, the account's own billing state, checkout, the portal,
 * plan changes, and the Stripe webhook.
 *
 * Two deliberate splits from the obvious design.
 *
 * The CARD lives in Stripe's Billing Portal — card updates, invoice history and
 * cancellation are all there. Rebuilding those screens means handling PCI scope,
 * 3DS and twenty countries' payment methods to arrive at a worse version of a page
 * Stripe maintains for free.
 *
 * PLAN CHANGES do not. They stay in the app because a downgrade has to be validated
 * against what the workspace is actually using BEFORE it takes effect. Sent through
 * the portal, the first we hear of a downgrade is a webhook telling us the customer
 * is already on a plan that does not fit them.
 */

const intervalField = z.enum(['month', 'year']);

/**
 * Which metrics are soft, and what to call them.
 *
 * `conversations` is the soft one, and the reason is a product decision documented
 * at length in lib/limits.ts: refusing a conversation at 100% means a visitor on a
 * customer's production site gets a broken widget and the customer silently loses a
 * lead.
 */
const METRIC_LABELS: Record<UsageMetric, string> = {
  conversations: 'Conversations',
  ai_replies: 'AI replies',
  ai_tokens_in: 'AI tokens in',
  ai_tokens_out: 'AI tokens out',
  emails: 'Emails sent',
  storage_bytes: 'Storage',
};
const SOFT_METRICS = new Set<UsageMetric>(['conversations']);

interface PlanLimits {
  max_conversations_month: number;
  max_ai_replies_month: number;
  storage_mb: number;
}

/** The plan allowance for each metered metric. 0 means unlimited — see lib/limits.ts. */
function allowanceFor(metric: UsageMetric, plan: PlanLimits): number {
  switch (metric) {
    case 'conversations':
      return plan.max_conversations_month;
    case 'ai_replies':
      return plan.max_ai_replies_month;
    case 'storage_bytes':
      return plan.storage_mb * 1024 * 1024;
    // Tokens and emails are metered so the cost of a workspace is visible, but they
    // are not sold as a line item, so there is nothing to enforce against.
    default:
      return 0;
  }
}

/**
 * Is this workspace billed by hand rather than through Stripe?
 *
 * Read fresh rather than taken from `req.auth.workspace`, which is a 30-second cache:
 * the window between an operator switching a customer to manual billing and that cache
 * expiring is exactly when a customer might click Subscribe, and being charged twice is
 * not a thing to be eventually consistent about.
 */
async function isManuallyBilled(workspaceId: string): Promise<boolean> {
  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { billing_mode: true },
  });
  return ws?.billing_mode === 'manual';
}

export async function billingV1Routes(app: FastifyInstance): Promise<void> {
  // ── The public catalog ────────────────────────────────────────────────────
  /**
   * Unauthenticated: the marketing pricing page and the in-app picker read the same
   * rows, so the two can never disagree about what a plan includes.
   *
   * The shape is built by services/billing/plans.ts from an explicit column list.
   * Nothing Stripe-shaped leaves here — not the price ids, not the product id, not
   * even the plan's primary key. The client selects a plan by `code`.
   */
  app.get(
    '/api/v1/plans',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      // `billing_enabled: false` is how the pricing page knows to render "contact us"
      // instead of a Subscribe button on a self-hosted install.
      return reply.send({ plans: await listPublicPlans(), billing_enabled: stripeConfigured() });
    },
  );

  // ── This workspace's billing state ────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/billing',
    { preHandler: [requireWorkspace, can('billing:read')] },
    async (req, reply) => {
      const workspaceId = req.auth!.workspace!.id;

      const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
        where: { id: workspaceId },
        select: {
          subscription_status: true,
          trial_ends_at: true,
          grace_until: true,
          purge_after: true,
          deleted_at: true,
          stripe_customer_id: true,
          billing_mode: true,
          plan: true,
        },
      });

      const [subscription, invoices, seats] = await Promise.all([
        unscopedPrisma.subscriptions.findUnique({
          where: { workspace_id: workspaceId },
          select: {
            status: true,
            interval: true,
            quantity: true,
            current_period_start: true,
            current_period_end: true,
            trial_end: true,
            cancel_at_period_end: true,
            canceled_at: true,
            plan: { select: { code: true, name: true } },
          },
        }),
        unscopedPrisma.invoices.findMany({
          where: { workspace_id: workspaceId },
          orderBy: { created_at: 'desc' },
          take: 24,
          select: {
            number: true,
            status: true,
            amount_due: true,
            amount_paid: true,
            currency: true,
            hosted_invoice_url: true,
            invoice_pdf: true,
            period_start: true,
            period_end: true,
            created_at: true,
          },
        }),
        seatsInUse(workspaceId),
      ]);

      // Every metered counter with its limit and its state, from the one module that
      // also produces the 402s — so the number on the billing page is the number
      // that refused the request, not a second implementation of the same idea.
      const usage: (LimitState & { label: string; soft: boolean })[] = await Promise.all(
        USAGE_METRICS.map(async (metric) => ({
          ...(await usageState(workspaceId, metric, allowanceFor(metric, ws.plan), {
            soft: SOFT_METRICS.has(metric),
          })),
          label: METRIC_LABELS[metric],
          soft: SOFT_METRICS.has(metric),
        })),
      );

      // Durable resources are counted, not metered: they have no period and the
      // customer can get back under a limit by deactivating one.
      const [websites, kbEntries, triggers, botFlows] = await Promise.all([
        req.db.websites.count({ where: { deleted_at: null, is_active: true } }),
        req.db.knowledge_base.count({ where: { is_active: true } }),
        req.db.triggers.count({ where: { is_active: true } }),
        req.db.bot_flows.count({ where: { is_active: true } }),
      ]);

      const entitlement = widgetEntitlement(ws);

      return reply.send({
        plan: {
          code: ws.plan.code,
          name: ws.plan.name,
          price_monthly_cents: ws.plan.price_monthly_cents,
          price_yearly_cents: ws.plan.price_yearly_cents,
        },
        status: {
          subscription_status: ws.subscription_status,
          trial_ends_at: ws.trial_ends_at,
          grace_until: ws.grace_until,
          purge_after: ws.purge_after,
          widget_serving: entitlement.widget,
          panel_writable: entitlement.panelWritable,
          reason: entitlement.reason,
        },
        subscription,
        seats: { used: seats, allowed: ws.plan.max_seats },
        usage,
        resources: [
          { resource: 'websites', used: websites, limit: ws.plan.max_websites },
          { resource: 'kb_entries', used: kbEntries, limit: ws.plan.max_kb_entries },
          { resource: 'triggers', used: triggers, limit: ws.plan.max_triggers },
          { resource: 'bot_flows', used: botFlows, limit: ws.plan.max_bot_flows },
        ],
        invoices,
        // The client needs to know whether to render a Subscribe button at all.
        // On an install with no Stripe there is nothing behind it, and on a workspace
        // we bill by transfer or invoice (`billing_mode: 'manual'`) there must not be:
        // a Subscribe button in front of a customer who already pays us charges them
        // twice. The guard is repeated on checkout and portal below, because a page
        // left open across a plan change would otherwise still be able to POST.
        billing_mode: ws.billing_mode,
        stripe: { configured: stripeConfigured(), customer: Boolean(ws.stripe_customer_id) },
      });
    },
  );

  // ── Checkout ──────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/w/:workspaceId/billing/checkout',
    { preHandler: [requireWorkspace, can('billing:manage')] },
    async (req, reply) => {
      const body = parseBody(
        z.object({ plan_code: z.string().min(1).max(40), interval: intervalField.default('month') }),
        req.body,
        reply,
      );
      if (!body) return;

      // Refuse before touching Stripe: this workspace is billed another way, and a
      // checkout here bills a customer who is already paying us. Repeated on all three
      // self-service endpoints because a page left open across the switch can still
      // POST to any of them.
      if (await isManuallyBilled(req.auth!.workspace!.id)) {
        return reply.code(409).send(BILLING_HANDLED_MANUALLY);
      }

      const stripe = stripeClient();
      if (!stripe) return reply.code(503).send(STRIPE_UNCONFIGURED);

      const plan = await planByCode(body.plan_code);
      if (!plan || !plan.is_public) return reply.code(404).send({ error: 'Unknown plan' });

      const price = priceIdFor(plan, body.interval as BillingInterval);
      if (!price) {
        return reply.code(503).send({
          error: `The ${plan.name} plan has no ${body.interval}ly price configured in Stripe`,
          code: 'price_missing',
        });
      }

      const workspaceId = req.auth!.workspace!.id;
      const customerId = await ensureStripeCustomer(workspaceId);
      if (!customerId) return reply.code(503).send(STRIPE_UNCONFIGURED);

      const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { slug: true, trial_ends_at: true, subscription_status: true },
      });
      const seats = await seatsInUse(workspaceId);

      // Carry the remaining trial into the subscription: a customer who subscribes on
      // day 3 of a 14-day trial keeps the other 11. Stripe refuses a `trial_end`
      // inside its 48-hour floor, so a trial that is nearly over simply converts now.
      const trialEndsAt = ws.trial_ends_at?.getTime() ?? 0;
      const trialUsable = ws.subscription_status === 'trialing' && trialEndsAt > Date.now() + 48 * 3600_000;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        // Both, deliberately. `client_reference_id` is the field Stripe surfaces in
        // its own dashboard and in the session object; the metadata copy is what
        // survives onto the subscription and every invoice after it.
        client_reference_id: workspaceId,
        metadata: {
          workspace_id: workspaceId,
          workspace_slug: ws.slug,
          plan_code: plan.code,
          interval: body.interval,
          seats: String(seats),
        },
        line_items: [{ price, quantity: seats }],
        subscription_data: {
          metadata: { workspace_id: workspaceId, plan_code: plan.code, interval: body.interval },
          ...(trialUsable ? { trial_end: Math.floor(trialEndsAt / 1000) } : {}),
        },
        // Sales tax / VAT is computed by Stripe from the customer's address rather
        // than by us. `customer_update` is not optional here: with automatic tax on
        // and an existing customer, Stripe requires permission to store the address
        // it collects, and refuses the session without it.
        automatic_tax: { enabled: true },
        customer_update: { address: 'auto' },
        allow_promotion_codes: true,
        success_url: returnUrl(`/w/${ws.slug}/settings/billing?checkout=success`),
        cancel_url: returnUrl(`/w/${ws.slug}/settings/billing?checkout=cancelled`),
      });

      await audit(req, {
        action: 'billing.checkout_started',
        targetType: 'plan',
        targetId: plan.code,
        details: { interval: body.interval, seats },
      });
      return reply.send({ url: session.url, session_id: session.id });
    },
  );

  // ── Billing portal ────────────────────────────────────────────────────────
  app.post(
    '/api/v1/w/:workspaceId/billing/portal',
    { preHandler: [requireWorkspace, can('billing:manage')] },
    async (req, reply) => {
      // Refuse before touching Stripe: this workspace is billed another way, and a
      // checkout here bills a customer who is already paying us. Repeated on all three
      // self-service endpoints because a page left open across the switch can still
      // POST to any of them.
      if (await isManuallyBilled(req.auth!.workspace!.id)) {
        return reply.code(409).send(BILLING_HANDLED_MANUALLY);
      }

      const stripe = stripeClient();
      if (!stripe) return reply.code(503).send(STRIPE_UNCONFIGURED);

      const workspaceId = req.auth!.workspace!.id;
      const customerId = await ensureStripeCustomer(workspaceId);
      if (!customerId) return reply.code(503).send(STRIPE_UNCONFIGURED);

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl(`/w/${req.auth!.workspace!.slug}/settings/billing`),
      });
      await audit(req, { action: 'billing.portal_opened', targetType: 'workspace', targetId: workspaceId });
      return reply.send({ url: session.url });
    },
  );

  // ── Plan change ───────────────────────────────────────────────────────────
  /**
   * An upgrade is unconditional. A downgrade is checked against what the workspace
   * is using first, and answered with 409 and the specifics unless the caller sends
   * `confirm: true`.
   *
   * Nothing is ever deleted. Surplus websites, knowledge base entries, triggers and
   * bot flows are DEACTIVATED newest-first, because the oldest resources are the
   * load-bearing ones. Surplus SEATS are never touched automatically — see
   * services/billing/downgrade.ts.
   */
  app.post(
    '/api/v1/w/:workspaceId/billing/plan',
    { preHandler: [requireWorkspace, can('billing:manage')] },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          plan_code: z.string().min(1).max(40),
          interval: intervalField.default('month'),
          confirm: z.boolean().default(false),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      // Refuse before touching Stripe: this workspace is billed another way, and a
      // checkout here bills a customer who is already paying us. Repeated on all three
      // self-service endpoints because a page left open across the switch can still
      // POST to any of them.
      if (await isManuallyBilled(req.auth!.workspace!.id)) {
        return reply.code(409).send(BILLING_HANDLED_MANUALLY);
      }

      const workspaceId = req.auth!.workspace!.id;
      const target = await planByCode(body.plan_code);
      if (!target || !target.is_public) return reply.code(404).send({ error: 'Unknown plan' });

      const current = await planById(req.auth!.workspace!.planId);
      if (current && current.id === target.id) {
        return reply.send({ ok: true, plan: target.code, changed: false });
      }

      const blockers = await assessDowngrade(workspaceId, target);
      const manual = manualBlockers(blockers);
      if (blockers.length > 0 && (!body.confirm || manual.length > 0)) {
        return reply.code(409).send({
          error: manual.length > 0
            ? 'Some of this cannot be resolved automatically — choose what to keep first'
            : `Moving to ${target.name} would exceed its limits`,
          code: 'downgrade_blocked',
          plan: target.code,
          // `manual: true` on a blocker means confirming will not clear it. The
          // client renders those as a required choice and the rest as a warning.
          blockers,
          needs_confirmation: manual.length === 0,
        });
      }

      const deactivated = body.confirm && blockers.length > 0
        ? (await applyDowngrade(workspaceId, blockers)).deactivated
        : {};

      const subscription = await unscopedPrisma.subscriptions.findUnique({
        where: { workspace_id: workspaceId },
        select: { stripe_subscription_id: true, stripe_item_id: true, status: true },
      });
      const stripe = stripeClient();
      const price = priceIdFor(target, body.interval as BillingInterval);

      if (stripe && subscription?.stripe_item_id && subscription.status !== 'canceled') {
        if (!price) {
          return reply.code(503).send({
            error: `The ${target.name} plan has no ${body.interval}ly price configured in Stripe`,
            code: 'price_missing',
          });
        }
        await stripe.subscriptions.update(subscription.stripe_subscription_id, {
          items: [{ id: subscription.stripe_item_id, price, quantity: await seatsInUse(workspaceId) }],
          proration_behavior: 'create_prorations',
          metadata: { workspace_id: workspaceId, plan_code: target.code, interval: body.interval },
        });
        // The mirror is NOT written here. `customer.subscription.updated` will arrive
        // with what Stripe actually did — including any proration or schedule it
        // applied — and writing our guess first would be a value the webhook then
        // has to correct.
        await audit(req, {
          action: 'billing.plan_change_requested',
          targetType: 'plan',
          targetId: target.code,
          details: { interval: body.interval, deactivated },
        });
        return reply.send({ ok: true, plan: target.code, changed: true, via: 'stripe', deactivated });
      }

      // No Stripe subscription: a trialing workspace, a free one, or a self-hosted
      // install. No webhook will ever arrive to mirror this, so the route writes the
      // plan itself. This is the one exception to "the mirror is written only by the
      // webhook and the job", and it exists because otherwise plan changes would be
      // impossible without a Stripe account.
      await unscopedPrisma.workspaces.update({
        where: { id: workspaceId },
        data: { plan_id: target.id },
      });
      invalidateWorkspaceCache(workspaceId);
      await syncSeats(workspaceId);
      await audit(req, {
        action: 'billing.plan_changed',
        targetType: 'plan',
        targetId: target.code,
        details: { interval: body.interval, deactivated, via: 'local' },
      });
      return reply.send({ ok: true, plan: target.code, changed: true, via: 'local', deactivated });
    },
  );

  // ── The Stripe webhook ────────────────────────────────────────────────────
  /**
   * Signature verification needs the RAW body, and Fastify parses JSON globally.
   *
   * The parser is therefore added inside an encapsulated plugin scope containing
   * exactly this one route. Changing the global parser to serve one endpoint would
   * hand every other handler a Buffer where it expects an object — a trap that
   * would be discovered by whichever route broke first, at runtime.
   */
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    scoped.post(
      '/api/v1/stripe/webhook',
      { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const stripe = stripeClient();
        const secret = webhookSecret();
        if (!stripe || !secret) return reply.code(503).send(STRIPE_UNCONFIGURED);

        const signature = req.headers['stripe-signature'];
        if (typeof signature !== 'string') {
          return reply.code(400).send({ error: 'Missing stripe-signature' });
        }

        let event: StripeWebhookEvent;
        try {
          // Verification happens against the exact bytes Stripe signed. Any
          // re-serialization — even one that produces equivalent JSON — invalidates
          // the signature, which is precisely the property that makes it useful.
          event = stripe.webhooks.constructEvent(req.body as Buffer, signature, secret);
        } catch (err) {
          req.log.warn({ err }, 'stripe webhook signature rejected');
          return reply.code(400).send({ error: 'Invalid signature' });
        }

        // A throw here becomes a 500, which is what makes Stripe retry. The event row
        // stays unprocessed and the retry re-claims it — see processStripeEvent.
        const result = await processStripeEvent(event);
        return reply.send({ received: true, result });
      },
    );
  });
}
