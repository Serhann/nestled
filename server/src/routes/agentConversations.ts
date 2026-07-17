import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireAgent } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { insertMessage } from '../lib/messages.js';
import { broadcastToAgents, sendToConversationVisitors } from '../realtime/hub.js';

const replyBody = z.object({ content: z.string().min(1).max(8000) });
const statusBody = z.object({ status: z.enum(['open', 'pending', 'resolved']) });
const assignBody = z.object({ agent_id: z.string().uuid().nullable().optional() });
const noteBody = z.object({ content: z.string().min(1).max(4000) });

/** Agent-facing conversation endpoints. Any authenticated agent may access. */
export async function agentConversationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/conversations', { preHandler: requireAgent }, async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    // Include a last-message preview (content + sender) for the list UI.
    // Never expose visitor_token_hash to clients — select explicit columns.
    const base = `
      SELECT c.id, c.visitor_id, c.visitor_name, c.visitor_email, c.status,
             c.assigned_agent_id, c.needs_human, c.message_count, c.ai_greeted,
             c.metadata, c.created_at, c.updated_at,
             m.content AS last_message, m.sender_type AS last_sender
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT content, sender_type FROM messages
           WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
        ) m ON true`;
    const rows = status
      ? await query(`${base} WHERE c.status = $1 ORDER BY c.updated_at DESC LIMIT 200`, [status])
      : await query(`${base} ORDER BY c.updated_at DESC LIMIT 200`);
    return reply.send({ conversations: rows.rows });
  });

  app.get('/api/agent/conversations/:id', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await queryOne(
      `SELECT id, visitor_id, visitor_name, visitor_email, status, assigned_agent_id,
              needs_human, message_count, ai_greeted, metadata, created_at, updated_at
         FROM conversations WHERE id = $1`,
      [id],
    );
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    const messages = await query(
      `SELECT id, conversation_id, content, sender_type, sender_id, metadata, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return reply.send({ conversation, messages: messages.rows });
  });

  app.post('/api/agent/conversations/:id/messages', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(replyBody, req.body, reply);
    if (!body) return;

    const exists = await queryOne(`SELECT id FROM conversations WHERE id = $1`, [id]);
    if (!exists) return reply.code(404).send({ error: 'Conversation not found' });

    // Stamp the agent's identity onto the message so the widget can show their
    // name + avatar (persisted, no lookup needed later).
    const me = await queryOne<{ name: string; avatar_url: string | null }>(
      'SELECT name, avatar_url FROM agents WHERE id = $1',
      [req.agent!.id],
    );
    const message = await insertMessage({
      conversationId: id,
      content: body.content,
      senderType: 'agent',
      senderId: req.agent!.id,
      metadata: { agent: { name: me?.name ?? 'Agent', avatar_url: me?.avatar_url ?? null } },
    });
    // A human replied: reopen if resolved.
    await query(`UPDATE conversations SET status = 'open' WHERE id = $1 AND status = 'resolved'`, [id]);
    return reply.code(201).send({ message });
  });

  app.post('/api/agent/conversations/:id/status', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(statusBody, req.body, reply);
    if (!body) return;
    const updated = await queryOne(
      `UPDATE conversations SET status = $1 WHERE id = $2 RETURNING id, status`,
      [body.status, id],
    );
    if (!updated) return reply.code(404).send({ error: 'Conversation not found' });
    broadcastToAgents({ type: 'conversation:updated', conversation: updated });
    return reply.send({ conversation: updated });
  });

  app.post('/api/agent/conversations/:id/typing', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const isTyping = (req.body as { is_typing?: boolean } | undefined)?.is_typing ?? true;
    sendToConversationVisitors(id, { type: 'typing', conversationId: id, from: 'agent', isTyping });
    return reply.send({ ok: true });
  });

  // Assign / claim / transfer / unassign. Any agent may (re)assign; the
  // unassigned pool is visible to all. Push routing (Phase 2) respects this.
  app.post('/api/agent/conversations/:id/assign', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(assignBody, req.body, reply);
    if (!body) return;
    // Omitted agent_id = claim it for myself; null = release to the pool.
    const target = body.agent_id === undefined ? req.agent!.id : body.agent_id;

    if (target) {
      const exists = await queryOne('SELECT id FROM agents WHERE id = $1', [target]);
      if (!exists) return reply.code(404).send({ error: 'Agent not found' });
    }
    const updated = await queryOne(
      `UPDATE conversations SET assigned_agent_id = $1 WHERE id = $2
       RETURNING id, assigned_agent_id, status`,
      [target, id],
    );
    if (!updated) return reply.code(404).send({ error: 'Conversation not found' });
    broadcastToAgents({ type: 'conversation:updated', conversation: updated });
    return reply.send({ conversation: updated });
  });

  // Internal notes (agent-only; never sent to the visitor).
  app.get('/api/agent/conversations/:id/notes', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const notes = await query(
      `SELECT id, conversation_id, agent_id, agent_name, content, created_at
         FROM conversation_notes WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return reply.send({ notes: notes.rows });
  });

  app.post('/api/agent/conversations/:id/notes', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(noteBody, req.body, reply);
    if (!body) return;
    const agent = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [req.agent!.id]);
    const note = await queryOne(
      `INSERT INTO conversation_notes (conversation_id, agent_id, agent_name, content)
       VALUES ($1, $2, $3, $4) RETURNING id, conversation_id, agent_id, agent_name, content, created_at`,
      [id, req.agent!.id, agent?.name ?? null, body.content],
    );
    return reply.code(201).send({ note });
  });
}
