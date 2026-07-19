import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
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
    const settings = await prisma.public_settings.findUnique({
      where: { id: 1 },
      select: {
        widget_title: true,
        welcome_message: true,
        primary_color: true,
        widget_position: true,
        widget_avatar_url: true,
        ai_enabled: true,
        pre_chat_enabled: true,
        pre_chat_fields: true,
        auto_welcome_enabled: true,
        auto_welcome_message: true,
        auto_welcome_delay: true,
        notification_sound_enabled: true,
        magic_browse_enabled: true,
      },
    });
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
