import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { queryOne } from '../db/pool.js';
import { requireAgent } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { generateVisitorToken } from '../auth/tokens.js';
import { insertMessage } from '../lib/messages.js';
import { broadcastToAgents } from '../realtime/hub.js';
import {
  snapshot,
  getVisitor,
  attachConversationToVisitor,
  sendProactiveToVisitor,
} from '../realtime/presence.js';

const startChatBody = z.object({ message: z.string().min(1).max(2000) });

/** Agent-facing live-visitor board + proactive engagement. */
export async function presenceRoutes(app: FastifyInstance): Promise<void> {
  // Snapshot for the Live Visitors screen. Realtime updates arrive over the
  // agent WS as `presence:list` events.
  app.get('/api/agent/presence', { preHandler: requireAgent }, async (_req, reply) => {
    return reply.send({ visitors: snapshot() });
  });

  // Proactively start a chat with a visitor from the board: create the
  // conversation, seed the agent's opening message, and pop the widget open on
  // the visitor's browser via their presence socket (handing over the token so
  // the widget can adopt the conversation).
  app.post('/api/agent/presence/:visitorId/start-chat', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { visitorId } = req.params as { visitorId: string };
    const body = parseBody(startChatBody, req.body, reply);
    if (!body) return;

    const present = getVisitor(visitorId);
    const agent = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [
      req.agent!.id,
    ]);

    const { token, hash } = generateVisitorToken();
    const conv = await queryOne<{ id: string; created_at: string }>(
      `INSERT INTO conversations (visitor_id, visitor_token_hash, status, metadata)
       VALUES ($1, $2, 'active', $3)
       RETURNING id, created_at`,
      [
        visitorId,
        hash,
        { proactive: true, current_page: present?.url ?? null, location: present?.geo ?? null },
      ],
    );
    if (!conv) return reply.code(500).send({ error: 'Failed to create conversation' });

    // Seed the agent's opening line.
    await insertMessage({
      conversationId: conv.id,
      content: body.message,
      senderType: 'agent',
      senderId: req.agent!.id,
    });

    attachConversationToVisitor(visitorId, conv.id);
    broadcastToAgents({
      type: 'conversation:new',
      conversation: { id: conv.id, visitor_id: visitorId, created_at: conv.created_at, proactive: true },
    });

    const delivered = sendProactiveToVisitor(visitorId, {
      conversation_id: conv.id,
      visitor_token: token,
      message: body.message,
      agent_name: agent?.name ?? 'Agent',
    });

    // If the visitor is offline, the conversation still exists; delivered=false
    // tells the agent it will surface when the visitor returns.
    return reply.code(201).send({ conversation_id: conv.id, delivered });
  });
}
