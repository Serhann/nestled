import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWorkspace, can } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { generateOpaqueToken } from '../../auth/tokens.js';
import { snapshot, sendProactiveToVisitor, getVisitor } from '../../realtime/presence.js';
import { insertMessage } from '../../lib/messages.js';
import { publishToWorkspace, rememberConversationOwner } from '../../realtime/hub.js';
import { audit } from '../../lib/audit.js';

/**
 * The live-visitor board, and proactive chat.
 *
 * The board is served from the in-memory presence registry filtered by workspace
 * AND by the member's website grants, so a narrowed member sees only their own
 * sites' visitors.
 */
export async function presenceV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/w/:workspaceId/presence',
    { preHandler: [requireWorkspace, can('visitor:read')] },
    async (req, reply) => {
      const member = req.auth!.member!;
      return reply.send({
        visitors: snapshot(
          req.auth!.workspace!.id,
          member.allWebsites ? null : member.websiteIds,
        ),
      });
    },
  );

  /**
   * Start a conversation with a visitor who has not written first.
   *
   * The visitor is handed a single-use CLAIM token, not the conversation's visitor
   * token. This is the second of the two independent fixes for the presence
   * takeover: even if a proactive frame leaked to the wrong socket, it is useless
   * without the victim's own signed widget session, and it expires in 60 seconds.
   */
  app.post(
    '/api/v1/w/:workspaceId/presence/:visitorId/start-chat',
    { preHandler: [requireWorkspace, can('conversation:reply')] },
    async (req, reply) => {
      const { visitorId } = req.params as { visitorId: string };
      const body = parseBody(
        z.object({ website_id: z.string().uuid(), message: z.string().min(1).max(2000) }),
        req.body,
        reply,
      );
      if (!body) return;
      if (!req.auth!.can('conversation:reply', body.website_id)) {
        return reply.code(403).send({ error: 'Missing permission for that website' });
      }

      const website = await req.db.websites.findUnique({
        where: { id: body.website_id },
        select: { id: true },
      });
      if (!website) return reply.code(404).send({ error: 'Not found' });

      const live = getVisitor(body.website_id, visitorId);
      if (!live) {
        return reply.code(409).send({ error: 'That visitor is no longer online', code: 'visitor_offline' });
      }

      const workspaceId = req.auth!.workspace!.id;
      const claim = generateOpaqueToken(24);
      const member = req.auth!.member!;

      const conv = await req.db.conversations.create({
        data: {
          website_id: body.website_id,
          visitor_id: visitorId,
          visitor_name: live.name,
          visitor_email: live.email,
          // A placeholder that matches nothing: the real token is minted only when
          // the visitor exchanges the claim, so an unclaimed proactive chat has no
          // usable credential in existence anywhere.
          visitor_token_hash: generateOpaqueToken(32).hash,
          claim_token_hash: claim.hash,
          claim_expires_at: new Date(Date.now() + 60_000),
          source: 'proactive',
          assigned_member_id: member.id,
          metadata: { ip_address: live.ip, location: live.geo, current_page: live.url } as object,
        } as never,
        select: { id: true, created_at: true },
      });

      rememberConversationOwner(conv.id, workspaceId, body.website_id);
      const agent = await req.db.workspace_members.findUnique({
        where: { id: member.id },
        select: { user: { select: { name: true } } },
      });

      await insertMessage({
        workspaceId,
        websiteId: body.website_id,
        conversationId: conv.id,
        content: body.message,
        senderType: 'agent',
        senderMemberId: member.id,
      });

      const delivered = sendProactiveToVisitor(body.website_id, visitorId, {
        conversation_id: conv.id,
        claim_token: claim.token,
        message: body.message,
        agent_name: agent?.user.name ?? 'Support',
      });

      publishToWorkspace(
        workspaceId,
        {
          type: 'conversation:new',
          conversation: {
            id: conv.id,
            website_id: body.website_id,
            visitor_id: visitorId,
            visitor_name: live.name,
            created_at: conv.created_at,
          },
        },
        { websiteId: body.website_id },
      );
      await audit(req, {
        action: 'conversation.proactive_started',
        targetType: 'conversation',
        targetId: conv.id,
      });

      /*
        `conversation`, not `conversation_id`.

        The client has always read `conversation.id` off this response and this has
        always sent a flat `conversation_id`, so `onSuccess` threw on every single
        proactive chat: the conversation WAS created and the message WAS delivered,
        but the dialog never closed and never navigated, which reads as "start chat
        does nothing". A 201 that the caller cannot use is a failure with a
        successful status code.

        `delivered` stays alongside it. It is false only if the visitor's socket
        dropped between the liveness check above and the send — rare, but the
        difference between "they have it" and "it is waiting for them".
      */
      return reply.code(201).send({ conversation: { id: conv.id }, delivered });
    },
  );
}
