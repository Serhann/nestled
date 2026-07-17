import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { queryOne, query, withTransaction } from '../db/pool.js';
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
  await query(
    'INSERT INTO refresh_tokens (agent_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [agent.id, hash, refreshExpiryDate()],
  );
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

    const existing = await queryOne<{ count: number }>('SELECT COUNT(*)::int AS count FROM agents');
    if ((existing?.count ?? 0) > 0) {
      return reply
        .code(403)
        .send({ error: 'Registration is closed. Ask an admin to create your account.' });
    }

    const password_hash = await hashPassword(body.data.password);
    const created = await queryOne<AgentRow>(
      `INSERT INTO agents (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, name, email, password_hash, role`,
      [body.data.name, body.data.email.toLowerCase(), password_hash],
    );
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

    const agent = await queryOne<AgentRow>(
      'SELECT id, name, email, password_hash, role FROM agents WHERE email = $1',
      [body.data.email.toLowerCase()],
    );
    // Generic error either way — don't reveal whether the email exists.
    if (!agent || !(await verifyPassword(body.data.password, agent.password_hash))) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    await query('UPDATE agents SET last_seen = now() WHERE id = $1', [agent.id]);
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
    const result = await withTransaction(async (client) => {
      const row = (
        await client.query<{ id: string; agent_id: string; expires_at: Date; revoked_at: Date | null }>(
          'SELECT id, agent_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
          [presentedHash],
        )
      ).rows[0];

      if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()) {
        return null;
      }
      // Revoke the old token (rotation) before issuing a replacement.
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);

      const agent = (
        await client.query<AgentRow>(
          'SELECT id, name, email, password_hash, role FROM agents WHERE id = $1',
          [row.agent_id],
        )
      ).rows[0];
      if (!agent) return null;

      const accessToken = signAccessToken({ sub: agent.id, role: agent.role, email: agent.email });
      const { token: refreshToken, hash } = generateRefreshToken();
      await client.query(
        'INSERT INTO refresh_tokens (agent_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [agent.id, hash, refreshExpiryDate()],
      );
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
      await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [
        hashToken(body.data.refresh_token),
      ]);
    }
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAgent }, async (req, reply) => {
    const agent = await queryOne(
      'SELECT id, name, email, role, avatar_url, is_online, last_seen FROM agents WHERE id = $1',
      [req.agent!.id],
    );
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return reply.send({ agent });
  });
}
