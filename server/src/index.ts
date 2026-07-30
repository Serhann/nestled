import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { env, allowedOrigins, isProd } from './env.js';
import { unscopedPrisma } from './db/unscoped.js';
import { runMigrations } from './db/migrate.js';
import { ensureSeedAdmin } from './db/seedAdmin.js';
import { ensureSeedPlatformUser } from './db/seedPlatform.js';
import { startBackgroundJobs } from './lib/jobs.js';
import { registerClientIp } from './lib/clientIp.js';
import { installCrashGuard } from './lib/crashGuard.js';
import { assertTenantModelsRegistered } from './db/tenant.js';
import { registerAuthPlugin } from './plugins/auth.js';
import { registerRealtime } from './realtime/gateway.js';
import { authV1Routes } from './routes/v1/auth.js';
import { meV1Routes } from './routes/v1/me.js';
import { twoFactorV1Routes } from './routes/v1/twoFactor.js';
import { workspaceV1Routes } from './routes/v1/workspaces.js';
import { teamV1Routes } from './routes/v1/team.js';
import { widgetV1Routes } from './routes/v1/widget.js';
import { conversationV1Routes } from './routes/v1/conversations.js';
import { channelRoutes } from './routes/v1/channels.js';
import { reportRoutes } from './routes/v1/reports.js';
import { contentV1Routes } from './routes/v1/content.js';
import { settingsV1Routes } from './routes/v1/settings.js';
import { presenceV1Routes } from './routes/v1/presence.js';
import { pushV1Routes } from './routes/v1/push.js';
import { supportV1Routes } from './routes/v1/support.js';
import { automationV1Routes } from './routes/v1/automation.js';
import { billingV1Routes } from './routes/v1/billing.js';
import { platformRoutes } from './routes/platform/index.js';
import { loadSettings, settings, startSettingsRefresh } from './services/platform/settings.js';

export async function buildServer() {
  // Install-wide settings (AI keys, SMTP, Stripe, GeoIP) live in the database and
  // are edited from the ops panel. They are loaded into a synchronous snapshot
  // BEFORE any route or plugin reads one, because half the consumers are sync
  // functions and making them async would ripple through the whole codebase.
  await loadSettings();

  const app = Fastify({
    // Trust the reverse proxy so `req.ip` reflects X-Forwarded-For behind nginx
    // rather than the container network address. Note `req.ip` is the FALLBACK, not
    // the answer: what the app attributes a request to is `req.clientIp`
    // (lib/clientIp.ts), which behind a CDN reads the header that CDN controls.
    trustProxy: true,
    logger: env.NODE_ENV === 'test' ? false : isProd ? true : { transport: undefined },
  });

  // `req.clientIp` — before anything that reads an IP, which is the rate limiter
  // below, every route, and the WebSocket gateway.
  registerClientIp(app);

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
      // Keyed on the resolved client IP, not the plugin's default `req.ip`. Behind
      // Cloudflare the default is an edge address shared by everyone it relays, so
      // one busy site would spend the budget of every visitor in that region — a
      // rate limiter that turns into an outage for strangers.
      keyGenerator: (req) => req.clientIp,
    });
  }

  await app.register(websocket);

  // Attachment uploads (per-file size cap enforced here).
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });

  /**
   * Form-encoded bodies, for one caller: Twilio's inbound SMS webhook.
   *
   * Eight lines instead of @fastify/formbody, because that is the entire feature we
   * need from it. `URLSearchParams` collapses repeated keys to the last value, which
   * is correct here — Twilio sends none — and the 1 MB cap is well above an SMS and
   * well below anything worth buffering from an unauthenticated caller.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1_000_000 },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
    if (settings().ops.sentryDsn) {
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

  // Realtime sockets.
  await app.register(registerRealtime);

  // Everything tenant-scoped lives under /api/v1/w/:workspaceId/..., so the tenant
  // is a path segment rather than ambient state — see auth/tokens.ts for why.
  await app.register(authV1Routes);
  await app.register(meV1Routes);
  await app.register(twoFactorV1Routes);
  await app.register(workspaceV1Routes);
  await app.register(teamV1Routes);
  await app.register(conversationV1Routes);
  await app.register(contentV1Routes);
  await app.register(settingsV1Routes);
  await app.register(presenceV1Routes);
  await app.register(pushV1Routes);
  await app.register(supportV1Routes);
  await app.register(automationV1Routes);
  await app.register(billingV1Routes);
  await app.register(reportRoutes);

  // Inbound channel webhooks. Unauthenticated callers, so each one verifies its
  // provider's signature before believing a word of the body — see routes/v1/channels.
  await app.register(channelRoutes);

  // The vendor's own surface. Mounted under /platform/*, authenticated by opaque
  // staff sessions rather than the customer JWT — the two never overlap.
  await app.register(platformRoutes);

  // The PUBLIC widget plane, registered last. It is the only surface an anonymous
  // visitor on a customer's site can reach, and it resolves its tenant from an
  // unguessable website key rather than any ambient context.
  await app.register(widgetV1Routes);

  return app;
}

async function main() {
  // Before anything else can reject: a fire-and-forget call that throws must not take
  // the process — and every request in flight with it — down. See lib/crashGuard.ts for
  // the 502 that made this necessary.
  installCrashGuard();

  // Refuse to start if any model carrying workspace_id is missing from
  // TENANT_MODELS. That registry is what makes db/tenant.ts inject scoping, so an
  // unregistered tenant table would run UNSCOPED and leak across customers. A
  // failed boot is the only acceptable outcome; there is no safe degraded mode.
  assertTenantModelsRegistered();

  // Migrations, unless a release step already ran them (see env.MIGRATE_ON_BOOT).
  if (env.MIGRATE_ON_BOOT === 'true') {
    await runMigrations();
  }
  // Optionally seed the first admin from SEED_ADMIN_* (no-op once one exists).
  await ensureSeedAdmin();
  // Optionally bootstrap the first ops-panel staff account from SEED_PLATFORM_*.
  await ensureSeedPlatformUser();

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

  // Recurring sweeps: retention, and (Phase 12) trial/dunning/purge. See lib/jobs.ts.
  startBackgroundJobs();
  // A safety net, not the mechanism: a write from the ops panel refreshes the
  // snapshot immediately. This catches a value changed straight in the database.
  startSettingsRefresh();
}

// Boot everywhere except the test runner (tests import buildServer directly).
if (env.NODE_ENV !== 'test') {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[nestled] fatal boot error', err);
    process.exit(1);
  });
}
