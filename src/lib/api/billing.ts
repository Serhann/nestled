import { api, get, post } from '../http';

/**
 * Plans, subscription state and Stripe.
 *
 * Plan CHANGES go through our own endpoint rather than the Stripe portal, so that
 * a downgrade can be validated first — the customer is told exactly what exceeds
 * the smaller plan instead of discovering it after the charge. Card details,
 * invoices and cancellation live in the portal, where they belong.
 */

const w = (workspaceId: string, path: string): string => `/api/v1/w/${workspaceId}${path}`;

export interface Plan {
  code: string;
  name: string;
  price_monthly_cents: number;
  price_yearly_cents: number;
  included_seats: number;
  limits: {
    seats: number;
    websites: number;
    conversations_month: number;
    ai_replies_month: number;
    kb_entries: number;
    bot_flows: number;
    triggers: number;
    storage_mb: number;
  };
  features: { remove_branding: boolean; live_view: boolean; bot: boolean };
}

export interface BillingState {
  plan: Plan;
  subscription: {
    status: string;
    interval: 'month' | 'year' | null;
    quantity: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    trial_end: string | null;
  } | null;
  seats: { used: number; included: number };
  invoices: {
    id: string;
    number: string | null;
    status: string;
    amount_due: number;
    currency: string;
    hosted_invoice_url: string | null;
    created_at: string;
  }[];
  usage: {
    metric: string;
    used: number;
    limit: number;
    state: 'ok' | 'soft' | 'hard';
  }[];
  /** False when this deployment has no Stripe keys — self-hosting stays usable. */
  stripe_configured: boolean;
}

export const listPlans = (): Promise<{ plans: Plan[] }> =>
  api('/api/v1/plans', { anonymous: true });

export const getBilling = (id: string): Promise<BillingState> => get(w(id, '/billing'));

export const startCheckout = (
  id: string,
  input: { plan_code: string; interval: 'month' | 'year' },
): Promise<{ url: string }> => post(w(id, '/billing/checkout'), input);

export const openPortal = (id: string): Promise<{ url: string }> => post(w(id, '/billing/portal'));

export interface DowngradeBlock {
  metric: string;
  limit: number;
  used: number;
}

export const changePlan = (
  id: string,
  input: { plan_code: string; interval: 'month' | 'year'; confirm?: boolean },
): Promise<{ ok: true } | { blocked: DowngradeBlock[] }> => post(w(id, '/billing/plan'), input);
