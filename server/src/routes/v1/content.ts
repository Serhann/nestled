import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireWorkspace, can } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
// Plan limits are read from the shared plan catalog, which is reference data.
// eslint-disable-next-line no-restricted-imports -- shared plan catalog
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * Knowledge base, canned responses and conversation starters.
 *
 * All three share one shape: `website_id` NULL means "every website in this
 * workspace". That replaces the old `sites String[]`, which could not be a foreign
 * key — so nothing stopped it naming a site that had been deleted, and nothing
 * stopped a validator's hardcoded enum rejecting a site that existed.
 */

const websiteScope = z.object({ website_id: z.string().uuid().nullable().optional() });

const kbBody = websiteScope.extend({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(8000),
  category: z.string().max(60).default('general'),
  keywords: z.array(z.string().max(60)).max(30).default([]),
  priority: z.number().int().min(0).max(1000).default(0),
  is_active: z.boolean().default(true),
});

const cannedBody = websiteScope.extend({
  shortcut: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(4000),
});

const starterBody = websiteScope.extend({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, dashes and underscores'),
  label: z.string().min(1).max(120),
  message: z.string().max(1000).nullable().optional(),
  kind: z.enum(['auto', 'human', 'bot']).default('auto'),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        required: z.boolean().default(false),
      }),
    )
    .max(10)
    .default([]),
  icon: z.string().max(40).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
  is_active: z.boolean().default(true),
});

export async function contentV1Routes(app: FastifyInstance): Promise<void> {
  /**
   * Verify a supplied website_id belongs to THIS workspace before storing it as a
   * scope. The tenant client would stop a cross-tenant READ regardless, but a
   * foreign id stored in `website_id` would be a dangling scope nothing matches.
   */
  async function validScope(
    req: FastifyRequest,
    websiteId: string | null | undefined,
  ): Promise<boolean> {
    if (!websiteId) return true;
    const site = await req.db.websites.findUnique({ where: { id: websiteId }, select: { id: true } });
    return Boolean(site);
  }

  // ── Knowledge base ────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/kb',
    { preHandler: [requireWorkspace, can('kb:read')] },
    async (req, reply) => {
      const items = await req.db.knowledge_base.findMany({
        orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
      });
      return reply.send({ items });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/kb',
    { preHandler: [requireWorkspace, can('kb:write')] },
    async (req, reply) => {
      const body = parseBody(kbBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }

      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { max_kb_entries: true },
      });
      const used = await req.db.knowledge_base.count();
      if (used >= plan.max_kb_entries) {
        return reply.code(402).send({
          error: `Your plan includes ${plan.max_kb_entries} knowledge base entries`,
          code: 'plan_limit',
          metric: 'kb_entries',
          limit: plan.max_kb_entries,
          used,
        });
      }

      const item = await req.db.knowledge_base.create({ data: body as never });
      return reply.code(201).send({ item });
    },
  );

  app.put(
    '/api/v1/w/:workspaceId/kb/:id',
    { preHandler: [requireWorkspace, can('kb:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(kbBody.partial(), req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      try {
        const item = await req.db.knowledge_base.update({ where: { id }, data: body as never });
        return reply.send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/kb/:id',
    { preHandler: [requireWorkspace, can('kb:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.knowledge_base.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );

  // ── Canned responses ──────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/canned',
    { preHandler: [requireWorkspace, can('canned:read')] },
    async (req, reply) => {
      // Scoped server-side, unlike the old build where the endpoint returned every
      // site's responses and the CLIENT filtered them — which meant the filter was
      // cosmetic and the data was already on the wire.
      const items = await req.db.canned_responses.findMany({ orderBy: { shortcut: 'asc' } });
      return reply.send({ items });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/canned',
    { preHandler: [requireWorkspace, can('canned:write')] },
    async (req, reply) => {
      const body = parseBody(cannedBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      try {
        const item = await req.db.canned_responses.create({ data: body as never });
        return reply.code(201).send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ error: 'That shortcut is already used', code: 'shortcut_taken' });
        }
        throw err;
      }
    },
  );

  app.put(
    '/api/v1/w/:workspaceId/canned/:id',
    { preHandler: [requireWorkspace, can('canned:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(cannedBody.partial(), req.body, reply);
      if (!body) return;
      try {
        const item = await req.db.canned_responses.update({ where: { id }, data: body as never });
        return reply.send({ item });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        if (code === 'P2002') {
          return reply.code(409).send({ error: 'That shortcut is already used', code: 'shortcut_taken' });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/canned/:id',
    { preHandler: [requireWorkspace, can('canned:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.canned_responses.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );

  // ── Conversation starters ─────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/starters',
    { preHandler: [requireWorkspace, can('kb:read')] },
    async (req, reply) => {
      const items = await req.db.starters.findMany({
        orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      });
      return reply.send({ items });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/starters',
    { preHandler: [requireWorkspace, can('starter:write')] },
    async (req, reply) => {
      const body = parseBody(starterBody, req.body, reply);
      if (!body) return;
      if (!(await validScope(req, body.website_id))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      try {
        const item = await req.db.starters.create({ data: body as never });
        return reply.code(201).send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ error: 'That key is already used', code: 'key_taken' });
        }
        throw err;
      }
    },
  );

  app.put(
    '/api/v1/w/:workspaceId/starters/:id',
    { preHandler: [requireWorkspace, can('starter:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(starterBody.partial(), req.body, reply);
      if (!body) return;
      try {
        const item = await req.db.starters.update({ where: { id }, data: body as never });
        return reply.send({ item });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/starters/:id',
    { preHandler: [requireWorkspace, can('starter:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { count } = await req.db.starters.deleteMany({ where: { id } });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ok: true });
    },
  );
}
