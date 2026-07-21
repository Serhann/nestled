import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
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

// ── Order-aware quick actions (data-driven) ──────────────────────────────────
// The widget posts a quick-action `intent` (the action's key) + the visitor's
// live order + any collected fields. The action definition (label, kind, the
// visitor/reply templates, handoff suggestion) lives in the quick_actions table
// and is managed in the admin — this route renders its templates server-side
// (trusted) and escalates when kind === 'human'.
interface OrderCtx {
  id?: string;
  status?: string;
  eta?: string;
  restaurant?: string;
}

const orderCtxSchema = z.object({
  id: z.string().max(120).optional(),
  status: z.string().max(120).optional(),
  eta: z.string().max(120).optional(),
  restaurant: z.string().max(200).optional(),
});

const quickActionBody = z.object({
  intent: z.string().min(1).max(60), // the quick action's key
  order: orderCtxSchema.optional(),
  fields: z.record(z.string().max(60), z.string().max(1000)).optional(),
});

/** Substitute {placeholders} in a quick-action template from the order + any
 *  collected fields. Missing tokens render as empty strings. */
function renderTemplate(tpl: string, order: OrderCtx, fields: Record<string, string>): string {
  const tokens: Record<string, string> = {
    order: order.id ? `#${order.id}` : 'your order',
    status: order.status || 'being processed',
    eta: order.eta || '',
    restaurant: order.restaurant || '',
    restaurant_clause: order.restaurant ? ` from ${order.restaurant}` : '',
    eta_clause: order.eta ? ` — estimated arrival in ${order.eta}` : '',
    eta_paren: order.eta ? ` (ETA ${order.eta})` : '',
    order_about: order.id ? ` about order #${order.id}` : '',
    ...fields,
  };
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => tokens[k] ?? '');
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
    const pub = await prisma.public_settings.findUnique({
      where: { id: 1 },
      select: { ai_enabled: true },
    });
    const priv = (await prisma.private_settings.findUnique({
      where: { id: 1 },
      select: { ai_response_mode: true },
    })) as AIModeSettings | null;
    if (!pub?.ai_enabled || !priv) return;
    if (priv.ai_response_mode === 'off') return;

    const conv = await prisma.conversations.findUnique({
      where: { id: conversationId },
      select: { ai_greeted: true, needs_human: true },
    });
    if (conv?.needs_human) return; // already handed off — AI stays silent
    if (priv.ai_response_mode === 'first_message' && conv?.ai_greeted) return;
    if (priv.ai_response_mode === 'when_no_agent_online' && anyAgentOnline()) return; // a human is here

    // Reply to the latest visitor message in this conversation.
    const last = await prisma.messages.findFirst({
      where: { conversation_id: conversationId, sender_type: 'visitor' },
      orderBy: { created_at: 'desc' },
      select: { content: true },
    });
    if (!last) return;

    const result = await generateAIReply(last.content, conversationId);
    if (!result) return; // provider error/timeout or empty → post nothing

    await insertMessage({ conversationId, content: result.reply, senderType: 'ai' });
    if (priv.ai_response_mode === 'first_message') {
      await prisma.conversations.update({
        where: { id: conversationId },
        data: { ai_greeted: true },
      });
    }

    // Handoff: flag the conversation, notify agents, and stop future AI replies.
    if (result.needsHuman) {
      const updated = await prisma.conversations.update({
        where: { id: conversationId },
        data: { needs_human: true, status: 'open' },
        select: { id: true, needs_human: true, status: true },
      });
      broadcastToAgents({ type: 'conversation:updated', conversation: updated });
      await pushToAgents({
        type: 'message',
        conversationId,
        title: 'Handoff requested',
        body: 'A visitor needs a human.',
        url: `/admin?conversation=${conversationId}`,
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

    const conv = await prisma.conversations.create({
      data: {
        visitor_id: body.visitor_id,
        visitor_name: body.visitor_name ?? null,
        visitor_email: body.visitor_email ?? null,
        visitor_token_hash: hash,
        metadata: metadata as object,
      },
      select: { id: true, created_at: true },
    });
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
      void prisma.triggers
        .updateMany({ where: { id: triggerId }, data: { conversation_count: { increment: 1 } } })
        .catch(() => undefined);
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
    return reply.send({ messages });
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
    void prisma.conversations
      .updateMany({ where: { id, status: 'resolved' }, data: { status: 'open' } })
      .catch(() => undefined);
    void notifyNewMessage(id, body.content, 'visitor');
    // Push to agents (except any actively viewing this conversation).
    void (async () => {
      const conv = await prisma.conversations.findUnique({
        where: { id },
        select: { visitor_name: true },
      });
      await pushVisitorMessage(id, conv?.visitor_name ?? null, body.content);
    })();
    void maybeAIReply(id);

    return reply.code(201).send({ message });
  });

  // Order-aware quick action (visitor-scoped). Posts the visitor's request and
  // an instant bot reply; escalates to a human for problem intents.
  app.post('/api/conversations/:id/quick-action', {
    preHandler: requireVisitor('id'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(quickActionBody, req.body, reply);
    if (!body) return;

    // Look up the managed action by key. Unknown/inactive → 400.
    const def = await prisma.quick_actions.findUnique({ where: { key: body.intent } });
    if (!def || !def.is_active) return reply.code(400).send({ error: 'Unknown quick action' });
    const isHuman = def.kind === 'human';
    const order: OrderCtx = body.order ?? {};
    const fields: Record<string, string> = body.fields ?? {};

    const visitorText = renderTemplate(def.visitor_template, order, fields);
    const visitorMsg = await insertMessage({ conversationId: id, content: visitorText, senderType: 'visitor' });
    // A resolved conversation re-opens on new visitor activity.
    void prisma.conversations
      .updateMany({ where: { id, status: 'resolved' }, data: { status: 'open' } })
      .catch(() => undefined);

    const botMsg = await insertMessage({
      conversationId: id,
      content: renderTemplate(def.reply_template, order, fields),
      senderType: 'ai',
      metadata: { quick_action: body.intent, auto: !isHuman },
    });

    if (isHuman) {
      // Escalate: flag for a human and notify every agent. Stamp a handoff
      // summary onto the conversation metadata so the admin inbox can show the
      // "escalated by bot" context + suggested action (design t3).
      const existing = await prisma.conversations.findUnique({
        where: { id },
        select: { metadata: true },
      });
      const prevMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
      const handoff = {
        by: 'bot' as const,
        intent: body.intent,
        reason: def.label,
        suggestion: def.suggestion ?? undefined,
        request: visitorText,
        order: order.id ? order : null,
        fields: Object.keys(fields).length > 0 ? fields : null,
        at: new Date().toISOString(),
      };
      const updated = await prisma.conversations.update({
        where: { id },
        data: {
          needs_human: true,
          status: 'open',
          metadata: { ...prevMeta, handoff } as object,
        },
        select: { id: true, needs_human: true, status: true },
      });
      broadcastToAgents({ type: 'conversation:updated', conversation: updated });
      await pushToAgents({
        type: 'message',
        conversationId: id,
        title: 'Agent requested',
        body: visitorText,
        url: `/admin?conversation=${id}`,
      });
    }
    void notifyNewMessage(id, visitorText, 'visitor');

    return reply.code(201).send({
      messages: [visitorMsg, botMsg].filter(Boolean),
      needs_human: isHuman,
    });
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
