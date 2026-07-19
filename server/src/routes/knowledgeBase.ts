import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAgent, requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const kbBody = z.object({
  question: z.string().min(1).max(1000),
  answer: z.string().min(1).max(8000),
  category: z.string().max(100).default('general'),
  keywords: z.array(z.string().max(100)).default([]),
  priority: z.number().int().min(0).max(100).default(0),
  is_active: z.boolean().default(true),
});

export async function knowledgeBaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/knowledge-base', { preHandler: requireAgent }, async (_req, reply) => {
    const items = await prisma.knowledge_base.findMany({
      orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
    });
    return reply.send({ items });
  });

  app.post('/api/knowledge-base', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(kbBody, req.body, reply);
    if (!body) return;
    const created = await prisma.knowledge_base.create({
      data: {
        question: body.question,
        answer: body.answer,
        category: body.category,
        keywords: body.keywords,
        priority: body.priority,
        is_active: body.is_active,
      },
    });
    await audit(req, { action: 'kb.create', targetType: 'knowledge_base', targetId: created.id });
    return reply.code(201).send({ item: created });
  });

  app.put('/api/knowledge-base/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(kbBody, req.body, reply);
    if (!body) return;
    const updated = await prisma.knowledge_base
      .update({
        where: { id },
        data: {
          question: body.question,
          answer: body.answer,
          category: body.category,
          keywords: body.keywords,
          priority: body.priority,
          is_active: body.is_active,
          updated_at: new Date(),
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Item not found' });
    await audit(req, { action: 'kb.update', targetType: 'knowledge_base', targetId: id });
    return reply.send({ item: updated });
  });

  app.delete('/api/knowledge-base/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await prisma.knowledge_base.deleteMany({ where: { id } });
    if (deleted.count === 0) return reply.code(404).send({ error: 'Item not found' });
    await audit(req, { action: 'kb.delete', targetType: 'knowledge_base', targetId: id });
    return reply.send({ ok: true });
  });
}
