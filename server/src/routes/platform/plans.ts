import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { invalidateWorkspaceCache } from '../../plugins/auth.js';
import { platformRead, platformWrite } from './guards.js';

/**
 * The plan catalog, and per-workspace exceptions.
 *
 * A per-workspace override is a PRIVATE PLAN ROW, not a bag of overrides hung off
 * the workspace. The reasons are worth stating, because "just add an overrides
 * JSONB to workspaces" looks simpler:
 *
 *   - Every limit check in the product reads `workspace.plan.*` (see lib/limits.ts
 *     and the auth plugin's cache). A second source of truth would mean auditing
 *     forty call sites to teach each of them to merge, and the first one anybody
 *     forgot would be a customer silently held to a limit sales told them they did
 *     not have.
 *   - `plans.is_public = false` already exists for exactly this. A non-public plan
 *     is invisible in the pricing page and the upgrade flow but is a first-class
 *     row everywhere else.
 *   - The exception is then legible: it has a code, a created_at, and shows up on
 *     the workspace's plan tab as "custom", rather than being a diff nobody can see
 *     without opening a JSON column.
 *
 * Editing an override edits that private row in place, but ONLY while it is used by
 * this workspace alone — the guard below is what stops a second workspace being
 * repointed at someone else's exception and then silently inheriting future edits.
 */

/** Every column a staff member may set on a plan. `code` is immutable after create. */
const planFields = z.object({
  name: z.string().min(1).max(120).optional(),
  is_public: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
  is_trial_default: z.boolean().optional(),
  stripe_product_id: z.string().max(120).nullable().optional(),
  stripe_price_monthly_id: z.string().max(120).nullable().optional(),
  stripe_price_yearly_id: z.string().max(120).nullable().optional(),
  price_monthly_cents: z.number().int().min(0).optional(),
  price_yearly_cents: z.number().int().min(0).optional(),
  included_seats: z.number().int().min(0).optional(),
  max_seats: z.number().int().min(0).optional(),
  max_websites: z.number().int().min(0).optional(),
  max_conversations_month: z.number().int().min(0).optional(),
  max_ai_replies_month: z.number().int().min(0).optional(),
  max_kb_entries: z.number().int().min(0).optional(),
  max_bot_flows: z.number().int().min(0).optional(),
  max_triggers: z.number().int().min(0).optional(),
  storage_mb: z.number().int().min(0).optional(),
  retention_days: z.number().int().min(0).optional(),
  allow_remove_branding: z.boolean().optional(),
  allow_live_view: z.boolean().optional(),
  allow_bot: z.boolean().optional(),
  /** The escape hatch for a feature flag that has no column yet. */
  features: z.record(z.string(), z.unknown()).optional(),
});

export async function platformPlanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/plans', { preHandler: platformRead }, async (_req, reply) => {
    const plans = await unscopedPrisma.plans.findMany({
      orderBy: [{ is_public: 'desc' }, { sort_order: 'asc' }],
      include: { _count: { select: { workspaces: true, subscriptions: true } } },
    });
    return reply.send({ plans });
  });

  app.post('/platform/plans', { preHandler: platformWrite('billing') }, async (req, reply) => {
    const body = parseBody(
      planFields.extend({
        code: z
          .string()
          .min(2)
          .max(60)
          .regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, hyphen and underscore only'),
        name: z.string().min(1).max(120),
      }),
      req.body,
      reply,
    );
    if (!body) return;

    if (await unscopedPrisma.plans.findUnique({ where: { code: body.code }, select: { id: true } })) {
      return reply.code(409).send({ error: 'That plan code already exists' });
    }
    const plan = await unscopedPrisma.plans.create({ data: body as never });
    await audit(req, { action: 'platform.plan_created', targetType: 'plan', targetId: plan.id, details: { code: body.code } });
    return reply.code(201).send({ plan });
  });

  app.patch('/platform/plans/:id', { preHandler: platformWrite('billing') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(planFields, req.body, reply);
    if (!body) return;

    const existing = await unscopedPrisma.plans.findUnique({
      where: { id },
      select: { id: true, code: true, is_trial_default: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    // "Exactly one row is the trial default" is an invariant the signup path relies
    // on (routes/v1/auth.ts picks it by findFirst). Enforced here rather than left
    // to whoever remembers, because the failure — new signups landing on whichever
    // row Postgres returned first — is silent.
    if (body.is_trial_default === true) {
      await unscopedPrisma.plans.updateMany({
        where: { is_trial_default: true, id: { not: id } },
        data: { is_trial_default: false },
      });
    }

    const plan = await unscopedPrisma.plans.update({ where: { id }, data: body as never });

    // Every workspace on this plan has a cached copy in the auth plugin.
    const affected = await unscopedPrisma.workspaces.findMany({
      where: { plan_id: id },
      select: { id: true },
    });
    for (const ws of affected) invalidateWorkspaceCache(ws.id);

    await audit(req, {
      action: 'platform.plan_updated',
      targetType: 'plan',
      targetId: id,
      details: { code: existing.code, fields: Object.keys(body), workspaces_affected: affected.length },
    });
    return reply.send({ plan, workspaces_affected: affected.length });
  });

  /**
   * Grant one workspace an exception.
   *
   * Idempotent in the way that matters: called twice, the second call edits the
   * override created by the first rather than stacking a second private plan.
   */
  app.put(
    '/platform/workspaces/:id/plan-override',
    { preHandler: platformWrite('billing') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        planFields.extend({ reason: z.string().min(3).max(500) }),
        req.body,
        reply,
      );
      if (!body) return;
      const { reason, ...overrides } = body;
      if (Object.keys(overrides).length === 0) {
        return reply.code(400).send({ error: 'Nothing to override' });
      }

      const ws = await unscopedPrisma.workspaces.findUnique({
        where: { id },
        select: { id: true, slug: true, plan: true },
      });
      if (!ws) return reply.code(404).send({ error: 'Not found' });

      const usedByOthers = await unscopedPrisma.workspaces.count({
        where: { plan_id: ws.plan.id, id: { not: id } },
      });
      const isExclusiveOverride = !ws.plan.is_public && usedByOthers === 0;

      const plan = isExclusiveOverride
        ? // Already on its own private plan: edit it in place, so a second
          // adjustment does not leave a trail of orphaned custom rows.
          await unscopedPrisma.plans.update({ where: { id: ws.plan.id }, data: overrides as never })
        : await (async () => {
            // Clone the current plan so the override starts from what the customer
            // has TODAY. Starting from defaults would silently take away whatever
            // their paid tier already granted.
            const {
              id: _id,
              code: _code,
              created_at: _createdAt,
              updated_at: _updatedAt,
              is_trial_default: _trialDefault,
              ...base
            } = ws.plan;
            const created = await unscopedPrisma.plans.create({
              data: {
                ...base,
                ...overrides,
                code: `custom_${ws.slug}_${Date.now().toString(36)}`,
                name: overrides.name ?? `${ws.plan.name} (custom)`,
                is_public: false,
                is_trial_default: false,
              } as never,
            });
            await unscopedPrisma.workspaces.update({
              where: { id },
              data: { plan_id: created.id },
            });
            return created;
          })();

      invalidateWorkspaceCache(id);
      await audit(req, {
        action: 'platform.plan_override',
        workspaceId: id,
        targetType: 'plan',
        targetId: plan.id,
        details: { reason, fields: Object.keys(overrides), created: !isExclusiveOverride },
      });
      return reply.send({ plan, created: !isExclusiveOverride });
    },
  );

  /** Drop the exception and put the workspace back on a catalog plan. */
  app.delete(
    '/platform/workspaces/:id/plan-override',
    { preHandler: platformWrite('billing') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({ plan_code: z.string().min(1).max(60), reason: z.string().min(3).max(500) }),
        req.body,
        reply,
      );
      if (!body) return;

      const [ws, target] = await Promise.all([
        unscopedPrisma.workspaces.findUnique({ where: { id }, select: { plan: true } }),
        unscopedPrisma.plans.findUnique({ where: { code: body.plan_code }, select: { id: true, code: true } }),
      ]);
      if (!ws) return reply.code(404).send({ error: 'Not found' });
      if (!target) return reply.code(400).send({ error: 'No such plan code' });

      await unscopedPrisma.workspaces.update({ where: { id }, data: { plan_id: target.id } });

      // Tidy up the abandoned private row, but only once nothing points at it —
      // plans.id is an FK target from subscriptions too.
      if (!ws.plan.is_public) {
        const stillUsed = await unscopedPrisma.workspaces.count({ where: { plan_id: ws.plan.id } });
        const subscribed = await unscopedPrisma.subscriptions.count({ where: { plan_id: ws.plan.id } });
        if (stillUsed === 0 && subscribed === 0) {
          await unscopedPrisma.plans.delete({ where: { id: ws.plan.id } }).catch(() => undefined);
        }
      }

      invalidateWorkspaceCache(id);
      await audit(req, {
        action: 'platform.plan_override_removed',
        workspaceId: id,
        targetType: 'plan',
        targetId: target.id,
        details: { reason: body.reason, moved_to: target.code },
      });
      return reply.send({ ok: true, plan_code: target.code });
    },
  );
}
