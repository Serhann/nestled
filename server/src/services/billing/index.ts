/**
 * Billing, as the rest of the application sees it.
 *
 * Callers outside this directory import from here, not from the files beneath it,
 * so that "who depends on billing?" has a one-line answer and the internals stay
 * free to move. Today that is: team.ts for seats, jobs.ts for the sweep, widget.ts
 * for entitlement, and routes/v1/billing.ts for everything else.
 */
export { syncSeats, seatsInUse } from './seats.js';
export { widgetEntitlement } from './entitlement.js';
export type { Entitlement, EntitlementInput, EntitlementReason } from './entitlement.js';
export { runBillingLifecycle } from './lifecycle.js';
export type { LifecycleReport } from './lifecycle.js';
export { processStripeEvent } from './webhook.js';
export type { ProcessResult } from './webhook.js';
export { ensureStripeCustomer, backfillStripeCustomers } from './customer.js';
export {
  listPublicPlans,
  planByCode,
  planById,
  fallbackPlan,
  planByPriceId,
  priceIdFor,
  toPublicPlan,
} from './plans.js';
export type { PublicPlan, BillingInterval } from './plans.js';
export { assessDowngrade, applyDowngrade, manualBlockers } from './downgrade.js';
export type { DowngradeBlocker, DowngradeItem, TargetLimits } from './downgrade.js';
export {
  stripeClient,
  stripeConfigured,
  webhookSecret,
  setStripeForTests,
  returnUrl,
  STRIPE_UNCONFIGURED,
  BILLING_HANDLED_MANUALLY,
} from './stripe.js';
export type { StripeLike, StripeWebhookEvent } from './stripe.js';
