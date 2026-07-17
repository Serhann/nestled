import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { generateVisitorToken } from '../auth/tokens.js';
import { requireVisitor } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { insertMessage } from '../lib/messages.js';
import { broadcastToAgents, anyAgentOnline } from '../realtime/hub.js';
import { attachConversationToVisitor } from '../realtime/presence.js';
import { clientIp, lookupGeo } from '../services/geo.js';
import { notifyNewChat, notifyNewMessage } from '../services/discord.js';
import { pushNewConversation, pushVisitorMessage, pushToAgents } from '../services/push.js';
import { generateAIReply } from '../services/ai/index.js';

const createBody = z.object({
  visitor_id: z.string().min(1).max(200),
  visitor_name: z.string().max(200).optional(),
  visitor_email: z.string().email().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const messageBody = z.object({
  content: z.string().min(1).max(8000),
});

interface AIModeSettings {
  ai_response_mode: 'off' | 'first_message' | 'when_no_agent_online' | 'always';
}

/**
 * Decide whether the AI should reply to this visitor message, then post it.
 * Reply modes:
 *   off                  — never
 *   first_message        — greeting only (until ai_greeted)
 *   when_no_agent_online — full answers while no agent is connected; the moment
 *                          an agent is online the AI stays silent (human handles)
 *   always               — every message
 * Once a conversation is flagged needs_human (handoff), the AI stops entirely.
 * Never throws into the request path.
 */
async function maybeAIReply(conversationId: string): Promise<void> {
  try {
    const pub = await queryOne<{ ai_enabled: boolean }>(
      'SELECT ai_enabled FROM public_settings WHERE id = 1',
    );
    const priv = await queryOne<AIModeSettings>(
      'SELECT ai_response_mode FROM private_settings WHERE id = 1',
    );
    if (!pub?.ai_enabled || !priv) return;
    if (priv.ai_response_mode === 'off') return;

    const conv = await queryOne<{ ai_greeted: boolean; needs_human: boolean }>(
      'SELECT ai_greeted, needs_human FROM conversations WHERE id = $1',
      [conversationId],
    );
    if (conv?.needs_human) return; // already handed off — AI stays silent
    if (priv.ai_response_mode === 'first_message' && conv?.ai_greeted) return;
    if (priv.ai_response_mode === 'when_no_agent_online' && anyAgentOnline()) return; // a human is here

    // Reply to the latest visitor message in this conversation.
    const last = await queryOne<{ content: string }>(
      `SELECT content FROM messages
        WHERE conversation_id = $1 AND sender_type = 'visitor'
        ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    if (!last) return;

    const result = await generateAIReply(last.content, conversationId);
    if (!result) return; // provider error/timeout or empty → post nothing

    await insertMessage({ conversationId, content: result.reply, senderType: 'ai' });
    if (priv.ai_response_mode === 'first_message') {
      await query('UPDATE conversations SET ai_greeted = true WHERE id = $1', [conversationId]);
    }

    // Handoff: flag the conversation, notify agents, and stop future AI replies.
    if (result.needsHuman) {
      const updated = await queryOne(
        `UPDATE conversations SET needs_human = true, status = 'open' WHERE id = $1
         RETURNING id, needs_human, status`,
        [conversationId],
      );
      broadcastToAgents({ type: 'conversation:updated', conversation: updated });
      await pushToAgents({
        type: 'message',
        conversationId,
        title: 'Handoff requested',
        body: 'A visitor needs a human.',
        url: `/?conversation=${conversationId}`,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ai] reply failed', err);
  }
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // Create a conversation. Returns the visitor_token ONCE — the widget stores
  // it and presents it on every subsequent request to this conversation.
  app.post('/api/conversations', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = parseBody(createBody, req.body, reply);
    if (!body) return;

    const { token, hash } = generateVisitorToken();
    const ip = clientIp(req.headers, req.ip);
    const geo = await lookupGeo(ip);

    const metadata = {
      ...(body.metadata ?? {}),
      ip_address: ip,
      location: geo,
    };

    const conv = await queryOne<{ id: string; created_at: string }>(
      `INSERT INTO conversations (visitor_id, visitor_name, visitor_email, visitor_token_hash, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [body.visitor_id, body.visitor_name ?? null, body.visitor_email ?? null, hash, metadata],
    );
    if (!conv) return reply.code(500).send({ error: 'Failed to create conversation' });

    broadcastToAgents({
      type: 'conversation:new',
      conversation: {
        id: conv.id,
        visitor_id: body.visitor_id,
        visitor_name: body.visitor_name ?? null,
        created_at: conv.created_at,
      },
    });
    // Trigger conversion attribution: if this chat started from a trigger, count it.
    const triggerId = body.metadata?.trigger_id;
    if (typeof triggerId === 'string') {
      void query('UPDATE triggers SET conversation_count = conversation_count + 1 WHERE id = $1', [
        triggerId,
      ]).catch(() => undefined);
    }
    // If this visitor is on the live board, link the conversation (green dot).
    attachConversationToVisitor(body.visitor_id, conv.id);
    void notifyNewChat(conv.id);
    const page = (body.metadata?.current_page as string | undefined) ?? null;
    void pushNewConversation(conv.id, body.visitor_name ?? null, page);

    return reply.code(201).send({ conversation_id: conv.id, visitor_token: token });
  });

  // Read this conversation's messages (visitor-scoped).
  app.get('/api/conversations/:id/messages', {
    preHandler: requireVisitor('id'),
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const messages = await query(
      `SELECT id, conversation_id, content, sender_type, sender_id, metadata, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return reply.send({ messages: messages.rows });
  });

  // Post a visitor message (visitor-scoped), then maybe trigger an AI reply.
  app.post('/api/conversations/:id/messages', {
    preHandler: requireVisitor('id'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(messageBody, req.body, reply);
    if (!body) return;

    const message = await insertMessage({
      conversationId: id,
      content: body.content,
      senderType: 'visitor',
    });
    if (!message) return reply.code(500).send({ error: 'Failed to post message' });

    // A resolved conversation re-opens when the visitor writes again.
    void query(`UPDATE conversations SET status = 'open' WHERE id = $1 AND status = 'resolved'`, [id]);
    void notifyNewMessage(id, body.content, 'visitor');
    // Push to agents (except any actively viewing this conversation).
    void (async () => {
      const conv = await queryOne<{ visitor_name: string | null }>(
        'SELECT visitor_name FROM conversations WHERE id = $1',
        [id],
      );
      await pushVisitorMessage(id, conv?.visitor_name ?? null, body.content);
    })();
    void maybeAIReply(id);

    return reply.code(201).send({ message });
  });

  // Visitor typing indicator (visitor-scoped) → forwarded to agents.
  app.post('/api/conversations/:id/typing', {
    preHandler: requireVisitor('id'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const isTyping = (req.body as { is_typing?: boolean } | undefined)?.is_typing ?? true;
    broadcastToAgents({ type: 'typing', conversationId: id, from: 'visitor', isTyping });
    return reply.send({ ok: true });
  });
}
