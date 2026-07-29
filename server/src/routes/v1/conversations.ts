import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWorkspace, can } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { insertMessage } from '../../lib/messages.js';
import { publishToWorkspace, sendToConversationVisitors } from '../../realtime/hub.js';
import { publishAssignment } from '../../services/routing.js';
import { getPersonProfile } from '../../services/identity.js';
import { translateText } from '../../services/translate/index.js';
import { deliverReply } from '../../services/channels/outbound.js';
import { onAgentReply } from '../../services/responseTargets.js';
import { planById } from '../../services/billing/plans.js';
import { bumpUsage, checkUsageLimit } from '../../lib/usage.js';
import { notifyNewMessage } from '../../services/discord.js';
import { audit } from '../../lib/audit.js';

/**
 * The agent inbox.
 *
 * Every query goes through `req.db`, so the workspace predicate and the member's
 * per-website grants are applied whether or not this file remembers them. The
 * pre-tenant version listed with `where: status ? { status } : {}` — which under
 * multi-tenancy would have shown every customer's conversations to every agent.
 */

const LIST_LIMIT = 100;

/**
 * The urgency views.
 *
 * `at_risk` deliberately means "due within the next 15 minutes OR already past due",
 * not just "past due". A list of conversations that are already late is a list of
 * things you have already failed at; the point is to catch them while there is still
 * time, so the window looks forward.
 */
const AT_RISK_WINDOW_MS = 15 * 60_000;

function dueFilter(due: string | undefined): Record<string, unknown> {
  const now = new Date();
  switch (due) {
    case 'at_risk':
      return { response_due_at: { not: null, lte: new Date(now.getTime() + AT_RISK_WINDOW_MS) } };
    case 'breached':
      return { response_breached_at: { not: null } };
    case 'waiting':
      // Somebody is waiting for a reply, target or no target.
      return { awaiting_reply_since: { not: null } };
    case 'unread':
      return { unread_at: { not: null } };
    default:
      return {};
  }
}

export async function conversationV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/w/:workspaceId/conversations',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const q = req.query as {
        status?: string;
        website_id?: string;
        assignee?: string;
        tag?: string;
        channel?: string;
        /** 'at_risk' | 'breached' | 'waiting' | 'unread' — the urgency views. */
        due?: string;
        q?: string;
        cursor?: string;
        limit?: string;
      };
      const take = Math.min(Number(q.limit) || 50, LIST_LIMIT);

      const conversations = await req.db.conversations.findMany({
        where: {
          ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
          ...(q.website_id ? { website_id: q.website_id } : {}),
          ...(q.assignee === 'unassigned'
            ? { assigned_member_id: null }
            : q.assignee === 'me'
              ? { assigned_member_id: req.auth!.member!.id }
              : q.assignee
                ? { assigned_member_id: q.assignee }
                : {}),
          ...(q.tag ? { tags: { has: q.tag } } : {}),
          ...(q.channel && q.channel !== 'all' ? { channel: q.channel } : {}),
          ...dueFilter(q.due),
          ...(q.q
            ? {
                OR: [
                  { visitor_name: { contains: q.q, mode: 'insensitive' as const } },
                  { visitor_email: { contains: q.q, mode: 'insensitive' as const } },
                  { messages: { some: { content: { contains: q.q, mode: 'insensitive' as const } } } },
                ],
              }
            : {}),
        },
        /**
         * Urgency, not recency, when an urgency view is selected.
         *
         * This is the actual workflow change. An inbox ordered by "most recent" puts
         * the conversation nobody has answered for three hours BELOW the one that
         * arrived a minute ago — which is precisely how a request gets missed. Asking
         * for the at-risk view sorts by deadline instead, soonest first.
         */
        orderBy: q.due && q.due !== 'all' ? { response_due_at: 'asc' } : { updated_at: 'desc' },
        take,
        // Keyset pagination rather than offset: an inbox reorders on every new
        // message, so page 2 of an offset query would skip or repeat rows.
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          website_id: true,
          visitor_id: true,
          visitor_name: true,
          visitor_email: true,
          status: true,
          assigned_member_id: true,
          needs_human: true,
          message_count: true,
          tags: true,
          rating_stars: true,
          created_at: true,
          updated_at: true,
          metadata: true,
          channel: true,
          channel_address: true,
          awaiting_reply_since: true,
          response_due_at: true,
          response_breached_at: true,
          unread_at: true,
          messages: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { content: true, sender_type: true, created_at: true },
          },
        },
      });

      return reply.send({
        conversations: conversations.map((c) => {
          const { messages, ...rest } = c;
          return {
            ...rest,
            last_message: messages[0]?.content ?? null,
            last_sender: messages[0]?.sender_type ?? null,
          };
        }),
        next_cursor: conversations.length === take ? conversations[conversations.length - 1]?.id : null,
      });
    },
  );

  /**
   * How many need attention right now.
   *
   * Its own tiny endpoint rather than a field on the list, because the numbers have to
   * be visible when the agent is NOT looking at the at-risk view — that is the entire
   * point. Four indexed counts, polled by the shell.
   */
  app.get(
    '/api/v1/w/:workspaceId/conversations/attention',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const now = new Date();
      const open = { status: { not: 'resolved' } };
      const [atRisk, breached, unread, waiting] = await Promise.all([
        req.db.conversations.count({
          where: {
            ...open,
            response_due_at: { not: null, lte: new Date(now.getTime() + AT_RISK_WINDOW_MS) },
          },
        }),
        req.db.conversations.count({ where: { ...open, response_breached_at: { not: null } } }),
        req.db.conversations.count({ where: { ...open, unread_at: { not: null } } }),
        req.db.conversations.count({ where: { ...open, awaiting_reply_since: { not: null } } }),
      ]);
      return reply.send({ at_risk: atRisk, breached, unread, waiting });
    },
  );

  app.get(
    '/api/v1/w/:workspaceId/conversations/:id',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const conversation = await req.db.conversations.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { created_at: 'asc' } },
          notes: { orderBy: { created_at: 'asc' } },
          attachments: true,
        },
      });
      if (!conversation) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ conversation });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/messages',
    { preHandler: [requireWorkspace, can('conversation:reply')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ content: z.string().min(1).max(8000) }), req.body, reply);
      if (!body) return;

      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: {
          id: true,
          workspace_id: true,
          website_id: true,
          first_response_at: true,
          status: true,
          channel: true,
        },
      });
      if (!conv) return reply.code(404).send({ error: 'Not found' });
      // Per-website grants apply to replying, not just to reading.
      if (!req.auth!.can('conversation:reply', conv.website_id)) {
        return reply.code(403).send({ error: 'Missing permission: conversation:reply' });
      }

      const offWidget = conv.channel !== 'widget';
      const message = await insertMessage({
        workspaceId: conv.workspace_id,
        websiteId: conv.website_id,
        conversationId: id,
        content: body.content,
        senderType: 'agent',
        senderMemberId: req.auth!.member!.id,
        // `pending` only where sending can actually fail. On the widget, writing the
        // row IS delivery, and a status column that always says 'sent' teaches an
        // agent to ignore it — which is the one thing it must not do.
        deliveryStatus: offWidget ? 'pending' : null,
      });

      // Stamp the first human response once, for response-time reporting. Doing it
      // here rather than deriving it later means a message edited or deleted in
      // future cannot rewrite history.
      if (!conv.first_response_at) {
        await req.db.conversations.updateMany({
          where: { id, first_response_at: null },
          data: { first_response_at: new Date() },
        });
      }
      // A human answered: the clock stops. `response_breached_at` is deliberately
      // left in place — a breach that vanishes once somebody finally replies is a
      // breach nobody learns from.
      await onAgentReply({ workspaceId: conv.workspace_id, conversationId: id });

      // Replying to a resolved conversation re-opens it: an agent following up
      // should not have to remember to change the status first.
      if (conv.status === 'resolved') {
        await req.db.conversations.updateMany({
          where: { id },
          data: { status: 'open', resolved_at: null },
        });
      }

      /**
       * Delivery, AWAITED, and its outcome returned.
       *
       * Fire-and-forget would be wrong here in a way it is not elsewhere: the agent is
       * looking at the screen right now, and a reply that bounced is something they
       * have to know before they move to the next conversation. Awaiting an SMTP or
       * Twilio round trip costs a second on the response; not awaiting it costs a
       * customer who never got an answer while an agent believes they replied.
       */
      let delivery: { ok: boolean; error?: string } = { ok: true };
      if (offWidget && message) {
        const result = await deliverReply({
          workspaceId: conv.workspace_id,
          conversationId: id,
          messageId: message.id,
          content: body.content,
        });
        delivery = result.ok ? { ok: true } : { ok: false, error: result.error };
      }

      void notifyNewMessage(conv.workspace_id, id, body.content, 'agent');
      // The message is returned either way — it IS in the thread, and pretending
      // otherwise would lose the agent's words. `delivery` is how the client knows
      // whether it reached anybody.
      return reply.code(201).send({
        message: message ? { ...message, delivery_status: delivery.ok ? 'sent' : 'failed' } : null,
        delivery,
      });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/status',
    { preHandler: [requireWorkspace, can('conversation:resolve')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({ status: z.enum(['open', 'pending', 'resolved']) }),
        req.body,
        reply,
      );
      if (!body) return;

      try {
        const updated = await req.db.conversations.update({
          where: { id },
          data: {
            status: body.status,
            resolved_at: body.status === 'resolved' ? new Date() : null,
          },
          select: { id: true, status: true, website_id: true, workspace_id: true, needs_human: true },
        });
        // Resolving stops the clock too. Otherwise a settled conversation keeps its
        // deadline, breaches overnight, and the sweep escalates something that was
        // dealt with — the fastest way to teach a team to ignore the alerts.
        if (body.status === 'resolved') {
          await onAgentReply({ workspaceId: updated.workspace_id, conversationId: id });
        }
        publishToWorkspace(
          updated.workspace_id,
          { type: 'conversation:updated', conversation: updated },
          { websiteId: updated.website_id },
        );
        // Tell the widget, so it can clear the thread and start fresh next time
        // rather than leaving the visitor staring at a closed conversation.
        if (body.status === 'resolved') {
          sendToConversationVisitors(id, { type: 'conversation:resolved', conversationId: id });
        }
        return reply.send({ conversation: updated });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  /**
   * Mark a conversation unread, or read again.
   *
   * A verbatim request from reviewers of the competition: with no way to mark a
   * conversation unread, a support team that opens something they cannot deal with
   * right now has no way to put it back — so it slides down a list ordered by
   * recency and is never seen again. Gated on `conversation:read` rather than reply,
   * because it is a reading gesture and an agent who can see it can flag it.
   */
  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/unread',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ unread: z.boolean() }), req.body, reply);
      if (!body) return;

      const { count } = await req.db.conversations.updateMany({
        where: { id },
        data: { unread_at: body.unread ? new Date() : null },
      });
      if (count === 0) return reply.code(404).send({ error: 'Not found' });

      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: { id: true, website_id: true, workspace_id: true, unread_at: true },
      });
      if (conv) {
        publishToWorkspace(
          conv.workspace_id,
          { type: 'conversation:updated', conversation: conv },
          { websiteId: conv.website_id },
        );
      }
      return reply.send({ conversation: conv });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/assign',
    { preHandler: [requireWorkspace, can('conversation:assign')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({ member_id: z.string().uuid().nullable() }),
        req.body,
        reply,
      );
      if (!body) return;

      // The composite FK would reject a foreign member anyway; checking here turns
      // a 500 into a clean 404.
      if (body.member_id) {
        const member = await req.db.workspace_members.findUnique({
          where: { id: body.member_id },
          select: { id: true },
        });
        if (!member) return reply.code(404).send({ error: 'Not found' });
      }

      try {
        const updated = await req.db.conversations.update({
          where: { id },
          data: { assigned_member_id: body.member_id, needs_human: false },
          select: {
            id: true,
            workspace_id: true,
            website_id: true,
            assigned_member_id: true,
            status: true,
          },
        });
        // The one notification path for "this conversation now belongs to someone",
        // shared with the routing rules and the bot's handoff node. Three call sites
        // producing three slightly different events is how a widget ends up still
        // showing "waiting for an agent" after one of them.
        await publishAssignment(updated);
        await audit(req, { action: 'conversation.assigned', targetType: 'conversation', targetId: id });
        return reply.send({ conversation: updated });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/tags',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({ tags: z.array(z.string().min(1).max(40)).max(25) }),
        req.body,
        reply,
      );
      if (!body) return;
      try {
        const updated = await req.db.conversations.update({
          where: { id },
          data: { tags: [...new Set(body.tags.map((t) => t.trim().toLowerCase()))] },
          select: { id: true, tags: true, workspace_id: true, website_id: true },
        });
        publishToWorkspace(
          updated.workspace_id,
          { type: 'conversation:updated', conversation: updated },
          { websiteId: updated.website_id },
        );
        return reply.send({ conversation: updated });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/typing',
    { preHandler: [requireWorkspace, can('conversation:reply')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const isTyping = (req.body as { is_typing?: boolean } | undefined)?.is_typing ?? true;
      sendToConversationVisitors(id, { type: 'typing', conversationId: id, from: 'agent', isTyping });
      return reply.send({ ok: true });
    },
  );

  // ── Internal notes ────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/conversations/:id/notes',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const notes = await req.db.conversation_notes.findMany({
        where: { conversation_id: id },
        orderBy: { created_at: 'asc' },
      });
      return reply.send({ notes });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/conversations/:id/notes',
    { preHandler: [requireWorkspace, can('note:write')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ content: z.string().min(1).max(4000) }), req.body, reply);
      if (!body) return;

      const conv = await req.db.conversations.findUnique({ where: { id }, select: { id: true } });
      if (!conv) return reply.code(404).send({ error: 'Not found' });

      const user = req.auth!;
      const note = await req.db.conversation_notes.create({
        data: {
          conversation_id: id,
          author_user_id: user.userId,
          // Denormalized so a note keeps its attribution after the author leaves —
          // "note by (deleted user)" loses the context the note existed to provide.
          author_name: user.email,
          content: body.content,
        } as never,
      });
      return reply.code(201).send({ note });
    },
  );

  // ── Visitor detail ────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/visitors/:visitorId/ips',
    { preHandler: [requireWorkspace, can('visitor:read')] },
    async (req, reply) => {
      const { visitorId } = req.params as { visitorId: string };
      const ips = await req.db.visitor_ips.findMany({
        where: { visitor_id: visitorId },
        orderBy: { last_seen: 'desc' },
        take: 50,
      });
      return reply.send({ ips });
    },
  );

  app.get(
    '/api/v1/w/:workspaceId/visitors/:visitorId/person',
    { preHandler: [requireWorkspace, can('visitor:read')] },
    async (req, reply) => {
      const { visitorId } = req.params as { visitorId: string };
      const link = await req.db.visitor_links.findFirst({
        where: { visitor_id: visitorId },
        select: { person_id: true },
      });
      if (!link) return reply.send({ person: null });
      // getPersonProfile takes the workspace explicitly and filters on it, so a
      // person id from another tenant cannot be dereferenced here.
      const person = await getPersonProfile(req.auth!.workspace!.id, link.person_id);
      return reply.send({ person });
    },
  );

  // ── Live translation ──────────────────────────────────────────────────────
  //
  // Two rules shape this endpoint.
  //
  // It is METERED against `ai_replies`. A translation is an LLM call that costs us
  // what a reply costs, and this route is reachable by anyone who can answer a
  // chat. Left uncounted it would be a way to spend our AI budget with no counter
  // anywhere and no plan ceiling — the one hole big enough to matter.
  //
  // It NEVER fails the request. An agent is mid-reply to a customer; a 402 or a
  // 500 here would put a plan problem of ours in front of their customer's
  // problem. Every outcome is a 200 carrying `translated` and, when false, a
  // reason the UI can show — so the agent knows they are reading the original
  // rather than quietly believing a translation happened.
  app.post(
    '/api/v1/w/:workspaceId/translate',
    { preHandler: [requireWorkspace, can('conversation:reply')] },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          text: z.string().min(1).max(4000),
          // A language CODE, not a display name. Both engines need a code and only
          // one of them would have tolerated "Brazilian Portuguese"; pinning the
          // wire format here is what stops that difference reaching either adapter.
          to: z
            .string()
            .regex(/^[a-z]{2,3}$/, 'Expected a language code such as "tr" or "en"'),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const workspaceId = req.auth!.workspace!.id;
      const plan = await planById(req.auth!.workspace!.planId);
      if (plan) {
        const over = await checkUsageLimit(workspaceId, 'ai_replies', plan.max_ai_replies_month);
        if (over) {
          return reply.send({ text: body.text, translated: false, reason: 'plan_limit' });
        }
      }

      const out = await translateText(body.text, body.to);
      if (out === null) {
        return reply.send({ text: body.text, translated: false, reason: 'unavailable' });
      }
      // Counted after the call succeeded, not before: charging a customer's
      // allowance for our provider timing out is the wrong way round.
      await bumpUsage(workspaceId, 'ai_replies', 1);
      return reply.send({ text: out, translated: true });
    },
  );
}
