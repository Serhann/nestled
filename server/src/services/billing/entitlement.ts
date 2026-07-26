/**
 * What a workspace is still allowed to do, given only its billing state.
 *
 * Pure by construction — no database, no clock beyond the one you pass in. That is
 * the whole reason it exists as a module rather than as a helper inside the widget
 * route: this is the rule that decides whether a paying-then-lapsed customer's
 * production website keeps working, and a rule that important should be testable
 * without a Postgres, a workspace and an HTTP request.
 *
 * The product decision it encodes:
 *
 *   NEVER break a prospect's live site over money. When a trial lapses or a card
 *   fails, the widget keeps serving for the whole grace window while the panel goes
 *   read-only except for billing. The customer discovers the problem in the app,
 *   where they can fix it, instead of discovering it as a support ticket from their
 *   own visitors. Only after grace does the widget go dark.
 *
 *   `suspended` is the one exception: it is set by staff (abuse, chargeback, legal),
 *   not by the dunning ladder, so it takes effect immediately and has no grace.
 */

export interface EntitlementInput {
  subscription_status: string;
  grace_until: Date | null;
  /** Soft-deleted workspaces serve nothing, regardless of billing state. */
  deleted_at?: Date | null;
}

export type EntitlementReason =
  | 'ok'
  | 'in_grace'
  | 'grace_expired'
  | 'suspended'
  | 'deleted';

export interface Entitlement {
  /** May the public widget boot and accept conversations? */
  widget: boolean;
  /** May the panel accept writes other than billing ones? */
  panelWritable: boolean;
  reason: EntitlementReason;
  /** When set, the moment the widget goes dark. Drives the in-app countdown. */
  graceEndsAt: Date | null;
}

/**
 * Statuses that suspend the account UNLESS grace is still running.
 *
 * `unpaid` is here rather than treated as terminal because Stripe reaches it after
 * its own retry schedule has already failed for days — by that point the customer
 * has had several emails, and taking their widget down the same hour buys nothing.
 */
const GRACEABLE = new Set(['trial_expired', 'past_due', 'unpaid', 'canceled']);

export function widgetEntitlement(ws: EntitlementInput, now: Date = new Date()): Entitlement {
  if (ws.deleted_at) {
    return { widget: false, panelWritable: false, reason: 'deleted', graceEndsAt: null };
  }
  if (ws.subscription_status === 'suspended') {
    return { widget: false, panelWritable: false, reason: 'suspended', graceEndsAt: null };
  }
  if (!GRACEABLE.has(ws.subscription_status)) {
    return { widget: true, panelWritable: true, reason: 'ok', graceEndsAt: null };
  }
  const inGrace = Boolean(ws.grace_until && ws.grace_until > now);
  return {
    widget: inGrace,
    // Read-only in BOTH branches: once billing has lapsed the only useful write is
    // a payment, and letting an unpaid workspace keep adding data it is about to
    // lose access to is a refund conversation waiting to happen.
    panelWritable: false,
    reason: inGrace ? 'in_grace' : 'grace_expired',
    graceEndsAt: ws.grace_until ?? null,
  };
}
