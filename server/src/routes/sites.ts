import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

// The catalog of quick-action intents an admin may put on a site. The reply
// logic for each lives server-side in conversations.ts (QUICK_INTENTS); here we
// only validate that a configured action references a known intent.
const INTENTS = [
  'where', 'status', 'late', 'change_address', 'missing_item', 'wrong', 'refund',
  'tech_issue', 'billing', 'demo', 'pricing', 'human',
] as const;

const quickActionCfg = z.object({
  intent: z.enum(INTENTS),
  label: z.string().max(60).optional(),
});

const siteBody = z.object({
  key: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes'),
  name: z.string().min(1).max(120),
  is_active: z.boolean().default(true),
  primary_color: z.string().max(20).nullable().default(null),
  widget_title: z.string().max(120).nullable().default(null),
  welcome_message: z.string().max(500).nullable().default(null),
  widget_position: z.enum(['left', 'right']).nullable().default(null),
  quick_actions: z.array(quickActionCfg).default([]),
});

/** Site manager (admin): per-site widget appearance + quick-action config. */
export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sites', { preHandler: requireAdmin }, async (_req, reply) => {
    const sites = await prisma.sites.findMany({ orderBy: { created_at: 'asc' } });
    return reply.send({ sites });
  });

  app.post('/api/sites', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(siteBody, req.body, reply);
    if (!body) return;
    const dupe = await prisma.sites.findUnique({ where: { key: body.key }, select: { id: true } });
    if (dupe) return reply.code(409).send({ error: 'That site key already exists' });
    const created = await prisma.sites.create({
      data: {
        key: body.key,
        name: body.name,
        is_active: body.is_active,
        primary_color: body.primary_color,
        widget_title: body.widget_title,
        welcome_message: body.welcome_message,
        widget_position: body.widget_position,
        quick_actions: body.quick_actions as object,
      },
    });
    await audit(req, { action: 'site.create', targetType: 'site', targetId: created.id });
    return reply.code(201).send({ site: created });
  });

  app.put('/api/sites/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(siteBody, req.body, reply);
    if (!body) return;
    // Guard the unique key against collisions with a different row.
    const byKey = await prisma.sites.findUnique({ where: { key: body.key }, select: { id: true } });
    if (byKey && byKey.id !== id) return reply.code(409).send({ error: 'That site key already exists' });
    const updated = await prisma.sites
      .update({
        where: { id },
        data: {
          key: body.key,
          name: body.name,
          is_active: body.is_active,
          primary_color: body.primary_color,
          widget_title: body.widget_title,
          welcome_message: body.welcome_message,
          widget_position: body.widget_position,
          quick_actions: body.quick_actions as object,
          updated_at: new Date(),
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Site not found' });
    await audit(req, { action: 'site.update', targetType: 'site', targetId: id });
    return reply.send({ site: updated });
  });

  app.delete('/api/sites/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await prisma.sites.deleteMany({ where: { id } });
    if (deleted.count === 0) return reply.code(404).send({ error: 'Site not found' });
    await audit(req, { action: 'site.delete', targetType: 'site', targetId: id });
    return reply.send({ ok: true });
  });
}
