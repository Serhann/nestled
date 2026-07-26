// Usage counters are written from request paths, background jobs and the AI
// service, each already knowing its workspace; and the atomic upsert below is a
// raw statement, so a scoped client would add nothing.
// eslint-disable-next-line no-restricted-imports -- atomic counter upsert for a caller-supplied workspace
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * Plan usage metering.
 *
 * The counters in `usage_counters` are what the limiter reads — never a COUNT(*)
 * over the source table, which would get slower exactly as a customer becomes more
 * valuable.
 *
 * `conversations` is incremented inside the same transaction as the conversation
 * insert (see the widget route), so that number can never drift from reality.
 * Everything else is a best-effort post-hoc upsert: losing one AI-reply tick is
 * cheaper than failing the reply.
 */

export type UsageMetric =
  | 'conversations'
  | 'ai_replies'
  | 'ai_tokens_in'
  | 'ai_tokens_out'
  | 'emails'
  | 'storage_bytes';

/** Month start in UTC. `storage_bytes` is a level, not a flow, so it uses the epoch. */
export function periodStart(metric: UsageMetric, now = new Date()): Date {
  if (metric === 'storage_bytes') return new Date(0);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Add to a counter atomically.
 *
 * A raw ON CONFLICT is used rather than Prisma's upsert because two concurrent
 * requests must not lose an increment — read-modify-write here would silently
 * under-count a customer's usage, which is the one direction we cannot afford.
 */
export async function bumpUsage(
  workspaceId: string,
  metric: UsageMetric,
  delta = 1,
  tx?: { $executeRaw: typeof unscopedPrisma.$executeRaw },
): Promise<void> {
  const client = tx ?? unscopedPrisma;
  const period = periodStart(metric);
  try {
    await client.$executeRaw`
      INSERT INTO usage_counters (workspace_id, metric, period_start, value, updated_at)
      VALUES (${workspaceId}::uuid, ${metric}, ${period}::date, ${delta}::bigint, now())
      ON CONFLICT (workspace_id, metric, period_start)
      DO UPDATE SET value = usage_counters.value + ${delta}::bigint, updated_at = now()
    `;
  } catch {
    // Metering must never break the operation it measures.
  }
}

export async function readUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
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
  return row ? Number(row.value) : 0;
}

export interface PlanLimitFailure {
  metric: UsageMetric;
  limit: number;
  used: number;
  /** Soft metrics keep working past 100% — see the conversation path. */
  soft: boolean;
}

/**
 * Check a metered limit.
 *
 * `conversations` is SOFT: at 100% it keeps accepting and warns, and only stops at
 * 120%. A hard stop there would mean a customer's widget silently dropping real
 * leads the moment they got popular, which is both the worst possible moment and
 * the worst possible impression. `ai_replies` is HARD, because each call has a real
 * per-message cost to us.
 */
export async function checkUsageLimit(
  workspaceId: string,
  metric: UsageMetric,
  limit: number,
): Promise<PlanLimitFailure | null> {
  const used = await readUsage(workspaceId, metric);
  const soft = metric === 'conversations';
  const ceiling = soft ? Math.ceil(limit * 1.2) : limit;
  if (used < ceiling) return null;
  return { metric, limit, used, soft };
}
