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

// ── Order-aware quick actions ────────────────────────────────────────────────
// The widget's order chips post a structured `intent` (+ the visitor's live
// order). Informational intents ('where', 'status') are answered automatically
// from the order data — no human needed. Problem intents (a delay, a missing
// item, a mistake, a refund, "talk to a human") escalate: the conversation is
// flagged needs_human and every agent is notified. The bot reply text is
// generated here (server-side, trusted) rather than accepted from the client.
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
  intent: z.enum(['where', 'status', 'late', 'change_address', 'missing_item', 'wrong', 'refund', 'human']),
  order: orderCtxSchema.optional(),
});

type QuickIntent = z.infer<typeof quickActionBody>['intent'];

const ord = (o: OrderCtx) => (o.id ? `#${o.id}` : 'your order');

const QUICK_INTENTS: Record<
  QuickIntent,
  { kind: 'auto' | 'human'; visitor: (o: OrderCtx) => string; reply: (o: OrderCtx) => string }
> = {
  where: {
    kind: 'auto',
    visitor: (o) => `Where is my order ${ord(o)}?`,
    reply: (o) =>
      `Your order ${ord(o)}${o.restaurant ? ` from ${o.restaurant}` : ''} is ${o.status || 'on its way'}` +
      `${o.eta ? ` — estimated arrival in ${o.eta}` : ''}. I'll let you know the moment it's nearby! 🛵`,
  },
  status: {
    kind: 'auto',
    visitor: (o) => `What's the status of my order ${ord(o)}?`,
    reply: (o) =>
      `Order ${ord(o)} is currently: ${o.status || 'being processed'}` +
      `${o.eta ? ` (ETA ${o.eta})` : ''}.`,
  },
  late: {
    kind: 'human',
    visitor: (o) => `My order ${ord(o)} seems late — can someone check?`,
    reply: () => `Sorry about the wait! I'm connecting you with an agent to check on the delay — please hold on a moment.`,
  },
  change_address: {
    kind: 'human',
    visitor: (o) => `I need to change the delivery address for order ${ord(o)}.`,
    reply: () => `Sure — connecting you with an agent to update the delivery address. One moment please.`,
  },
  missing_item: {
    kind: 'human',
    visitor: (o) => `An item is missing from my order ${ord(o)}.`,
    reply: () => `I'm sorry about that. Connecting you with an agent to sort out the missing item — please hold on.`,
  },
  wrong: {
    kind: 'human',
    visitor: (o) => `Something was wrong with my order ${ord(o)}.`,
    reply: () => `That's not right — connecting you with an agent to help you fix this. One moment please.`,
  },
  refund: {
    kind: 'human',
    visitor: (o) => `I'd like a refund for order ${ord(o)}.`,
    reply: () => `I've flagged your refund request — connecting you with an agent to review it. Please hold on a moment.`,
  },
  human: {
    kind: 'human',
    visitor: (o) => `I'd like to talk to an agent${o.id ? ` about order #${o.id}` : ''}.`,
    reply: () => `Of course — connecting you with an agent now. Please hold on a moment.`,
  },
};

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

    const def = QUICK_INTENTS[body.intent];
    const order: OrderCtx = body.order ?? {};

    const visitorText = def.visitor(order);
    const visitorMsg = await insertMessage({ conversationId: id, content: visitorText, senderType: 'visitor' });
    // A resolved conversation re-opens on new visitor activity.
    void prisma.conversations
      .updateMany({ where: { id, status: 'resolved' }, data: { status: 'open' } })
      .catch(() => undefined);

    const botMsg = await insertMessage({
      conversationId: id,
      content: def.reply(order),
      senderType: 'ai',
      metadata: { quick_action: body.intent, auto: def.kind === 'auto' },
    });

    if (def.kind === 'human') {
      // Escalate: flag for a human and notify every agent.
      const updated = await prisma.conversations.update({
        where: { id },
        data: { needs_human: true, status: 'open' },
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
      needs_human: def.kind === 'human',
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
