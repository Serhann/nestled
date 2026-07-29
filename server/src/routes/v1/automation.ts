import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireWorkspace, can } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { limitError, type LimitState, type UsageMetric } from '../../lib/limits.js';
import { ROUTING_STRATEGIES, routingConditionsSchema } from '../../services/routing.js';
import { validateGraph, parseGraph } from '../../services/bot/validate.js';
import { simulateGraph } from '../../services/bot/engine.js';
import { botEntrySchema } from '../../services/bot/types.js';
// Plan limits are read from the shared plan catalog, which is reference data.
// eslint-disable-next-line no-restricted-imports -- shared plan catalog
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * Automation: triggers (campaigns), routing rules, and bot flows.
 *
 * All three share the `website_id` NULL = "every website in this workspace"
 * convention used by content.ts, and all three are reached only through `req.db`,
 * so a foreign id is a 404 rather than a leak.
 */

const websiteScope = z.object({ website_id: z.string().uuid().nullable().optional() });

/**
 * Trigger configuration.
 *
 * The four child tables of the pre-tenant design (trigger_actions, _events,
 * _behaviors, _platforms) are four JSONB columns here. They were 1:1 with the
 * trigger, nothing ever filtered on their individual columns, and every write
 * deleted and recreated all four rows — a join table's cost with none of its
 * benefit. What a JSONB column loses is the database's opinion about its shape, so
 * these schemas are that opinion: unknown keys are rejected, and the column stays a
 * record rather than becoming a junk drawer.
 */
const triggerActions = z
  .object({
    show_message: z.boolean().default(false),
    message_content: z.string().max(2000).nullable().default(null),
    localized_messages: z.record(z.string().max(10), z.string().max(2000)).default({}),
    open_chatbox: z.boolean().default(false),
    play_sound: z.boolean().default(false),
    /**
     * Start a bot flow instead of (or alongside) a canned message. The widget
     * carries the trigger id into conversation creation and the SERVER resolves it
     * to a flow — the widget never learns which flow, let alone its graph.
     */
    start_bot: z.string().uuid().nullable().default(null),
  })
  .strict();

const triggerEvents = z
  .object({
    on_leave_intent: z.boolean().default(false),
    on_click_link: z.boolean().default(false),
    click_selectors: z.array(z.string().max(200)).max(20).default([]),
    on_pages: z.boolean().default(false),
    page_urls: z.array(z.string().max(500)).max(50).default([]),
    on_url_parameters: z.boolean().default(false),
    url_parameters: z.record(z.string().max(64), z.string().max(200)).default({}),
    after_delay: z.boolean().default(false),
    delay_seconds: z.number().int().min(0).max(3600).default(0),
  })
  .strict();

const triggerBehaviors = z
  .object({
    show_as_website: z.boolean().default(false),
    execute_if_online: z.boolean().default(false),
    execute_on_first_visit: z.boolean().default(false),
    execute_if_no_other_trigger: z.boolean().default(false),
    country_restriction: z.array(z.string().length(2)).max(50).default([]),
  })
  .strict();

const triggerPlatforms = z
  .object({
    desktop_enabled: z.boolean().default(true),
    mobile_enabled: z.boolean().default(true),
  })
  .strict();

const triggerBody = websiteScope.extend({
  name: z.string().min(1).max(120),
  identifier: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  is_active: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  actions: triggerActions.default(triggerActions.parse({})),
  events: triggerEvents.default(triggerEvents.parse({})),
  behaviors: triggerBehaviors.default(triggerBehaviors.parse({})),
  platforms: triggerPlatforms.default(triggerPlatforms.parse({})),
});

const routingBody = websiteScope.extend({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(0).max(1000).default(0),
  is_active: z.boolean().default(true),
  conditions: routingConditionsSchema.default({}),
  strategy: z.enum(ROUTING_STRATEGIES).default('round_robin'),
  member_pool: z.array(z.string().uuid()).max(100).default([]),
});

const botBody = websiteScope.extend({
  name: z.string().min(1).max(120),
  is_active: z.boolean().default(false),
  priority: z.number().int().min(0).max(1000).default(0),
  entry: botEntrySchema.default({}),
  draft_graph: z.unknown().optional(),
});

/**
 * Object-count limits (`max_triggers`, `max_bot_flows`) are not metered flows, so
 * they have no `usage_counters` row and no LimitState to hand to limitError. The
 * 402 BODY still has to be identical to a metered one — the billing banner renders
 * every plan limit through one component, and a second shape would need a second
 * renderer that drifts. This is the seam where a count borrows that shape.
 */
/**
 * Keep only the fields the caller actually sent.
 *
 * zod's `.partial()` makes a field optional but KEEPS its `.default()`, so parsing
 * `{ name: 'x' }` against a partial schema also yields every default the schema
 * declares. On a PUT that is a data-loss bug rather than a nicety: renaming a flow
 * would quietly deactivate it and blank its entry conditions, because the update
 * body never mentioned either. Narrowing to the keys present on the wire is what
 * makes a partial update actually partial.
 */
function onlySent<T extends object>(parsed: T, body: unknown): Partial<T> {
  const sent = new Set(Object.keys((body ?? {}) as Record<string, unknown>));
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => sent.has(key)),
  ) as Partial<T>;
}

function countState(metric: string, used: number, limit: number): LimitState {
  return {
    metric: metric as UsageMetric,
    used,
    limit,
    ratio: limit > 0 ? used / limit : 0,
    state: limit > 0 && used >= limit ? 'hard' : 'ok',
    unlimited: limit <= 0,
  };
}

export async function automationV1Routes(app: FastifyInstance): Promise<void> {
  /**
   * Verify a supplied website_id belongs to THIS workspace before storing it as a
   * scope. The tenant client stops a cross-tenant read regardless; this stops a
   * dangling scope that nothing would ever match.
   */
  async function validScope(
    req: FastifyRequest,
    websiteId: string | null | undefined,
  ): Promise<boolean> {
    if (!websiteId) return true;
    const site = await req.db.websites.findUnique({ where: { id: websiteId }, select: { id: true } });
    return Boolean(site);
  }

  async function planOf(req: FastifyRequest) {
    return unscopedPrisma.plans.findUniqueOrThrow({
      where: { id: req.auth!.workspace!.planId },
      select: { max_triggers: true, max_bot_flows: true, allow_bot: true },
    });
  }

  // ── Triggers ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/triggers',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const items = await req.db.triggers.findMany({
        orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      });
      return reply.send({ items });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/triggers',
    { preHandler: [requireWorkspace, can('trigger:write')] },
    async (req, reply) => {
      const body = parseBody(triggerBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (!(await validBotAction(req, body.actions.start_bot))) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const plan = await planOf(req);
      const used = await req.db.triggers.count();
      const state = countState('triggers', used, plan.max_triggers);
      if (state.state === 'hard') {
        // HARD, unlike the conversation limit: a trigger is a durable object the
        // customer can delete to get back under, so refusing one costs them nothing
        // they cannot undo in a click.
        return reply
          .code(402)
          .send(limitError(state, `Your plan includes ${plan.max_triggers} triggers`));
      }

      try {
        const item = await req.db.triggers.create({ data: body as never });
        return reply.code(201).send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ error: 'That identifier is already used', code: 'identifier_taken' });
        }
        throw err;
      }
    },
  );

  app.put(
    '/api/v1/w/:workspaceId/triggers/:id',
    { preHandler: [requireWorkspace, can('trigger:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(triggerBody.partial(), req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (body.actions && !(await validBotAction(req, body.actions.start_bot))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      try {
        const item = await req.db.triggers.update({
          where: { id },
          data: onlySent(body, req.body) as never,
        });
        return reply.send({ item });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        if (code === 'P2002') {
          return reply.code(409).send({ error: 'That identifier is already used', code: 'identifier_taken' });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/triggers/:id',
    { preHandler: [requireWorkspace, can('trigger:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.triggers.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );

  /** A trigger may only point `start_bot` at a flow in the same workspace. */
  async function validBotAction(req: FastifyRequest, flowId: string | null | undefined): Promise<boolean> {
    if (!flowId) return true;
    const flow = await req.db.bot_flows.findUnique({ where: { id: flowId }, select: { id: true } });
    return Boolean(flow);
  }

  // ── Routing rules ─────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/routing',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const items = await req.db.routing_rules.findMany({
        orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      });
      return reply.send({ items });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/routing',
    { preHandler: [requireWorkspace, can('routing:write')] },
    async (req, reply) => {
      const body = parseBody(routingBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (!(await validPool(req, body.member_pool))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const item = await req.db.routing_rules.create({ data: body as never });
      return reply.code(201).send({ item });
    },
  );

  app.put(
    '/api/v1/w/:workspaceId/routing/:id',
    { preHandler: [requireWorkspace, can('routing:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(routingBody.partial(), req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (body.member_pool && !(await validPool(req, body.member_pool))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      try {
        const item = await req.db.routing_rules.update({
          where: { id },
          data: onlySent(body, req.body) as never,
        });
        return reply.send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/routing/:id',
    { preHandler: [requireWorkspace, can('routing:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.routing_rules.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );

  /** Every pooled member must be in this workspace, or the rule routes to nobody. */
  async function validPool(req: FastifyRequest, pool: string[]): Promise<boolean> {
    if (pool.length === 0) return true;
    const found = await req.db.workspace_members.count({ where: { id: { in: pool } } });
    return found === new Set(pool).size;
  }

  // ── Bot flows ─────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/bots',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const items = await req.db.bot_flows.findMany({
        orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      });
      return reply.send({ items });
    },
  );

  app.get(
    '/api/v1/w/:workspaceId/bots/:id',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const item = await req.db.bot_flows.findUnique({ where: { id } });
      if (!item) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ item, issues: validateGraph(item.draft_graph) });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/bots',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const body = parseBody(botBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const plan = await planOf(req);
      if (!plan.allow_bot) return reply.code(402).send(botUpsell());
      const used = await req.db.bot_flows.count();
      const state = countState('bot_flows', used, plan.max_bot_flows);
      if (state.state === 'hard') {
        return reply
          .code(402)
          .send(limitError(state, `Your plan includes ${plan.max_bot_flows} bot flows`));
      }

      const item = await req.db.bot_flows.create({
        data: { ...body, draft_graph: (body.draft_graph ?? { entry: '', nodes: [] }) as object } as never,
      });
      return reply.code(201).send({ item });
    },
  );

  /**
   * Save the draft. An INVALID draft is accepted on purpose — a builder that
   * refuses to save half-finished work is a builder people lose work in. Validity
   * is enforced at publish, and reported here so the UI can show it live.
   */
  app.put(
    '/api/v1/w/:workspaceId/bots/:id',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(botBody.partial(), req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const plan = await planOf(req);
      if (!plan.allow_bot) return reply.code(402).send(botUpsell());
      try {
        const sent = onlySent(body, req.body);
        const item = await req.db.bot_flows.update({
          where: { id },
          data: {
            ...sent,
            ...(sent.draft_graph === undefined ? {} : { draft_graph: sent.draft_graph as object }),
          } as never,
        });
        return reply.send({ item, issues: validateGraph(item.draft_graph) });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/bots/:id',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.bot_flows.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );

  /**
   * Publish: validate the draft, snapshot it as the next version, then point
   * `published_version` at that snapshot.
   *
   * Versions are IMMUTABLE, which is what lets a conversation that is already
   * halfway through a flow keep executing the graph it started on. Editing the
   * published graph in place would mean a visitor answering a question that no
   * longer exists, mid-sentence.
   */
  app.post(
    '/api/v1/w/:workspaceId/bots/:id/publish',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const plan = await planOf(req);
      if (!plan.allow_bot) return reply.code(402).send(botUpsell());

      const flow = await req.db.bot_flows.findUnique({
        where: { id },
        select: { id: true, draft_graph: true },
      });
      if (!flow) return reply.code(404).send({ error: 'Not found' });

      const issues = validateGraph(flow.draft_graph);
      if (issues.length > 0) {
        // Every problem at once. Reporting the first would turn fixing a flow into a
        // series of round trips, each revealing one more thing.
        return reply.code(422).send({ error: 'This flow cannot be published yet', issues });
      }

      const last = await req.db.bot_flow_versions.findFirst({
        where: { flow_id: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;

      const created = await req.db.bot_flow_versions.create({
        data: {
          flow_id: id,
          version,
          graph: flow.draft_graph as object,
          published_by: req.auth!.member!.id,
        } as never,
      });
      const item = await req.db.bot_flows.update({
        where: { id },
        data: { published_version: version },
      });
      await audit(req, { action: 'bot.published', targetType: 'bot_flow', targetId: id, details: { version } });
      return reply.send({ item, version: created });
    },
  );

  app.get(
    '/api/v1/w/:workspaceId/bots/:id/versions',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // bot_flow_versions is a 'parent' model in db/tenant.ts: it carries no
      // workspace_id and is protected by the flow's cascade, so the flow must be
      // resolved through the scoped client FIRST. Querying versions by flow_id alone
      // would not be tenant-scoped.
      const flow = await req.db.bot_flows.findUnique({ where: { id }, select: { id: true } });
      if (!flow) return reply.code(404).send({ error: 'Not found' });

      const versions = await req.db.bot_flow_versions.findMany({
        where: { flow_id: id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, published_at: true, published_by: true },
      });
      return reply.send({ versions });
    },
  );

  /** Rollback is just repointing `published_version` — nothing is rewritten. */
  app.post(
    '/api/v1/w/:workspaceId/bots/:id/rollback',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ version: z.number().int().min(1) }), req.body, reply);
      if (!body) return;

      const flow = await req.db.bot_flows.findUnique({ where: { id }, select: { id: true } });
      if (!flow) return reply.code(404).send({ error: 'Not found' });

      const version = await req.db.bot_flow_versions.findFirst({
        where: { flow_id: id, version: body.version },
        select: { version: true },
      });
      if (!version) return reply.code(404).send({ error: 'Not found' });

      const item = await req.db.bot_flows.update({
        where: { id },
        data: { published_version: version.version },
      });
      await audit(req, {
        action: 'bot.rolled_back',
        targetType: 'bot_flow',
        targetId: id,
        details: { version: version.version },
      });
      return reply.send({ item });
    },
  );

  /**
   * Dry-run the flow. Runs the REAL engine against an in-memory run, so what the
   * builder's Test button shows is what a visitor would get — a separate simulator
   * would agree with the runtime on the day it was written and never again.
   */
  app.post(
    '/api/v1/w/:workspaceId/bots/:id/simulate',
    { preHandler: [requireWorkspace, can('bot:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({
          /** Which visitor replies to feed it, in order. */
          inputs: z.array(z.string().max(2000)).max(20).default([]),
          /** Test the out-of-hours branch without waiting until tonight. */
          within_hours: z.boolean().default(true),
          attributes: z.record(z.string().max(64), z.unknown()).default({}),
          /** 'published' tests what visitors are getting right now. */
          source: z.enum(['draft', 'published']).default('draft'),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const flow = await req.db.bot_flows.findUnique({
        where: { id },
        select: { id: true, draft_graph: true, published_version: true },
      });
      if (!flow) return reply.code(404).send({ error: 'Not found' });

      let raw: unknown = flow.draft_graph;
      if (body.source === 'published') {
        if (flow.published_version === null) {
          return reply.code(409).send({ error: 'This flow has never been published' });
        }
        const version = await req.db.bot_flow_versions.findFirst({
          where: { flow_id: id, version: flow.published_version },
          select: { graph: true },
        });
        raw = version?.graph;
      }

      const issues = validateGraph(raw);
      if (issues.length > 0) {
        return reply.code(422).send({ error: 'This flow cannot run yet', issues });
      }
      const graph = parseGraph(raw);
      if (!graph) return reply.code(422).send({ error: 'This flow cannot run yet', issues: [] });

      const result = await simulateGraph({
        graph,
        inputs: body.inputs,
        withinHours: body.within_hours,
        attributes: body.attributes,
      });
      return reply.send(result);
    },
  );
}

function botUpsell(): { error: string; code: 'plan_limit'; metric: string; limit: number; used: number } {
  return {
    error: 'Bot flows are not included in your plan',
    code: 'plan_limit',
    metric: 'bot_flows',
    limit: 0,
    used: 0,
  };
}
