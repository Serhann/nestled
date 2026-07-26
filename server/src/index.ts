import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { env, allowedOrigins, isProd } from './env.js';
import { unscopedPrisma } from './db/unscoped.js';
import { runMigrations } from './db/migrate.js';
import { ensureSeedAdmin } from './db/seedAdmin.js';
import { startRetentionJob } from './lib/retention.js';
import { assertTenantModelsRegistered } from './db/tenant.js';
import { registerAuthPlugin } from './plugins/auth.js';
// ── v1 (multi-tenant) ────────────────────────────────────────────────────────
import { authV1Routes } from './routes/v1/auth.js';
import { meV1Routes } from './routes/v1/me.js';
import { workspaceV1Routes } from './routes/v1/workspaces.js';
import { teamV1Routes } from './routes/v1/team.js';

// ── Not yet ported (Phase 5) ─────────────────────────────────────────────────
// realtime/gateway.ts and routes/{auth,widget,conversations,agentConversations,
// settings,agents,knowledgeBase,triggers,push,presence,attachments,canned,sites}.ts
// still speak the pre-tenant model names, so they are NOT registered — importing
// them would boot a server whose routes 500 on first query. They stay on disk
// until Phase 5 ports them onto req.db, tracked by:
//   npx eslint server/src | grep -c "db/prisma"

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
  //
  // Skipped under NODE_ENV=test. The limiter's store is per-process and keyed by
  // IP, so with it on, a test suite that logs in a few times shares one bucket and
  // starts failing on timing rather than on behaviour — which trains people to
  // re-run tests instead of reading them. The trade-off is explicit: rate limits
  // are configuration verified by the plugin, and are NOT covered by these tests.
  if (env.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
    });
  }

  await app.register(websocket);

  // Attachment uploads (per-file size cap enforced here).
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });

  // Health check for load balancers / compose healthchecks.
  app.get('/healthz', async (_req, reply) => {
    try {
      await unscopedPrisma.$queryRaw`SELECT 1`;
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

  // Decorates req.db so that reading it without a tenant scope throws, rather
  // than a route silently querying across customers. Must precede every route.
  await app.register(registerAuthPlugin);

  // The v1 identity plane. Everything tenant-scoped lives under
  // /api/v1/w/:workspaceId/..., so the tenant is a path segment rather than
  // ambient state — see auth/tokens.ts for why.
  await app.register(authV1Routes);
  await app.register(meV1Routes);
  await app.register(workspaceV1Routes);
  await app.register(teamV1Routes);

  return app;
}

async function main() {
  // Refuse to start if any model carrying workspace_id is missing from
  // TENANT_MODELS. That registry is what makes db/tenant.ts inject scoping, so an
  // unregistered tenant table would run UNSCOPED and leak across customers. A
  // failed boot is the only acceptable outcome; there is no safe degraded mode.
  assertTenantModelsRegistered();

  // Migrations run automatically on boot (idempotent).
  await runMigrations();
  // Optionally seed the first admin from SEED_ADMIN_* (no-op once one exists).
  await ensureSeedAdmin();

  const app = await buildServer();
  await app.listen({ host: env.HOST, port: env.PORT });
  // eslint-disable-next-line no-console
  console.log(`[nestled] listening on http://${env.HOST}:${env.PORT}`);

  const shutdown = async () => {
    await app.close();
    await unscopedPrisma.$disconnect();
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
    console.error('[nestled] fatal boot error', err);
    process.exit(1);
  });
}
