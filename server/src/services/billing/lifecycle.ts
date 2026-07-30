// The lifecycle sweep is cross-tenant by definition: it walks every workspace and
// moves the ones whose billing clock has run out.
// eslint-disable-next-line no-restricted-imports -- nightly sweep spans workspaces
import { unscopedPrisma } from '../../db/unscoped.js';
import { invalidateWorkspaceCache } from '../../plugins/auth.js';
import { fallbackPlan } from './plans.js';
import { backfillStripeCustomers } from './customer.js';

/**
 * The nightly billing sweep.
 *
 * Everything here is a CLOCK transition — something that becomes true because time
 * passed, which is precisely the class of change no webhook will ever tell us
 * about. Stripe knows when a card fails; it does not know that our seven-day grace
 * window ended at 03:00 this morning.
 *
 * The whole sweep is idempotent and takes `now` as a parameter, so a test can drive
 * a workspace through weeks of lifecycle in milliseconds and a second replica
 * running it twice changes nothing.
 *
 * The ladder, and why it is shaped this way:
 *
 *   trialing ──(trial_ends_at passed)──▶ trial_expired + 7d grace ──▶ free plan
 *   active ──(payment failed, webhook)──▶ past_due + 7d grace ──▶ unpaid + 7d ──▶ suspended
 *   canceled ──(webhook set purge_after = +30d)──▶ soft-deleted
 *
 * Grace is generous on purpose. The widget keeps serving throughout (see
 * entitlement.ts): a customer whose card expired should hear it from us, not from
 * their own visitors finding a dead chat bubble.
 *
 * Every query below also requires `billing_mode: 'stripe'`. A workspace an operator
 * moved to manual billing — bank transfer, an invoice against a purchase order, a
 * partner deal — has no Stripe subscription for this ladder to reason about, and
 * running it anyway would expire the trial of a customer who has already paid us and
 * then dun them for it. See migration 0011 and the plan route in
 * routes/platform/workspaces.ts. The purge sweep at the bottom is deliberately NOT
 * gated: `purge_after` is set by an explicit cancellation, and how someone pays has no
 * bearing on whether a cancellation they asked for should proceed.
 */

const GRACE_DAYS = 7;
const days = (n: number): number => n * 24 * 60 * 60 * 1000;

export interface LifecycleReport {
  trialsExpired: number;
  droppedToFree: number;
  dunningAdvanced: number;
  suspended: number;
  purged: number;
  customersCreated: number;
}

/** Batched so one enormous install cannot turn the sweep into a single long lock. */
const BATCH = 500;

async function setStatus(workspaceId: string, data: Record<string, unknown>): Promise<void> {
  await unscopedPrisma.workspaces.update({ where: { id: workspaceId }, data });
  invalidateWorkspaceCache(workspaceId);
}

/**
 * Trials whose clock ran out.
 *
 * A workspace with a live Stripe subscription is skipped even if `trial_ends_at` has
 * passed: they converted, and the subscription webhook owns their status. Without
 * that check a customer who paid on day 13 would be marked `trial_expired` on day 14
 * by a job that never looked at whether they had paid.
 */
async function expireTrials(now: Date, report: LifecycleReport): Promise<void> {
  const lapsed = await unscopedPrisma.workspaces.findMany({
    where: {
      deleted_at: null,
      billing_mode: 'stripe',
      subscription_status: 'trialing',
      trial_ends_at: { lt: now },
      subscription: { is: null },
    },
    take: BATCH,
    select: { id: true },
  });
  for (const ws of lapsed) {
    await setStatus(ws.id, {
      subscription_status: 'trial_expired',
      grace_until: new Date(now.getTime() + days(GRACE_DAYS)),
    });
    report.trialsExpired += 1;
  }
}

/**
 * Lapsed trials whose grace has also run out land on the free plan.
 *
 * They become a normal free customer — status `active`, no grace, free limits — not
 * a locked-out one. The free tier is a real product; treating a lapsed trial as a
 * dead account would throw away the most likely future customer we have.
 *
 * If an operator has removed the `free` plan (a legitimate choice on a self-hosted
 * or enterprise-only install) there is nowhere to drop to, so the workspace stays
 * `trial_expired` with its grace elapsed and the widget goes dark. That is the
 * correct outcome, and it is why this returns rather than inventing a plan.
 */
async function dropExpiredTrialsToFree(now: Date, report: LifecycleReport): Promise<void> {
  const free = await fallbackPlan();
  if (!free) return;

  const done = await unscopedPrisma.workspaces.findMany({
    where: {
      deleted_at: null,
      billing_mode: 'stripe',
      subscription_status: 'trial_expired',
      grace_until: { lt: now },
      subscription: { is: null },
    },
    take: BATCH,
    select: { id: true },
  });
  for (const ws of done) {
    await setStatus(ws.id, {
      plan_id: free.id,
      subscription_status: 'active',
      grace_until: null,
    });
    report.droppedToFree += 1;
  }
}

/**
 * The dunning ladder past the point Stripe stops retrying.
 *
 * `past_due` → `unpaid` → `suspended`, one grace window each. Two steps rather than
 * one because they mean different things to the customer: `unpaid` is still
 * recoverable by paying, `suspended` needs us.
 */
async function advanceDunning(now: Date, report: LifecycleReport): Promise<void> {
  const pastDue = await unscopedPrisma.workspaces.findMany({
    where: { deleted_at: null, billing_mode: 'stripe', subscription_status: 'past_due', grace_until: { lt: now } },
    take: BATCH,
    select: { id: true },
  });
  for (const ws of pastDue) {
    await setStatus(ws.id, {
      subscription_status: 'unpaid',
      grace_until: new Date(now.getTime() + days(GRACE_DAYS)),
    });
    report.dunningAdvanced += 1;
  }

  const unpaid = await unscopedPrisma.workspaces.findMany({
    where: { deleted_at: null, billing_mode: 'stripe', subscription_status: 'unpaid', grace_until: { lt: now } },
    take: BATCH,
    select: { id: true },
  });
  for (const ws of unpaid) {
    await setStatus(ws.id, { subscription_status: 'suspended', grace_until: null });
    report.suspended += 1;
  }
}

/**
 * The purge sweep.
 *
 * `purge_after` is set by the cancellation webhook and read here, thirty days
 * later — never in the webhook itself. Cancellations are reversed often enough that
 * "we deleted it the moment you clicked cancel" is a support incident waiting to
 * happen, and it is the one kind of bug that cannot be apologised for.
 *
 * Even here the workspace is only SOFT deleted. Hard removal is a deliberate
 * operator action on the platform surface, not something a cron job does at 3am.
 */
async function purge(now: Date, report: LifecycleReport): Promise<void> {
  const purgeable = await unscopedPrisma.workspaces.findMany({
    where: { deleted_at: null, purge_after: { lt: now } },
    take: BATCH,
    select: { id: true },
  });
  for (const ws of purgeable) {
    await setStatus(ws.id, { deleted_at: now });
    report.purged += 1;
  }
}

export async function runBillingLifecycle(now: Date = new Date()): Promise<LifecycleReport> {
  const report: LifecycleReport = {
    trialsExpired: 0,
    droppedToFree: 0,
    dunningAdvanced: 0,
    suspended: 0,
    purged: 0,
    customersCreated: 0,
  };

  await expireTrials(now, report);
  await dropExpiredTrialsToFree(now, report);
  await advanceDunning(now, report);
  await purge(now, report);
  report.customersCreated = await backfillStripeCustomers();

  return report;
}
