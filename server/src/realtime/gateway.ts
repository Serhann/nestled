import type { FastifyInstance } from 'fastify';
import { verifyAccessToken, tokenMatchesHash } from '../auth/tokens.js';
import { prisma } from '../db/prisma.js';
import { registerAgentSocket, registerVisitorSocket } from './hub.js';
import {
  registerPresenceSocket,
  updatePresence,
  setPresenceIdentity,
  setPresenceContext,
} from './presence.js';
import { ingestReplayEvents, clearReplay } from './replay.js';
import { clientIp, lookupGeo } from '../services/geo.js';
import { recordVisitorIp } from '../services/visitorTracking.js';
import { resolveIdentity } from '../services/identity.js';
import { verifyContextToken } from '../services/siteContext.js';

/**
 * WebSocket endpoints. Both authenticate on connect via a `token` query param
 * (browsers can't set headers on the WS handshake). An unauthenticated or
 * mismatched connection is closed immediately.
 *
 *   /ws/agent?token=<access JWT>
 *   /ws/visitor/:id?token=<visitor token>
 */
export async function registerRealtime(app: FastifyInstance): Promise<void> {
  app.get('/ws/agent', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(1008, 'token required');
      return;
    }
    let agentId: string;
    try {
      agentId = verifyAccessToken(token).sub;
    } catch {
      socket.close(1008, 'invalid token');
      return;
    }
    registerAgentSocket(socket, agentId);
  });

  app.get('/ws/visitor/:id', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(1008, 'token required');
      return;
    }
    const row = await prisma.conversations.findUnique({
      where: { id },
      select: { visitor_token_hash: true },
    });
    if (!row || !tokenMatchesHash(token, row.visitor_token_hash)) {
      socket.close(1008, 'invalid token');
      return;
    }
    registerVisitorSocket(id, socket);
  });

  // Anonymous visitor presence — the host page (embed) opens this on load, well
  // before any conversation exists. No auth: the visitor_id is client-generated
  // and the data is low-sensitivity. Metadata arrives in a `hello` message; the
  // client heartbeats and reports SPA navigations here too.
  app.get('/ws/presence', { websocket: true }, async (socket, req) => {
    const visitorId = (req.query as { visitor_id?: string }).visitor_id;
    if (!visitorId) {
      socket.close(1008, 'visitor_id required');
      return;
    }
    const ip = clientIp(req.headers, req.ip);
    const geo = await lookupGeo(ip);
    // The site key from `hello`, kept so a later context refresh can be verified
    // against the same site's secret.
    let siteMode: string | null = null;
    let lastContext: string | null = null; // last context token applied on this socket
    let lastContextAt = 0;

    /**
     * Verify a signed host context and apply it to presence: the identified
     * customer (so the board isn't "anonymous"), the trusted customer/order card
     * for the Live Visitors drawer, and the cross-site people pool.
     */
    const applyContext = (token: string | null, fingerprint: string | null): void => {
      void verifyContextToken(siteMode, token).then((ctx) => {
        const cust = ctx?.customer;
        if (cust?.name || cust?.email) {
          setPresenceIdentity(visitorId, { name: cust.name ?? null, email: cust.email ?? null });
        }
        setPresenceContext(visitorId, ctx);
        void resolveIdentity(visitorId, { fingerprint, email: cust?.email ?? null, mode: siteMode });
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
        registerPresenceSocket(socket, visitorId, ip, geo, msg as Record<string, never>);
        void recordVisitorIp(visitorId, ip, geo); // track every IP this visitor uses
        siteMode = typeof msg.mode === 'string' ? msg.mode : null;
        // Verify any signed host context so the board shows the identified
        // customer (not "anonymous") the moment they land, and feed the trusted
        // email into the cross-site people pool.
        applyContext(
          typeof msg.context_token === 'string' ? msg.context_token : null,
          typeof msg.fingerprint === 'string' ? msg.fingerprint : null,
        );
      } else if (msg.type === 'context' && typeof msg.context_token === 'string') {
        // Host re-signed the context at runtime (login, or a new order status) —
        // JetChat('context', token) → embed → presence. Keeps the live card fresh.
        // Each one costs a secret lookup + HMAC verify, so skip repeats of the
        // token we already applied and throttle the rest.
        const now = Date.now();
        if (msg.context_token !== lastContext && now - lastContextAt > 2000) {
          lastContext = msg.context_token;
          lastContextAt = now;
          applyContext(msg.context_token, null);
        }
      } else if (msg.type === 'update') {
        updatePresence(visitorId, msg as Record<string, never>);
      } else if (msg.type === 'ping') {
        updatePresence(visitorId, {});
      } else if (msg.type === 'rrweb' && Array.isArray((msg as { events?: unknown }).events)) {
        ingestReplayEvents(visitorId, (msg as { events: { type: number }[] }).events);
      }
    });

    socket.on('close', () => clearReplay(visitorId));
  });
}
