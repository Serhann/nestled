import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAgent, requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const fieldDef = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers, underscore'),
  label: z.string().min(1).max(80),
  required: z.boolean().default(false),
});

const qaBody = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers, underscore'),
  label: z.string().min(1).max(80),
  kind: z.enum(['auto', 'human']).default('human'),
  visitor_template: z.string().max(2000).default(''),
  reply_template: z.string().max(4000).default(''),
  suggestion: z.string().max(400).nullable().default(null),
  fields: z.array(fieldDef).default([]),
  priority: z.number().int().min(0).max(10000).default(0),
  is_active: z.boolean().default(true),
});

/** Quick actions: agents read (Site manager picker); admins manage. */
export async function quickActionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/quick-actions', { preHandler: requireAgent }, async (_req, reply) => {
    const items = await prisma.quick_actions.findMany({ orderBy: [{ priority: 'asc' }, { created_at: 'asc' }] });
    return reply.send({ items });
  });

  app.post('/api/quick-actions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(qaBody, req.body, reply);
    if (!body) return;
    const dupe = await prisma.quick_actions.findUnique({ where: { key: body.key }, select: { id: true } });
    if (dupe) return reply.code(409).send({ error: 'That key already exists' });
    const created = await prisma.quick_actions.create({
      data: {
        key: body.key,
        label: body.label,
        kind: body.kind,
        visitor_template: body.visitor_template,
        reply_template: body.reply_template,
        suggestion: body.suggestion,
        fields: body.fields as object,
        priority: body.priority,
        is_active: body.is_active,
      },
    });
    await audit(req, { action: 'quick_action.create', targetType: 'quick_action', targetId: created.id });
    return reply.code(201).send({ item: created });
  });

  app.put('/api/quick-actions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(qaBody, req.body, reply);
    if (!body) return;
    const byKey = await prisma.quick_actions.findUnique({ where: { key: body.key }, select: { id: true } });
    if (byKey && byKey.id !== id) return reply.code(409).send({ error: 'That key already exists' });
    const updated = await prisma.quick_actions
      .update({
        where: { id },
        data: {
          key: body.key,
          label: body.label,
          kind: body.kind,
          visitor_template: body.visitor_template,
          reply_template: body.reply_template,
          suggestion: body.suggestion,
          fields: body.fields as object,
          priority: body.priority,
          is_active: body.is_active,
          updated_at: new Date(),
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'quick_action.update', targetType: 'quick_action', targetId: id });
    return reply.send({ item: updated });
  });

  app.delete('/api/quick-actions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await prisma.quick_actions.deleteMany({ where: { id } });
    if (deleted.count === 0) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'quick_action.delete', targetType: 'quick_action', targetId: id });
    return reply.send({ ok: true });
  });
}
