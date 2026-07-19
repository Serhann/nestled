import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { env, allowedOrigins, isProd } from './env.js';
import { prisma } from './db/prisma.js';
import { runMigrations } from './db/migrate.js';
import { ensureSeedAdmin } from './db/seedAdmin.js';
import { startRetentionJob } from './lib/retention.js';
import { registerRealtime } from './realtime/gateway.js';
import { authRoutes } from './routes/auth.js';
import { widgetRoutes } from './routes/widget.js';
import { conversationRoutes } from './routes/conversations.js';
import { agentConversationRoutes } from './routes/agentConversations.js';
import { settingsRoutes } from './routes/settings.js';
import { agentRoutes } from './routes/agents.js';
import { knowledgeBaseRoutes } from './routes/knowledgeBase.js';
import { triggerRoutes } from './routes/triggers.js';
import { pushRoutes } from './routes/push.js';
import { presenceRoutes } from './routes/presence.js';
import { attachmentRoutes } from './routes/attachments.js';
import { cannedRoutes } from './routes/canned.js';

export async function buildServer() {
  const app = Fastify({
    // Trust the reverse proxy so req.ip / X-Forwarded-For are correct behind nginx.
    trustProxy: true,
    logger: env.NODE_ENV === 'test' ? false : isProd ? true : { transport: undefined },
  });

  // CORS locked to the configured origins (replaces the wildcard on the old
  // edge functions). Requests from other origins are rejected by the browser.
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin / curl / server-to-server (no Origin header).
      // Disallowed browser origins get no CORS headers (cb false) rather than a
      // thrown 500 — the browser blocks the read either way, this is cleaner.
      cb(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global rate limit floor; individual routes tighten it via `config.rateLimit`.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(websocket);

  // Attachment uploads (per-file size cap enforced here).
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });

  // Health check for load balancers / compose healthchecks.
  app.get('/healthz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', db: 'up' });
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'down' });
    }
  });

  // Global error handler: log with request context (structured), and never
  // leak internals to the client. SENTRY_DSN is a forwarding hook point.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err, url: req.url, method: req.method }, 'request error');
    if (env.SENTRY_DSN) {
      // Placeholder: forward to a Sentry-compatible sink when configured.
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status >= 400 && status < 500 ? status : 500).send({
      error: status < 500 ? (err as Error).message : 'Internal server error',
    });
  });

  // Realtime (WS) and REST routes.
  await app.register(registerRealtime);
  await app.register(authRoutes);
  await app.register(widgetRoutes);
  await app.register(conversationRoutes);
  await app.register(agentConversationRoutes);
  await app.register(settingsRoutes);
  await app.register(agentRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(triggerRoutes);
  await app.register(pushRoutes);
  await app.register(presenceRoutes);
  await app.register(attachmentRoutes);
  await app.register(cannedRoutes);

  return app;
}

async function main() {
  // Migrations run automatically on boot (idempotent).
  await runMigrations();
  // Optionally seed the first admin from SEED_ADMIN_* (no-op once one exists).
  await ensureSeedAdmin();

  const app = await buildServer();
  await app.listen({ host: env.HOST, port: env.PORT });
  // eslint-disable-next-line no-console
  console.log(`[jetchat] listening on http://${env.HOST}:${env.PORT}`);

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Optional data-retention sweep (env-gated). See src/lib/retention.ts.
  startRetentionJob();
}

// Boot everywhere except the test runner (tests import buildServer directly).
if (env.NODE_ENV !== 'test') {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[jetchat] fatal boot error', err);
    process.exit(1);
  });
}
