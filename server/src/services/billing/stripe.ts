import Stripe from 'stripe';
import { settings } from '../platform/settings.js';

/**
 * The Stripe client, and the narrow surface billing is allowed to use.
 *
 * Two things are deliberate here.
 *
 * First, the client is OPTIONAL. With `STRIPE_SECRET_KEY` unset the factory
 * returns null and the product still works: plans and limits are database facts,
 * so a self-hoster gets every feature without a Stripe account. Only the two
 * endpoints that genuinely need Stripe (checkout, portal) answer 503, and they say
 * so in words a self-hoster can act on.
 *
 * Second, everything downstream depends on `StripeLike` rather than on `Stripe`.
 * That interface is the ~six calls this codebase actually makes, which makes the
 * test double a plain object literal instead of a mock of a 400-resource SDK, and
 * makes the blast radius of a Stripe major version exactly this file. The real
 * client is assignable to it, so the compiler still checks the shape against the
 * SDK.
 */

export interface StripeCustomer {
  id: string;
}
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}
export interface StripePortalSession {
  url: string;
}
export interface StripeSubscriptionRef {
  id: string;
  items: { data: { id: string }[] };
}
/** The only parts of an event this codebase reads. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  /** Unix seconds. The out-of-order guard is built on this — see webhook.ts. */
  created: number;
  data: { object: unknown };
}

export interface StripeLike {
  customers: {
    create(params: Record<string, unknown>): Promise<StripeCustomer>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripeCheckoutSession>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripePortalSession>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscriptionRef>;
    update(id: string, params: Record<string, unknown>): Promise<StripeSubscriptionRef>;
  };
  webhooks: {
    constructEvent(payload: string | Buffer, header: string, secret: string): StripeWebhookEvent;
  };
}

let cached: StripeLike | null | undefined;
let override: StripeLike | null | undefined;
let overrideSecret: string | undefined;

/**
 * The configured client, or null when this installation has no Stripe.
 *
 * No `apiVersion` is passed on purpose: the SDK defaults to the version its own
 * types were generated against, so pinning a different string here would make the
 * types quietly describe a different API than the one being called.
 */
export function stripeClient(): StripeLike | null {
  if (override !== undefined) return override;
  if (cached === undefined) {
    const key = settings().billing.secretKey;
    cached = key ? new Stripe(key) : null;
  }
  return cached;
}

export function stripeConfigured(): boolean {
  return stripeClient() !== null;
}

/**
 * The signing secret webhook verification runs against.
 *
 * Separate from the client because the two are separately absent: an install can
 * have a secret key and no webhook endpoint configured yet, and answering that with
 * a 503 is better than verifying against an empty string.
 */
export function webhookSecret(): string | null {
  return overrideSecret ?? settings().billing.webhookSecret;
}

/**
 * Test seam. `null` simulates a self-hosted install with no Stripe; `undefined`
 * restores whatever the environment says.
 *
 * The secret travels with the client because env.ts is parsed once at import and a
 * test cannot retroactively give the process a webhook secret — without this, the
 * webhook route would be untestable in the one mode that matters.
 */
export function setStripeForTests(
  client: StripeLike | null | undefined,
  secret = 'whsec_test_seam',
): void {
  override = client;
  overrideSecret = client ? secret : undefined;
}

/**
 * The 503 body for the two endpoints that cannot work without Stripe.
 *
 * This used to be phrased for the operator — "set STRIPE_SECRET_KEY to enable
 * checkout" — on the theory that a self-hosted operator is the reader. They are not:
 * the reader is a customer who just clicked Subscribe, and what they got back named an
 * environment variable they have no access to. The `code` is what a client branches on
 * and the log line is what an operator needs; the `error` string belongs to whoever is
 * looking at the screen.
 */
export const STRIPE_UNCONFIGURED = {
  error: 'Card payments aren’t available at the moment. Get in touch and we’ll sort your plan out directly.',
  code: 'stripe_unconfigured',
} as const;

/**
 * The same, for a workspace we bill by transfer, invoice or a partner arrangement
 * (`billing_mode: 'manual'`). Not an error they should try to work around: their plan
 * is already handled, and self-service checkout would charge them a second time.
 */
export const BILLING_HANDLED_MANUALLY = {
  error: 'Your plan is managed for you, so there’s nothing to pay here. Get in touch to change it.',
  code: 'billing_manual',
} as const;

/** Where Checkout and the portal send the customer back to. */
export function returnUrl(path: string): string {
  const s = settings();
  const base = (s.billing.returnUrl ?? s.urls.app).replace(/\/+$/, '');
  return `${base}${path}`;
}
