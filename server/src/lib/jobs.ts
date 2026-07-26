import { startRetentionJob } from './retention.js';
import { runBillingLifecycle } from '../services/billing/index.js';

/**
 * Every recurring background job, started from one place.
 *
 * These run in-process, which is the same one-replica assumption the realtime
 * layer already makes (see DEPLOY.md). Two replicas would run each job twice —
 * acceptable for the idempotent sweeps here, but it is the reason a second
 * replica needs the Redis bus and an external scheduler together, not separately.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trial expiry, the dunning ladder and the purge sweep.
 *
 * All three are clock transitions — things that become true because time passed —
 * so no webhook will ever deliver them. See services/billing/lifecycle.ts for the
 * ladder and why each grace window is as long as it is.
 *
 * It runs once at boot as well as daily, so a server that was down over a window
 * boundary catches up on start rather than a day late.
 */
function startBillingLifecycleJob(): void {
  const run = () =>
    runBillingLifecycle()
      .then((report) => {
        const moved = Object.values(report).reduce((a, b) => a + b, 0);
        if (moved > 0) {
          // eslint-disable-next-line no-console
          console.log('[billing] lifecycle sweep', report);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[billing] lifecycle sweep failed', err);
      });
  void run();
  setInterval(() => void run(), DAY_MS).unref();
}

export function startBackgroundJobs(): void {
  // Delete resolved conversations past their retention window (env-gated).
  startRetentionJob();
  // Trial expiry, dunning transitions, the purge sweep and Stripe customer backfill.
  startBillingLifecycleJob();
}
