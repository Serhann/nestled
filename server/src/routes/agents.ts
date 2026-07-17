import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { query, queryOne } from '../db/pool.js';
import { requireAgent, requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../lib/audit.js';

const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const createBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['admin', 'agent']).default('agent'),
});

const updateBody = z
  .object({
    name: z.string().min(1).max(120),
    role: z.enum(['admin', 'agent']),
    password: z.string().min(8),
  })
  .partial();

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // Any agent can see the roster (names/roles/presence) — needed for assignment UI.
  app.get('/api/agents', { preHandler: requireAgent }, async (_req, reply) => {
    const rows = await query(
      `SELECT id, name, email, role, avatar_url, is_online, last_seen, created_at
         FROM agents ORDER BY created_at ASC`,
    );
    return reply.send({ agents: rows.rows });
  });

  // Admin-only creation (replaces the old open signup trigger).
  app.post('/api/agents', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(createBody, req.body, reply);
    if (!body) return;

    const existing = await queryOne('SELECT id FROM agents WHERE email = $1', [
      body.email.toLowerCase(),
    ]);
    if (existing) return reply.code(409).send({ error: 'An agent with that email already exists' });

    const password_hash = await hashPassword(body.password);
    const created = await queryOne(
      `INSERT INTO agents (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [body.name, body.email.toLowerCase(), password_hash, body.role],
    );
    await audit(req, { action: 'agent.create', targetType: 'agent', targetId: created?.id as string });
    return reply.code(201).send({ agent: created });
  });

  app.patch('/api/agents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(updateBody, req.body, reply);
    if (!body) return;

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(body.name);
    }
    if (body.role !== undefined) {
      sets.push(`role = $${i++}`);
      params.push(body.role);
    }
    if (body.password !== undefined) {
      sets.push(`password_hash = $${i++}`);
      params.push(await hashPassword(body.password));
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    params.push(id);
    const updated = await queryOne(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, email, role`,
      params as never[],
    );
    if (!updated) return reply.code(404).send({ error: 'Agent not found' });
    await audit(req, { action: 'agent.update', targetType: 'agent', targetId: id });
    return reply.send({ agent: updated });
  });

  // Server-side delete (the old client-side supabase.auth.admin.deleteUser could
  // never work from the browser). Refuse to delete the last remaining admin.
  app.delete('/api/agents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.agent!.id) {
      return reply.code(400).send({ error: 'You cannot delete your own account' });
    }
    const target = await queryOne<{ role: string }>('SELECT role FROM agents WHERE id = $1', [id]);
    if (!target) return reply.code(404).send({ error: 'Agent not found' });

    if (target.role === 'admin') {
      const admins = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM agents WHERE role = 'admin'`,
      );
      if ((admins?.count ?? 0) <= 1) {
        return reply.code(400).send({ error: 'Cannot delete the last admin' });
      }
    }
    await query('DELETE FROM agents WHERE id = $1', [id]);
    await audit(req, { action: 'agent.delete', targetType: 'agent', targetId: id });
    return reply.send({ ok: true });
  });

  // Upload an agent avatar. An agent may set their own; an admin may set anyone's.
  app.post('/api/agents/:id/avatar', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.agent!.id !== id && req.agent!.role !== 'admin') {
      return reply.code(403).send({ error: 'You can only change your own avatar' });
    }
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'No file' });
    if (!AVATAR_MIME.has(part.mimetype)) return reply.code(415).send({ error: 'Unsupported image type' });
    const buffer = await part.toBuffer();
    if (buffer.length > MAX_AVATAR_BYTES) return reply.code(413).send({ error: 'Image too large (max 2 MB)' });

    const path = join(env.UPLOAD_DIR, 'avatars', id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    const avatarUrl = `/api/avatars/${id}`;
    const updated = await queryOne(
      `UPDATE agents SET avatar_url = $1, avatar_mime = $2 WHERE id = $3 RETURNING id, avatar_url`,
      [avatarUrl, part.mimetype, id],
    );
    if (!updated) return reply.code(404).send({ error: 'Agent not found' });
    await audit(req, { action: 'agent.avatar', targetType: 'agent', targetId: id });
    return reply.send({ avatar_url: avatarUrl });
  });

  // Public: serve an agent avatar (shown next to agent messages in the widget).
  app.get('/api/avatars/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await queryOne<{ avatar_mime: string | null }>(
      'SELECT avatar_mime FROM agents WHERE id = $1',
      [id],
    );
    if (!row?.avatar_mime) return reply.code(404).send({ error: 'No avatar' });
    reply.header('Content-Type', row.avatar_mime);
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(createReadStream(join(env.UPLOAD_DIR, 'avatars', id)));
  });
}
