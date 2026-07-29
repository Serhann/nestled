import type { Prisma } from '@prisma/client';
// usage_counters is the metering ledger. It is written from places that have no
// request-scoped client (the widget plane creates a conversation before any
// visitor identity exists) and read on the hot widget path, so it uses the
// unscoped client with an explicit workspace_id on every call.
// eslint-disable-next-line no-restricted-imports -- metering ledger, workspace_id passed explicitly
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * Plan limits and usage metering.
 *
 * This is the contract shared by everything that counts against a plan: the
 * widget plane (conversations), the AI service (replies and tokens), the mailer
 * (emails) and uploads (storage). Keeping it in one module is what makes the
 * billing page, the 402 responses and the nightly reconciliation agree with each
 * other — three separate counting implementations would not.
 *
 * Two kinds of limit, and the difference is a product decision, not a technical
 * one:
 *
 *   HARD  — the action is refused with 402. Correct where each call costs us real
 *           money on the margin (`ai_replies`) or where the resource is a durable
 *           object the customer can delete to get back under (websites, seats).
 *   SOFT  — the action still happens, but the workspace is warned. Correct for
 *           `conversations`: refusing one means a visitor on a customer's
 *           production site gets a broken widget and the customer silently loses
 *           a lead. We warn at 100% and only stop creating NEW conversations at
 *           120%, at which point the widget falls back to "leave your email"
 *           rather than failing.
 */

export const USAGE_METRICS = [
  'conversations',
  'ai_replies',
  'ai_tokens_in',
  'ai_tokens_out',
  'emails',
  'storage_bytes',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** Metrics that are a LEVEL rather than a flow, so they do not reset monthly. */
const LEVEL_METRICS = new Set<UsageMetric>(['storage_bytes']);

/** Above this fraction of a soft limit, creation stops. See the note above. */
export const SOFT_LIMIT_CUTOFF = 1.2;

/**
 * The period a metric is counted in. Month starts are UTC dates — a workspace's
 * own timezone would make the counter disagree with the invoice, which is set by
 * Stripe's billing period, not by where the customer lives.
 */
export function periodStart(metric: UsageMetric, now: Date = new Date()): Date {
  if (LEVEL_METRICS.has(metric)) return new Date(0);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A Prisma client or an open transaction — increments must be able to join one. */
type Writable = Pick<Prisma.TransactionClient, 'usage_counters'>;

/**
 * Add to a counter, creating the period row on first use.
 *
 * Pass the transaction client when the counted thing is created in a transaction.
 * `conversations` MUST do this: a counter incremented outside the transaction
 * that created the row can drift from reality on any rollback, and a metering
 * number that drifts is worse than no number, because it gets billed.
 */
export async function incrementUsage(
  workspaceId: string,
  metric: UsageMetric,
  by = 1,
  tx?: Writable,
): Promise<void> {
  const client = tx ?? unscopedPrisma;
  const period = periodStart(metric);
  await client.usage_counters.upsert({
    where: { workspace_id_metric_period_start: { workspace_id: workspaceId, metric, period_start: period } },
    create: { workspace_id: workspaceId, metric, period_start: period, value: BigInt(by) },
    update: { value: { increment: BigInt(by) } },
  });
  cache.delete(cacheKey(workspaceId, metric));
}

/**
 * A tiny per-workspace read cache.
 *
 * The widget's hot path asks "is this workspace over its conversation limit?" on
 * every boot. Ten seconds of staleness on a monthly counter is invisible to the
 * customer and turns that question into zero queries for almost every request.
 */
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { value: number; at: number }>();
const cacheKey = (workspaceId: string, metric: UsageMetric): string => `${workspaceId}:${metric}`;

/** Test seam: usage numbers are cached, and tests assert on them immediately. */
export function clearUsageCache(): void {
  cache.clear();
}

export async function currentUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
  const key = cacheKey(workspaceId, metric);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const row = await unscopedPrisma.usage_counters.findUnique({
    where: {
      workspace_id_metric_period_start: {
        workspace_id: workspaceId,
        metric,
        period_start: periodStart(metric),
      },
    },
    select: { value: true },
  });
  const value = Number(row?.value ?? 0n);
  cache.set(key, { value, at: Date.now() });
  return value;
}

export interface LimitState {
  metric: UsageMetric;
  used: number;
  limit: number;
  /** used / limit, or 0 when the plan is unlimited. */
  ratio: number;
  /** 'ok' below the limit, 'soft' over it but still allowed, 'hard' refused. */
  state: 'ok' | 'soft' | 'hard';
  unlimited: boolean;
}

/**
 * Evaluate one metered metric against a plan allowance.
 *
 * `limit <= 0` means unlimited — that spelling exists so a plan row can express
 * "no cap" without a nullable column that every caller has to remember to handle.
 */
export async function usageState(
  workspaceId: string,
  metric: UsageMetric,
  limit: number,
  opts: { soft?: boolean } = {},
): Promise<LimitState> {
  const used = await currentUsage(workspaceId, metric);
  if (limit <= 0) {
    return { metric, used, limit, ratio: 0, state: 'ok', unlimited: true };
  }
  const ratio = used / limit;
  const state: LimitState['state'] = opts.soft
    ? ratio >= SOFT_LIMIT_CUTOFF
      ? 'hard'
      : ratio >= 1
        ? 'soft'
        : 'ok'
    : ratio >= 1
      ? 'hard'
      : 'ok';
  return { metric, used, limit, ratio, state, unlimited: false };
}

/** The body of a 402. One shape, so the client can render every limit the same way. */
export function limitError(
  state: LimitState,
  message: string,
): { error: string; code: 'plan_limit'; metric: string; limit: number; used: number } {
  return {
    error: message,
    code: 'plan_limit',
    metric: state.metric,
    limit: state.limit,
    used: state.used,
  };
}
