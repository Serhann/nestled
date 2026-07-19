import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { prisma } from '../db/prisma.js';
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
    const agents = await prisma.agents.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatar_url: true,
        is_online: true,
        last_seen: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    });
    return reply.send({ agents });
  });

  // Admin-only creation (replaces the old open signup trigger).
  app.post('/api/agents', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(createBody, req.body, reply);
    if (!body) return;

    const existing = await prisma.agents.findUnique({
      where: { email: body.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) return reply.code(409).send({ error: 'An agent with that email already exists' });

    const password_hash = await hashPassword(body.password);
    const created = await prisma.agents.create({
      data: { name: body.name, email: body.email.toLowerCase(), password_hash, role: body.role },
      select: { id: true, name: true, email: true, role: true, created_at: true },
    });
    await audit(req, { action: 'agent.create', targetType: 'agent', targetId: created.id });
    return reply.code(201).send({ agent: created });
  });

  app.patch('/api/agents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(updateBody, req.body, reply);
    if (!body) return;

    const data: { name?: string; role?: 'admin' | 'agent'; password_hash?: string } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    if (body.password !== undefined) data.password_hash = await hashPassword(body.password);
    if (Object.keys(data).length === 0) return reply.code(400).send({ error: 'No fields to update' });

    const updated = await prisma.agents
      .update({
        where: { id },
        data,
        select: { id: true, name: true, email: true, role: true },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Agent not found' });
    await audit(req, { action: 'agent.update', targetType: 'agent', targetId: id });
    return reply.send({ agent: updated });
  });

  // Server-side delete. Refuse to delete the last remaining admin.
  app.delete('/api/agents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.agent!.id) {
      return reply.code(400).send({ error: 'You cannot delete your own account' });
    }
    const target = await prisma.agents.findUnique({ where: { id }, select: { role: true } });
    if (!target) return reply.code(404).send({ error: 'Agent not found' });

    if (target.role === 'admin') {
      const admins = await prisma.agents.count({ where: { role: 'admin' } });
      if (admins <= 1) {
        return reply.code(400).send({ error: 'Cannot delete the last admin' });
      }
    }
    await prisma.agents.delete({ where: { id } });
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
    const updated = await prisma.agents
      .update({
        where: { id },
        data: { avatar_url: avatarUrl, avatar_mime: part.mimetype },
        select: { id: true, avatar_url: true },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Agent not found' });
    await audit(req, { action: 'agent.avatar', targetType: 'agent', targetId: id });
    return reply.send({ avatar_url: avatarUrl });
  });

  // Public: serve an agent avatar (shown next to agent messages in the widget).
  app.get('/api/avatars/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.agents.findUnique({ where: { id }, select: { avatar_mime: true } });
    if (!row?.avatar_mime) return reply.code(404).send({ error: 'No avatar' });
    reply.header('Content-Type', row.avatar_mime);
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(createReadStream(join(env.UPLOAD_DIR, 'avatars', id)));
  });
}
