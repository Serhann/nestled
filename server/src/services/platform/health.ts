import { stat } from 'node:fs/promises';
// Fleet-wide health spans every workspace; there is no tenant to scope it to.
// eslint-disable-next-line no-restricted-imports -- vendor plane, fleet-wide by definition
import { unscopedPrisma } from '../../db/unscoped.js';
import { env } from '../../env.js';
import { socketStats, type SocketStats } from '../../realtime/hub.js';
import { isPushEnabled, pushKeyError } from '../push.js';
import {
  counter,
  lastJobRun,
  lastUnhandledRejection,
  processStartedAt,
  type JobRun,
} from './metrics.js';
import { settings } from './settings.js';

/**
 * The health page.
 *
 * Every number here answers a question someone actually asks during an incident,
 * and each carries a `status` so the page can be read at a glance rather than
 * interpreted. `ok` / `warn` / `fail` is computed server-side deliberately: a
 * threshold that lives in the frontend is a threshold that disagrees with the alert
 * that pages someone at 3am.
 *
 * Realtime and push counts are PER PROCESS (see metrics.ts). With one replica —
 * the deployment this build assumes — that is the whole fleet; the response labels
 * them anyway so a future second replica does not silently halve the numbers.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  status: HealthStatus;
  /** One line, written for someone who has not read this file. */
  detail: string;
}

export interface HealthReport {
  generated_at: string;
  process: {
    started_at: string;
    uptime_seconds: number;
    node_env: string;
    /**
     * Promise rejections lib/crashGuard.ts contained rather than died on. Nonzero means a
     * fire-and-forget call is failing — the process survived, which is the point, but
     * something is broken and the log line names it.
     */
    contained_rejections: number;
    last_contained_rejection: { at: string; message: string } | null;
  };
  database: HealthCheck & { latency_ms: number | null };
  realtime: HealthCheck & SocketStats;
  push: HealthCheck & {
    configured: boolean;
    /** Present when keys ARE set but web-push refuses them — a different job to fix. */
    key_error: string | null;
    failures: number;
    expired_subscriptions: number;
    errors: number;
    stored_subscriptions: number;
  };
  geoip: HealthCheck & {
    source: 'maxmind_web' | 'local_mmdb' | 'disabled';
    path: string | null;
    age_days: number | null;
  };
  retention: HealthCheck & {
    enabled: boolean;
    env_override_days: number;
    last_run: JobRun | null;
  };
  email: HealthCheck & { queued: number; failed: number; smtp_configured: boolean };
  billing: HealthCheck & { unprocessed_stripe_events: number; stripe_configured: boolean };
}

/** A GeoIP database older than this is stale enough that lookups start drifting. */
const GEOIP_WARN_DAYS = 45;
const GEOIP_FAIL_DAYS = 120;
/** Retention runs daily; two missed days means the job is dead, not just late. */
const RETENTION_FAIL_HOURS = 50;

async function databaseCheck(): Promise<HealthReport['database']> {
  const started = Date.now();
  try {
    await unscopedPrisma.$queryRaw`SELECT 1`;
    const latency = Date.now() - started;
    return {
      latency_ms: latency,
      status: latency > 500 ? 'warn' : 'ok',
      detail: `Responded in ${latency} ms`,
    };
  } catch (err) {
    return { latency_ms: null, status: 'fail', detail: (err as Error).message };
  }
}

async function geoipCheck(): Promise<HealthReport['geoip']> {
  // The web service is checked first because when it is configured the local file
  // is never read — reporting a stale .mmdb that nothing consults would send
  // somebody to fix a non-problem.
  if (settings().geo.maxmindAccountId && settings().geo.maxmindLicenseKey) {
    return {
      source: 'maxmind_web',
      path: null,
      age_days: null,
      status: 'ok',
      detail: 'Using the MaxMind web service; no local database to age out',
    };
  }
  if (!settings().geo.dbPath) {
    return {
      source: 'disabled',
      path: null,
      age_days: null,
      // Not a failure: geo is a nice-to-have on the visitor card and the product
      // degrades to "no country flag", nothing more.
      status: 'warn',
      detail: 'No GeoIP source configured — visitor location is unavailable',
    };
  }
  const dbPath = settings().geo.dbPath!;
  try {
    const info = await stat(dbPath);
    const ageDays = Math.floor((Date.now() - info.mtimeMs) / 86_400_000);
    return {
      source: 'local_mmdb',
      path: dbPath,
      age_days: ageDays,
      status: ageDays > GEOIP_FAIL_DAYS ? 'fail' : ageDays > GEOIP_WARN_DAYS ? 'warn' : 'ok',
      detail: `Local database is ${ageDays} day(s) old (MaxMind publishes weekly)`,
    };
  } catch {
    return {
      source: 'local_mmdb',
      path: settings().geo.dbPath,
      age_days: null,
      status: 'fail',
      detail: `GEOLITE2_DB_PATH is set but ${settings().geo.dbPath} cannot be read`,
    };
  }
}

function retentionCheck(): HealthReport['retention'] {
  const last = lastJobRun('retention');
  // The job is registered whenever the process boots (lib/jobs.ts). Whether it
  // DELETES anything is per plan, so "enabled" here means the sweep is scheduled.
  const enabled = env.NODE_ENV !== 'test';
  if (!enabled) {
    return {
      enabled,
      env_override_days: settings().ops.retentionDays,
      last_run: last,
      status: 'ok',
      detail: 'Background sweeps are not started under NODE_ENV=test',
    };
  }
  if (!last) {
    return {
      enabled,
      env_override_days: settings().ops.retentionDays,
      last_run: null,
      status: 'warn',
      detail: 'No sweep has completed since this process started',
    };
  }
  const ageHours = (Date.now() - last.at.getTime()) / 3600_000;
  return {
    enabled,
    env_override_days: settings().ops.retentionDays,
    last_run: last,
    status: !last.ok ? 'fail' : ageHours > RETENTION_FAIL_HOURS ? 'fail' : 'ok',
    detail: last.ok
      ? `Last sweep ${Math.round(ageHours)} h ago, took ${last.durationMs} ms`
      : `Last sweep FAILED: ${last.error ?? 'unknown error'}`,
  };
}

export async function healthReport(): Promise<HealthReport> {
  const [database, geoip, pushSubs, emailCounts, unprocessedEvents] = await Promise.all([
    databaseCheck(),
    geoipCheck(),
    unscopedPrisma.push_subscriptions.count(),
    unscopedPrisma.outbound_emails.groupBy({ by: ['status'], _count: { _all: true } }),
    unscopedPrisma.stripe_events.count({ where: { processed_at: null } }),
  ]);

  const sockets = socketStats();
  const pushFailures = counter('push.failed');
  const pushErrors = counter('push.error');
  const queuedEmails = emailCounts.find((r) => r.status === 'queued')?._count._all ?? 0;
  const failedEmails = emailCounts.find((r) => r.status === 'failed')?._count._all ?? 0;
  const started = processStartedAt();

  return {
    generated_at: new Date().toISOString(),
    process: {
      started_at: started.toISOString(),
      uptime_seconds: Math.floor((Date.now() - started.getTime()) / 1000),
      node_env: env.NODE_ENV,
      contained_rejections: counter('process.unhandled_rejections'),
      last_contained_rejection: (() => {
        const last = lastUnhandledRejection();
        return last ? { at: last.at.toISOString(), message: last.message } : null;
      })(),
    },
    database,
    realtime: {
      ...sockets,
      status: 'ok',
      detail: `${sockets.agentSockets} agent and ${sockets.visitorSockets} visitor sockets across ${sockets.workspacesWithAgents} workspace(s), this process`,
    },
    push: {
      configured: isPushEnabled(),
      key_error: pushKeyError(),
      failures: pushFailures,
      expired_subscriptions: counter('push.expired'),
      errors: pushErrors,
      stored_subscriptions: pushSubs,
      // Expired subscriptions are housekeeping — a replaced phone. Real errors are
      // the push service refusing us, which is the thing worth waking up for.
      // A REFUSED key pair is a fail rather than a warn: somebody configured push
      // expecting it to work, and until 0012 this exact state was crashing the process on
      // every message. "Not configured" stays a warn — that is a choice, not a fault.
      status: pushKeyError()
        ? 'fail'
        : !isPushEnabled()
          ? 'warn'
          : pushErrors > 50
            ? 'fail'
            : pushErrors > 0
              ? 'warn'
              : 'ok',
      detail: pushKeyError()
        ? `The configured VAPID pair is invalid, so push is OFF: ${pushKeyError()}`
        : !isPushEnabled()
          ? 'VAPID keys are not configured — notifications are stored but never sent'
          : `${pushErrors} delivery error(s) and ${counter('push.expired')} pruned device(s) since boot`,
    },
    geoip,
    retention: retentionCheck(),
    email: {
      queued: queuedEmails,
      failed: failedEmails,
      smtp_configured: Boolean(settings().mail.host),
      status: failedEmails > 0 ? 'warn' : queuedEmails > 200 ? 'warn' : 'ok',
      detail: settings().mail.host
        ? `${queuedEmails} queued, ${failedEmails} failed`
        : `No SMTP host — ${queuedEmails} message(s) queued to the database instead of sent`,
    },
    billing: {
      unprocessed_stripe_events: unprocessedEvents,
      stripe_configured: Boolean(settings().billing.secretKey),
      // A backlog here means webhooks are arriving but not being applied, which
      // shows up to customers as a plan that did not change after they paid.
      status: unprocessedEvents > 20 ? 'fail' : unprocessedEvents > 0 ? 'warn' : 'ok',
      detail: `${unprocessedEvents} Stripe event(s) awaiting processing`,
    },
  };
}
