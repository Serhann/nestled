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

const changePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
});

async function issueTokens(agent: { id: string; role: AgentRole; email: string }) {
  const accessToken = signAccessToken({ sub: agent.id, role: agent.role, email: agent.email });
  const { token: refreshToken, hash } = generateRefreshToken();
  await prisma.refresh_tokens.create({
    data: { agent_id: agent.id, token_hash: hash, expires_at: refreshExpiryDate() },
  });
  return { accessToken, refreshToken };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public self-registration is closed. The first admin is bootstrapped from the
  // SEED_ADMIN_* env vars on boot (see ensureSeedAdmin); every other account is
  // created by an admin via POST /api/agents. There is no open signup endpoint.

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

  // Change your own password. Requires the current password; on success every
  // refresh token for this agent is revoked so all devices are signed out (the
  // caller's current access token keeps working until it expires, then they
  // re-login) — standard, safe behaviour after a credential change.
  app.post('/api/auth/change-password', {
    preHandler: requireAgent,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = changePasswordBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request', details: body.error.issues });
    }
    const agentId = req.agent!.id;
    const agent = await prisma.agents.findUnique({
      where: { id: agentId },
      select: { password_hash: true },
    });
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    if (!(await verifyPassword(body.data.current_password, agent.password_hash))) {
      return reply.code(400).send({ error: 'Current password is incorrect' });
    }
    if (body.data.new_password === body.data.current_password) {
      return reply.code(400).send({ error: 'New password must be different' });
    }

    const password_hash = await hashPassword(body.data.new_password);
    await prisma.agents.update({ where: { id: agentId }, data: { password_hash } });
    // Sign out other devices (best-effort): revoke all this agent's refresh
    // tokens. The current access token stays valid until it expires, then its
    // refresh token is gone too — expected after a password change.
    await prisma.refresh_tokens
      .updateMany({ where: { agent_id: agentId, revoked_at: null }, data: { revoked_at: new Date() } })
      .catch(() => undefined);

    return reply.send({ ok: true });
  });
}
