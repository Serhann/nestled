import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, tokenMatchesHash, type AgentRole } from '../auth/tokens.js';
import { queryOne } from '../db/pool.js';

export interface AuthedAgent {
  id: string;
  role: AgentRole;
  email: string;
}

// Attach identity to the request without a plugin decorator dance — a plain
// module augmentation keeps the types honest across all route handlers.
declare module 'fastify' {
  interface FastifyRequest {
    agent?: AuthedAgent;
    visitorConversationId?: string;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * preHandler: require a valid agent access token. Populates req.agent.
 * Use for any endpoint an agent (or admin) may call.
 */
export async function requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  if (!token) {
    await reply.code(401).send({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.agent = { id: payload.sub, role: payload.role, email: payload.email };
  } catch {
    await reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

/** preHandler: require an admin. Run requireAgent first (composed below). */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAgent(req, reply);
  if (reply.sent) return;
  if (req.agent?.role !== 'admin') {
    await reply.code(403).send({ error: 'Admin privileges required' });
  }
}

/**
 * preHandler factory: require a visitor token that matches the conversation in
 * the route params. The visitor may ONLY ever touch its own conversation — this
 * is the structural fix for the old "any anon can read all conversations" bug.
 *
 * Reads `:id` (or `:conversationId`) from params and the token from the
 * Authorization header. On success, sets req.visitorConversationId.
 */
export function requireVisitor(paramName = 'id') {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const params = req.params as Record<string, string | undefined>;
    const conversationId = params[paramName];
    const token = bearer(req);

    if (!conversationId || !token) {
      await reply.code(401).send({ error: 'Visitor token required' });
      return;
    }

    const row = await queryOne<{ visitor_token_hash: string }>(
      'SELECT visitor_token_hash FROM conversations WHERE id = $1',
      [conversationId],
    );

    // Do not distinguish "not found" from "wrong token" — both are 401 so an
    // attacker can't probe which conversation ids exist.
    if (!row || !tokenMatchesHash(token, row.visitor_token_hash)) {
      await reply.code(401).send({ error: 'Invalid visitor token' });
      return;
    }

    req.visitorConversationId = conversationId;
  };
}
