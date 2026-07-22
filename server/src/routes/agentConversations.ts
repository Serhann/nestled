import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAgent } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { insertMessage } from '../lib/messages.js';
import { broadcastToAgents, sendToConversationVisitors } from '../realtime/hub.js';
import { translateText } from '../services/ai/index.js';
import { geoDiagnose } from '../services/geo.js';
// (sendToConversationVisitors is also used to tell the widget an agent joined.)

const replyBody = z.object({ content: z.string().min(1).max(8000) });
const translateBody = z.object({ text: z.string().min(1).max(8000), to: z.string().min(1).max(40) });
const statusBody = z.object({ status: z.enum(['open', 'pending', 'resolved']) });
const assignBody = z.object({ agent_id: z.string().uuid().nullable().optional() });
const noteBody = z.object({ content: z.string().min(1).max(4000) });

// Columns safe to expose to agents — never visitor_token_hash.
const conversationSelect = {
  id: true,
  visitor_id: true,
  visitor_name: true,
  visitor_email: true,
  status: true,
  assigned_agent_id: true,
  needs_human: true,
  message_count: true,
  ai_greeted: true,
  metadata: true,
  created_at: true,
  updated_at: true,
} as const;

/** Agent-facing conversation endpoints. Any authenticated agent may access. */
export async function agentConversationRoutes(app: FastifyInstance): Promise<void> {
  // Geo diagnostic: verify the MaxMind web service against a specific IP.
  //   GET /api/agent/geo-test?ip=8.8.8.8
  app.get('/api/agent/geo-test', { preHandler: requireAgent }, async (req, reply) => {
    const ip = ((req.query as { ip?: string }).ip || '8.8.8.8').trim();
    return reply.send(await geoDiagnose(ip));
  });

  // Live translation for the agent: translate any text into a target language.
  app.post('/api/agent/translate', { preHandler: requireAgent }, async (req, reply) => {
    const body = parseBody(translateBody, req.body, reply);
    if (!body) return;
    const text = await translateText(body.text, body.to);
    return reply.send({ text });
  });

  app.get('/api/agent/conversations', { preHandler: requireAgent }, async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    // Include a last-message preview (content + sender) for the list UI via the
    // messages relation (take 1, newest first). Never expose visitor_token_hash.
    const rows = await prisma.conversations.findMany({
      where: status ? { status } : {},
      orderBy: { updated_at: 'desc' },
      take: 200,
      select: {
        ...conversationSelect,
        messages: {
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { content: true, sender_type: true },
        },
      },
    });
    const conversations = rows.map(({ messages, ...c }) => ({
      ...c,
      last_message: messages[0]?.content ?? null,
      last_sender: messages[0]?.sender_type ?? null,
    }));
    return reply.send({ conversations });
  });

  app.get('/api/agent/conversations/:id', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversations.findUnique({
      where: { id },
      select: conversationSelect,
    });
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    const messages = await prisma.messages.findMany({
      where: { conversation_id: id },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        conversation_id: true,
        content: true,
        sender_type: true,
        sender_id: true,
        metadata: true,
        created_at: true,
      },
    });
    return reply.send({ conversation, messages });
  });

  app.post('/api/agent/conversations/:id/messages', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(replyBody, req.body, reply);
    if (!body) return;

    const exists = await prisma.conversations.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Conversation not found' });

    // Stamp the agent's identity onto the message so the widget can show their
    // name + avatar (persisted, no lookup needed later).
    const me = await prisma.agents.findUnique({
      where: { id: req.agent!.id },
      select: { name: true, avatar_url: true },
    });
    const message = await insertMessage({
      conversationId: id,
      content: body.content,
      senderType: 'agent',
      senderId: req.agent!.id,
      metadata: { agent: { name: me?.name ?? 'Agent', avatar_url: me?.avatar_url ?? null } },
    });
    // A human replied: reopen if resolved.
    await prisma.conversations.updateMany({
      where: { id, status: 'resolved' },
      data: { status: 'open' },
    });
    return reply.code(201).send({ message });
  });

  app.post('/api/agent/conversations/:id/status', {
    preHandler: requireAgent,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(statusBody, req.body, reply);
    if (!body) return;
    const updated = await prisma.conversations
      .update({ where: { id }, data: { status: body.status }, select: { id: true, status: true } })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
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

    let targetName: string | null = null;
    if (target) {
      const exists = await prisma.agents.findUnique({ where: { id: target }, select: { name: true } });
      if (!exists) return reply.code(404).send({ error: 'Agent not found' });
      targetName = exists.name;
    }
    const updated = await prisma.conversations
      .update({
        where: { id },
        data: { assigned_agent_id: target },
        select: { id: true, assigned_agent_id: true, status: true },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2025') return null;
        throw e;
      });
    if (!updated) return reply.code(404).send({ error: 'Conversation not found' });
    broadcastToAgents({ type: 'conversation:updated', conversation: updated });
    // Tell the widget an agent joined so it can release its "waiting" hold.
    if (target) {
      sendToConversationVisitors(id, { type: 'agent:joined', conversationId: id, agentName: targetName });
    }
    return reply.send({ conversation: updated });
  });

  // Internal notes (agent-only; never sent to the visitor).
  app.get('/api/agent/conversations/:id/notes', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const notes = await prisma.conversation_notes.findMany({
      where: { conversation_id: id },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        conversation_id: true,
        agent_id: true,
        agent_name: true,
        content: true,
        created_at: true,
      },
    });
    return reply.send({ notes });
  });

  app.post('/api/agent/conversations/:id/notes', { preHandler: requireAgent }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(noteBody, req.body, reply);
    if (!body) return;
    const agent = await prisma.agents.findUnique({
      where: { id: req.agent!.id },
      select: { name: true },
    });
    const note = await prisma.conversation_notes.create({
      data: {
        conversation_id: id,
        agent_id: req.agent!.id,
        agent_name: agent?.name ?? null,
        content: body.content,
      },
      select: {
        id: true,
        conversation_id: true,
        agent_id: true,
        agent_name: true,
        content: true,
        created_at: true,
      },
    });
    return reply.code(201).send({ note });
  });
}
