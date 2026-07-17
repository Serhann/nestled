import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
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
    const rows = await query(`SELECT * FROM knowledge_base ORDER BY priority DESC, created_at DESC`);
    return reply.send({ items: rows.rows });
  });

  app.post('/api/knowledge-base', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(kbBody, req.body, reply);
    if (!body) return;
    const created = await queryOne(
      `INSERT INTO knowledge_base (question, answer, category, keywords, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.question, body.answer, body.category, body.keywords, body.priority, body.is_active],
    );
    await audit(req, { action: 'kb.create', targetType: 'knowledge_base', targetId: created?.id as string });
    return reply.code(201).send({ item: created });
  });

  app.put('/api/knowledge-base/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(kbBody, req.body, reply);
    if (!body) return;
    const updated = await queryOne(
      `UPDATE knowledge_base
          SET question = $1, answer = $2, category = $3, keywords = $4,
              priority = $5, is_active = $6, updated_at = now()
        WHERE id = $7 RETURNING *`,
      [body.question, body.answer, body.category, body.keywords, body.priority, body.is_active, id],
    );
    if (!updated) return reply.code(404).send({ error: 'Item not found' });
    await audit(req, { action: 'kb.update', targetType: 'knowledge_base', targetId: id });
    return reply.send({ item: updated });
  });

  app.delete('/api/knowledge-base/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await queryOne(`DELETE FROM knowledge_base WHERE id = $1 RETURNING id`, [id]);
    if (!deleted) return reply.code(404).send({ error: 'Item not found' });
    await audit(req, { action: 'kb.delete', targetType: 'knowledge_base', targetId: id });
    return reply.send({ ok: true });
  });
}
