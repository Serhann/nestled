import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
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
    const rows = await query(`SELECT * FROM canned_responses ORDER BY shortcut ASC`);
    return reply.send({ items: rows.rows });
  });

  app.post('/api/canned-responses', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(cannedBody, req.body, reply);
    if (!body) return;
    const existing = await queryOne('SELECT id FROM canned_responses WHERE shortcut = $1', [body.shortcut]);
    if (existing) return reply.code(409).send({ error: 'That shortcut already exists' });
    const created = await queryOne(
      `INSERT INTO canned_responses (shortcut, title, content) VALUES ($1, $2, $3) RETURNING *`,
      [body.shortcut, body.title, body.content],
    );
    await audit(req, { action: 'canned.create', targetType: 'canned_response', targetId: created?.id as string });
    return reply.code(201).send({ item: created });
  });

  app.put('/api/canned-responses/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(cannedBody, req.body, reply);
    if (!body) return;
    const updated = await queryOne(
      `UPDATE canned_responses SET shortcut = $1, title = $2, content = $3, updated_at = now()
        WHERE id = $4 RETURNING *`,
      [body.shortcut, body.title, body.content, id],
    );
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'canned.update', targetType: 'canned_response', targetId: id });
    return reply.send({ item: updated });
  });

  app.delete('/api/canned-responses/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await queryOne('DELETE FROM canned_responses WHERE id = $1 RETURNING id', [id]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'canned.delete', targetType: 'canned_response', targetId: id });
    return reply.send({ ok: true });
  });
}
