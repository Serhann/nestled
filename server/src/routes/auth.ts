import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiryDate,
  type AgentRole,
} from '../auth/tokens.js';
import { requireAgent } from '../plugins/auth.js';

interface AgentRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: AgentRole;
}

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerBody = credentials.extend({ name: z.string().min(1).max(120) });

async function issueTokens(agent: { id: string; role: AgentRole; email: string }) {
  const accessToken = signAccessToken({ sub: agent.id, role: agent.role, email: agent.email });
  const { token: refreshToken, hash } = generateRefreshToken();
  await prisma.refresh_tokens.create({
    data: { agent_id: agent.id, token_hash: hash, expires_at: refreshExpiryDate() },
  });
  return { accessToken, refreshToken };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Bootstrap the first admin. Open only while zero agents exist; afterwards
  // agent creation is admin-only (POST /api/agents). This closes the old
  // open-signup trigger that auto-created an agent for any auth user.
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = registerBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request', details: body.error.issues });
    }

    const existing = await prisma.agents.count();
    if (existing > 0) {
      return reply
        .code(403)
        .send({ error: 'Registration is closed. Ask an admin to create your account.' });
    }

    const password_hash = await hashPassword(body.data.password);
    const created = (await prisma.agents.create({
      data: { name: body.data.name, email: body.data.email.toLowerCase(), password_hash, role: 'admin' },
      select: { id: true, name: true, email: true, password_hash: true, role: true },
    })) as AgentRow;
    if (!created) return reply.code(500).send({ error: 'Failed to create account' });

    const tokens = await issueTokens(created);
    return reply.code(201).send({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      agent: { id: created.id, name: created.name, email: created.email, role: created.role },
    });
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = credentials.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const agent = (await prisma.agents.findUnique({
      where: { email: body.data.email.toLowerCase() },
      select: { id: true, name: true, email: true, password_hash: true, role: true },
    })) as AgentRow | null;
    // Generic error either way — don't reveal whether the email exists.
    if (!agent || !(await verifyPassword(body.data.password, agent.password_hash))) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    await prisma.agents.update({ where: { id: agent.id }, data: { last_seen: new Date() } });
    const tokens = await issueTokens(agent);
    return reply.send({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role },
    });
  });

  // Rotate: consume the presented refresh token and mint a new pair.
  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({ refresh_token: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });

    const presentedHash = hashToken(body.data.refresh_token);
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.refresh_tokens.findUnique({ where: { token_hash: presentedHash } });
      if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()) {
        return null;
      }
      // Revoke the old token (rotation) before issuing a replacement. The
      // revoked_at: null guard makes reuse of a token that a concurrent request
      // already rotated a no-op (count 0) — single-use is preserved.
      const revoked = await tx.refresh_tokens.updateMany({
        where: { id: row.id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      if (revoked.count === 0) return null;

      const agent = (await tx.agents.findUnique({
        where: { id: row.agent_id },
        select: { id: true, name: true, email: true, password_hash: true, role: true },
      })) as AgentRow | null;
      if (!agent) return null;

      const accessToken = signAccessToken({ sub: agent.id, role: agent.role, email: agent.email });
      const { token: refreshToken, hash } = generateRefreshToken();
      await tx.refresh_tokens.create({
        data: { agent_id: agent.id, token_hash: hash, expires_at: refreshExpiryDate() },
      });
      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role },
      };
    });

    if (!result) return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    return reply.send(result);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = z.object({ refresh_token: z.string().min(1) }).safeParse(req.body);
    if (body.success) {
      await prisma.refresh_tokens.updateMany({
        where: { token_hash: hashToken(body.data.refresh_token) },
        data: { revoked_at: new Date() },
      });
    }
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAgent }, async (req, reply) => {
    const agent = await prisma.agents.findUnique({
      where: { id: req.agent!.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatar_url: true,
        is_online: true,
        last_seen: true,
      },
    });
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return reply.send({ agent });
  });
}
