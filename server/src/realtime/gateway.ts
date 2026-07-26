import type { FastifyInstance } from 'fastify';
// The gateway authenticates sockets before any workspace is known, and resolves
// which workspace a socket belongs to.
// eslint-disable-next-line no-restricted-imports -- socket handshake precedes tenant scope
import { unscopedPrisma } from '../db/unscoped.js';
import { verifyAccessToken, tokenMatchesHash } from '../auth/tokens.js';
import { verifyWidgetSession } from '../services/widgetSession.js';
import { verifyContextToken } from '../services/verifiedAttributes.js';
import { clientIp, lookupGeo } from '../services/geo.js';
import { recordVisitorIp } from '../services/visitorTracking.js';
import { resolveIdentity } from '../services/identity.js';
import { registerAgentSocket, registerVisitorSocket, rememberConversationOwner } from './hub.js';
import {
  registerPresenceSocket,
  updatePresence,
  setPresenceIdentity,
  setPresenceContext,
  setPresenceData,
} from './presence.js';
import { ingestReplayEvents, isBuffering } from './replay.js';

/**
 * WebSocket endpoints.
 *
 * Three sockets, three different authentications — and none of them takes an
 * identity from an unauthenticated query parameter any more:
 *
 *   /ws/agent?token=      an access JWT + an active membership
 *   /ws/visitor/:id?token=  the conversation's own visitor token
 *   /ws/presence?token=   a signed WIDGET SESSION token (services/widgetSession.ts)
 *
 * Browsers cannot set headers on a WebSocket handshake, which is why these carry
 * the token in the query string. That is acceptable for the agent and visitor
 * tokens (already secrets the client holds) and is the whole point of the widget
 * session token: it replaces a guessable `visitor_id` parameter with a value only
 * this server can mint.
 */
export async function registerRealtime(app: FastifyInstance): Promise<void> {
  // ── Agent firehose, scoped to one workspace ───────────────────────────────
  app.get('/ws/agent', { websocket: true }, async (socket, req) => {
    const query = req.query as { token?: string; workspace?: string };
    if (!query.token || !query.workspace) {
      socket.close(1008, 'token and workspace required');
      return;
    }
    let userId: string;
    try {
      userId = verifyAccessToken(query.token).sub;
    } catch {
      socket.close(1008, 'invalid token');
      return;
    }

    // Membership is re-checked here rather than trusted from the token, because a
    // socket outlives the 15-minute access token that opened it.
    const member = await unscopedPrisma.workspace_members.findUnique({
      where: { workspace_id_user_id: { workspace_id: query.workspace, user_id: userId } },
      select: {
        id: true,
        status: true,
        all_websites: true,
        websites: { select: { website_id: true } },
      },
    });
    if (!member || member.status !== 'active') {
      socket.close(1008, 'not a member of that workspace');
      return;
    }

    registerAgentSocket(socket, {
      memberId: member.id,
      userId,
      workspaceId: query.workspace,
      websiteIds: member.all_websites ? null : member.websites.map((w) => w.website_id),
    });
  });

  // ── One conversation's visitor ────────────────────────────────────────────
  app.get('/ws/visitor/:id', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };
    if (!token) {
      socket.close(1008, 'token required');
      return;
    }
    const conv = await unscopedPrisma.conversations.findUnique({
      where: { id },
      select: { id: true, workspace_id: true, website_id: true, visitor_token_hash: true },
    });
    if (!conv || !tokenMatchesHash(token, conv.visitor_token_hash)) {
      // One close reason for both "no such conversation" and "wrong token", so the
      // socket cannot be used to probe which conversation ids exist.
      socket.close(1008, 'invalid token');
      return;
    }
    rememberConversationOwner(conv.id, conv.workspace_id, conv.website_id);
    registerVisitorSocket(conv.id, conv.workspace_id, conv.website_id, socket);
  });

  // ── Anonymous host-page presence ──────────────────────────────────────────
  app.get('/ws/presence', { websocket: true }, async (socket, req) => {
    const { token } = req.query as { token?: string };
    const session = verifyWidgetSession(token);
    if (!session) {
      // No unauthenticated path exists any more. Previously this endpoint accepted
      // `?visitor_id=` from anyone, which combined with the proactive frame's
      // payload was a full conversation takeover.
      socket.close(1008, 'widget session required');
      return;
    }
    const { vid: visitorId, wsite: websiteId, ws: workspaceId } = session;

    const ip = clientIp(req.headers, req.ip);
    const geo = await lookupGeo(ip);
    let lastContext: string | null = null;
    let lastContextAt = 0;

    /**
     * Verify a signed host context and apply it: the identified customer (so the
     * board is not "anonymous"), the trusted attributes card, and the cross-website
     * people pool. The website id comes from the SESSION, so the secret looked up
     * is always the right one — previously it came from a client-supplied string.
     */
    const applyContext = (contextToken: string | null, fingerprint: string | null): void => {
      void verifyContextToken(websiteId, contextToken).then((ctx) => {
        const cust = ctx?.customer;
        if (cust?.name || cust?.email) {
          setPresenceIdentity(websiteId, visitorId, {
            name: cust.name ?? null,
            email: cust.email ?? null,
          });
        }
        setPresenceContext(websiteId, visitorId, ctx);
        void resolveIdentity(workspaceId, visitorId, {
          fingerprint,
          email: cust?.email ?? null,
          websiteId,
        });
      });
    };

    socket.on('message', (raw: unknown) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        registerPresenceSocket(socket, { workspaceId, websiteId, visitorId }, ip, geo, msg as never);
        void recordVisitorIp(workspaceId, visitorId, ip, geo);
        applyContext(
          typeof msg.context_token === 'string' ? msg.context_token : null,
          typeof msg.fingerprint === 'string' ? msg.fingerprint : null,
        );
      } else if (msg.type === 'context' && typeof msg.context_token === 'string') {
        // The host re-signed its context at runtime (a login, or any state change) —
        // Nestled('context', token) → embed → presence. Each one costs a secret
        // lookup plus an HMAC verify, so repeats of the token we already applied are
        // skipped and the rest throttled.
        const now = Date.now();
        if (msg.context_token !== lastContext && now - lastContextAt > 2000) {
          lastContext = msg.context_token;
          lastContextAt = now;
          applyContext(msg.context_token, null);
        }
      } else if (msg.type === 'data' && msg.attributes && typeof msg.attributes === 'object') {
        setPresenceData(websiteId, visitorId, msg.attributes as Record<string, unknown>);
      } else if (msg.type === 'update') {
        updatePresence(websiteId, visitorId, msg as never);
      } else if (msg.type === 'ping') {
        updatePresence(websiteId, visitorId, {});
      } else if (msg.type === 'rrweb' && Array.isArray((msg as { events?: unknown }).events)) {
        // Only ingested while an agent is actually watching — see replay.ts for why
        // buffering every visitor is the wrong default.
        if (isBuffering(websiteId, visitorId)) {
          ingestReplayEvents(websiteId, visitorId, (msg as { events: { type: number }[] }).events);
        }
      }
    });
  });
}
