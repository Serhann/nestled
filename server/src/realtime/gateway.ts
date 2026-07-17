import type { FastifyInstance } from 'fastify';
import { verifyAccessToken, tokenMatchesHash } from '../auth/tokens.js';
import { queryOne } from '../db/pool.js';
import { registerAgentSocket, registerVisitorSocket } from './hub.js';
import { registerPresenceSocket, updatePresence } from './presence.js';
import { ingestReplayEvents, clearReplay } from './replay.js';
import { clientIp, lookupGeo } from '../services/geo.js';

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
    const row = await queryOne<{ visitor_token_hash: string }>(
      'SELECT visitor_token_hash FROM conversations WHERE id = $1',
      [id],
    );
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

    socket.on('message', (raw: unknown) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        registerPresenceSocket(socket, visitorId, ip, geo, msg as Record<string, never>);
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
