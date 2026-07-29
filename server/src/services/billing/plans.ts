// The plan catalog is reference data shared by every tenant — there is no
// workspace to scope it to, and the pricing page reads it with no session at all.
// eslint-disable-next-line no-restricted-imports -- shared plan catalog, not tenant data
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * The plan catalog.
 *
 * One module owns the translation from a `plans` row to what a client may see,
 * because the catalog is served on an UNAUTHENTICATED endpoint. A `select` written
 * inline at the route would be one careless `include` away from publishing
 * `stripe_price_monthly_id` to the open internet — harmless in isolation, but it
 * tells a competitor exactly which prices exist and lets anyone construct a
 * checkout against a price we did not offer them.
 */

export type BillingInterval = 'month' | 'year';

/** Exactly what leaves the server. Everything not listed here stays internal. */
export interface PublicPlan {
  code: string;
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  included_seats: number;
  is_trial_default: boolean;
  limits: {
    seats: number;
    websites: number;
    conversations_month: number;
    ai_replies_month: number;
    kb_entries: number;
    bot_flows: number;
    triggers: number;
    storage_mb: number;
    retention_days: number;
  };
  features: {
    remove_branding: boolean;
    live_view: boolean;
    bot: boolean;
  };
}

/** The columns `toPublicPlan` needs. Narrow on purpose — see the note above. */
export const PUBLIC_PLAN_SELECT = {
  code: true,
  name: true,
  sort_order: true,
  price_monthly_cents: true,
  price_yearly_cents: true,
  included_seats: true,
  is_trial_default: true,
  max_seats: true,
  max_websites: true,
  max_conversations_month: true,
  max_ai_replies_month: true,
  max_kb_entries: true,
  max_bot_flows: true,
  max_triggers: true,
  storage_mb: true,
  retention_days: true,
  allow_remove_branding: true,
  allow_live_view: true,
  allow_bot: true,
} as const;

export interface PublicPlanRow {
  code: string;
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  included_seats: number;
  is_trial_default: boolean;
  max_seats: number;
  max_websites: number;
  max_conversations_month: number;
  max_ai_replies_month: number;
  max_kb_entries: number;
  max_bot_flows: number;
  max_triggers: number;
  storage_mb: number;
  retention_days: number;
  allow_remove_branding: boolean;
  allow_live_view: boolean;
  allow_bot: boolean;
}

export function toPublicPlan(row: PublicPlanRow): PublicPlan {
  return {
    code: row.code,
    name: row.name,
    sort_order: row.sort_order,
    price_monthly_cents: row.price_monthly_cents,
    price_yearly_cents: row.price_yearly_cents,
    included_seats: row.included_seats,
    is_trial_default: row.is_trial_default,
    limits: {
      seats: row.max_seats,
      websites: row.max_websites,
      conversations_month: row.max_conversations_month,
      ai_replies_month: row.max_ai_replies_month,
      kb_entries: row.max_kb_entries,
      bot_flows: row.max_bot_flows,
      triggers: row.max_triggers,
      storage_mb: row.storage_mb,
      retention_days: row.retention_days,
    },
    features: {
      remove_branding: row.allow_remove_branding,
      live_view: row.allow_live_view,
      bot: row.allow_bot,
    },
  };
}

/** The catalog as the pricing page and the in-app picker see it. */
export async function listPublicPlans(): Promise<PublicPlan[]> {
  const rows = await unscopedPrisma.plans.findMany({
    where: { is_public: true },
    orderBy: { sort_order: 'asc' },
    select: PUBLIC_PLAN_SELECT,
  });
  return rows.map(toPublicPlan);
}

/** Every column, for internal use (limits, price ids, downgrade comparisons). */
export async function planByCode(code: string) {
  return unscopedPrisma.plans.findUnique({ where: { code } });
}

export async function planById(id: string) {
  return unscopedPrisma.plans.findUnique({ where: { id } });
}

/**
 * The plan a lapsed trial or a cancelled subscription falls back to.
 *
 * Null when an operator has removed the free tier — the caller must then leave the
 * workspace where it is rather than invent a plan for it.
 */
export async function fallbackPlan() {
  return unscopedPrisma.plans.findUnique({ where: { code: 'free' } });
}

interface PriceCarrier {
  stripe_price_monthly_id: string | null;
  stripe_price_yearly_id: string | null;
}

export function priceIdFor(plan: PriceCarrier, interval: BillingInterval): string | null {
  return interval === 'year' ? plan.stripe_price_yearly_id : plan.stripe_price_monthly_id;
}

/**
 * Find the plan a Stripe price belongs to.
 *
 * The webhook has a price id and needs a plan; doing the lookup here keeps the
 * mapping in the same file as the one that produced the price id in the first
 * place, so the two cannot drift.
 */
export async function planByPriceId(priceId: string) {
  return unscopedPrisma.plans.findFirst({
    where: {
      OR: [{ stripe_price_monthly_id: priceId }, { stripe_price_yearly_id: priceId }],
    },
  });
}
