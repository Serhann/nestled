import type { FastifyInstance } from 'fastify';
import { queryOne } from '../db/pool.js';
import { clientIp, lookupGeo } from '../services/geo.js';
import { anyAgentOnline } from '../realtime/hub.js';

/**
 * Public widget configuration. Anonymous, read-only, and — crucially — sourced
 * ONLY from public_settings. There is no code path here that can reach the
 * secret columns in private_settings, so the old "anon reads the API key" bug
 * cannot recur. Active triggers are also served here for the embed to evaluate.
 */
export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/widget-config', async (_req, reply) => {
    const settings = await queryOne(
      `SELECT widget_title, welcome_message, primary_color, widget_position,
              widget_avatar_url, ai_enabled, pre_chat_enabled, pre_chat_fields,
              auto_welcome_enabled, auto_welcome_message, auto_welcome_delay,
              notification_sound_enabled, magic_browse_enabled
         FROM public_settings WHERE id = 1`,
    );
    return reply.send({ settings });
  });

  // Server-side country detection for the trigger engine — replaces the client
  // ipapi.co call (which would blow the free tier at one request per pageload).
  // Uses the local GeoLite2 DB; returns null country when geo is unavailable.
  app.get('/api/geo', async (req, reply) => {
    const geo = await lookupGeo(clientIp(req.headers, req.ip));
    return reply.send({ country_code: geo?.country_code ?? null, country: geo?.country ?? null });
  });

  // Whether any agent is currently online (drives the widget's online/offline
  // header and the "leave a message" fallback before a conversation exists).
  app.get('/api/agent-status', async (_req, reply) => {
    return reply.send({ online: anyAgentOnline() });
  });
}
