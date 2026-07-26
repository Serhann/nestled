import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { platformRead } from './guards.js';

/**
 * The dunning worklist.
 *
 * A queue, not a dashboard. Every row is a workspace somebody should contact today,
 * ordered by how much money is at stake and how long it has been wrong — because
 * the failure mode of a billing "overview" is that it is admired weekly and acted on
 * never.
 *
 * Five buckets, each a different conversation:
 *
 *   payment_failed  Stripe could not charge them. They usually do not know.
 *   grace           Failed, but the widget is still serving. A deadline exists.
 *   trial_ending    Converts or does not; the window to intervene is now.
 *   trial_expired   Dropped to free. The most recoverable segment on the list.
 *   pending_purge   Cancelled, data deletion scheduled. Irreversible after.
 *
 * Amounts come from `invoices`, which mirrors Stripe. Stripe remains the source of
 * truth — this list is for deciding who to talk to, never for deciding what to
 * charge.
 */

export type DunningBucket =
  | 'payment_failed'
  | 'grace'
  | 'trial_ending'
  | 'trial_expired'
  | 'pending_purge';

const TRIAL_ENDING_DAYS = 5;

interface WorklistRow {
  bucket: DunningBucket;
  workspace_id: string;
  name: string;
  slug: string;
  plan_code: string;
  subscription_status: string;
  /** Days until the deadline; negative means it has already passed. */
  days_remaining: number | null;
  deadline: string | null;
  amount_due_cents: number;
  currency: string | null;
  owner_email: string | null;
  last_invoice_url: string | null;
  /** Position in the queue. Higher is more urgent; see `score` below. */
  priority: number;
}

/**
 * Urgency = money at stake, amplified by how overdue it is and by how permanent the
 * outcome would be. A pending purge with no money attached still outranks a large
 * unpaid invoice, because one is recoverable tomorrow and the other is not.
 */
function score(bucket: DunningBucket, amountCents: number, daysRemaining: number | null): number {
  const weight: Record<DunningBucket, number> = {
    pending_purge: 10_000,
    payment_failed: 4_000,
    grace: 3_000,
    trial_ending: 1_500,
    trial_expired: 1_000,
  };
  const overdue = daysRemaining !== null && daysRemaining < 0 ? Math.min(-daysRemaining, 60) * 20 : 0;
  const urgency = daysRemaining !== null && daysRemaining >= 0 ? Math.max(0, 30 - daysRemaining) * 10 : 0;
  return weight[bucket] + overdue + urgency + Math.min(amountCents / 100, 2_000);
}

function daysUntil(date: Date | null): number | null {
  if (!date) return null;
  return Math.round((date.getTime() - Date.now()) / 86_400_000);
}

export async function platformDunningRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/dunning', { preHandler: platformRead }, async (req, reply) => {
    const parsed = z
      .object({ bucket: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(300).default(100) })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.issues });
    }
    const { bucket: wanted, limit } = parsed.data;

    const trialCutoff = new Date(Date.now() + TRIAL_ENDING_DAYS * 86_400_000);

    const workspaces = await unscopedPrisma.workspaces.findMany({
      where: {
        deleted_at: null,
        OR: [
          { subscription_status: { in: ['past_due', 'unpaid', 'suspended', 'trial_expired'] } },
          { grace_until: { not: null } },
          { purge_after: { not: null } },
          { subscription_status: 'trialing', trial_ends_at: { lte: trialCutoff } },
        ],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        subscription_status: true,
        trial_ends_at: true,
        grace_until: true,
        purge_after: true,
        plan: { select: { code: true } },
        subscription: { select: { status: true, current_period_end: true, cancel_at_period_end: true } },
        members: {
          where: { role: 'owner', status: 'active' },
          take: 1,
          select: { user: { select: { email: true } } },
        },
        invoices: {
          where: { status: { in: ['open', 'uncollectible', 'past_due'] } },
          orderBy: { created_at: 'desc' },
          select: { amount_due: true, amount_paid: true, currency: true, hosted_invoice_url: true },
        },
      },
    });

    const rows: WorklistRow[] = [];
    for (const ws of workspaces) {
      const outstanding = ws.invoices.reduce((n, i) => n + Math.max(0, i.amount_due - i.amount_paid), 0);
      const currency = ws.invoices[0]?.currency ?? null;
      const invoiceUrl = ws.invoices[0]?.hosted_invoice_url ?? null;
      const owner = ws.members[0]?.user.email ?? null;

      // A workspace can qualify for several buckets at once (past_due AND in
      // grace AND scheduled for purge). It appears once, in the most urgent —
      // a worklist that lists the same customer three times is a worklist people
      // stop trusting.
      const bucket: DunningBucket | null = ws.purge_after
        ? 'pending_purge'
        : ws.grace_until && ws.grace_until > new Date()
          ? 'grace'
          : ['past_due', 'unpaid', 'suspended'].includes(ws.subscription_status)
            ? 'payment_failed'
            : ws.subscription_status === 'trial_expired'
              ? 'trial_expired'
              : ws.subscription_status === 'trialing'
                ? 'trial_ending'
                : null;
      if (!bucket) continue;

      const deadline =
        bucket === 'pending_purge'
          ? ws.purge_after
          : bucket === 'grace'
            ? ws.grace_until
            : bucket === 'trial_ending'
              ? ws.trial_ends_at
              : bucket === 'payment_failed'
                ? (ws.subscription?.current_period_end ?? null)
                : null;
      const remaining = daysUntil(deadline);

      rows.push({
        bucket,
        workspace_id: ws.id,
        name: ws.name,
        slug: ws.slug,
        plan_code: ws.plan.code,
        subscription_status: ws.subscription_status,
        days_remaining: remaining,
        deadline: deadline?.toISOString() ?? null,
        amount_due_cents: outstanding,
        currency,
        owner_email: owner,
        last_invoice_url: invoiceUrl,
        priority: score(bucket, outstanding, remaining),
      });
    }

    const filtered = wanted ? rows.filter((r) => r.bucket === wanted) : rows;
    filtered.sort((a, b) => b.priority - a.priority);

    const totals: Record<string, { count: number; amount_due_cents: number }> = {};
    for (const row of rows) {
      const t = (totals[row.bucket] ??= { count: 0, amount_due_cents: 0 });
      t.count += 1;
      t.amount_due_cents += row.amount_due_cents;
    }

    return reply.send({
      rows: filtered.slice(0, limit),
      totals,
      total_at_risk_cents: rows.reduce((n, r) => n + r.amount_due_cents, 0),
    });
  });
}
