import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAgent, requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const cannedBody = z.object({
  shortcut: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(4000),
});

/** Canned responses: agents read (for `/` autocomplete); admins manage. */
export async function cannedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/canned-responses', { preHandler: requireAgent }, async (_req, reply) => {
    const items = await prisma.canned_responses.findMany({ orderBy: { shortcut: 'asc' } });
    return reply.send({ items });
  });

  app.post('/api/canned-responses', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(cannedBody, req.body, reply);
    if (!body) return;
    const existing = await prisma.canned_responses.findUnique({ where: { shortcut: body.shortcut } });
    if (existing) return reply.code(409).send({ error: 'That shortcut already exists' });
    const created = await prisma.canned_responses.create({
      data: { shortcut: body.shortcut, title: body.title, content: body.content },
    });
    await audit(req, { action: 'canned.create', targetType: 'canned_response', targetId: created.id });
    return reply.code(201).send({ item: created });
  });

  app.put('/api/canned-responses/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(cannedBody, req.body, reply);
    if (!body) return;
    const updated = await prisma.canned_responses
      .update({
        where: { id },
        data: { shortcut: body.shortcut, title: body.title, content: body.content, updated_at: new Date() },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'canned.update', targetType: 'canned_response', targetId: id });
    return reply.send({ item: updated });
  });

  app.delete('/api/canned-responses/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await prisma.canned_responses.deleteMany({ where: { id } });
    if (deleted.count === 0) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'canned.delete', targetType: 'canned_response', targetId: id });
    return reply.send({ ok: true });
  });
}
