import { startRetentionJob } from './retention.js';
import { RESTORE_WINDOW_DAYS, purgeExpiredDeletions } from './deletions.js';
import { runBillingLifecycle } from '../services/billing/index.js';
import { startResponseTargetSweep } from '../services/responseTargets.js';
import { recordJobRun } from '../services/platform/metrics.js';

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

/**
 * Deletions whose reversal window has closed.
 *
 * The only job here that removes data permanently, and the one whose failure is least
 * visible: nothing breaks when it stops running, data simply outlives the window we
 * promised. So it is timed and recorded like the retention sweep — ops → Health can
 * then answer "did this actually run?", which is the only way a silently dead sweep is
 * ever noticed.
 *
 * Daily, and once at boot. A day late is harmless against a 90-day window; what is not
 * harmless is a container that restarts every night and therefore never reaches its
 * first interval.
 */
function startDeletionPurgeJob(): void {
  const run = async () => {
    const started = Date.now();
    try {
      const report = await purgeExpiredDeletions();
      recordJobRun('deletion_purge', { at: new Date(), ok: true, durationMs: Date.now() - started });
      if (report.purged > 0 || report.failed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[deletions] purged ${report.purged} past ${RESTORE_WINDOW_DAYS}d`, report.byType);
      }
    } catch (err) {
      recordJobRun('deletion_purge', {
        at: new Date(),
        ok: false,
        durationMs: Date.now() - started,
        error: (err as Error).message,
      });
      // eslint-disable-next-line no-console
      console.error('[deletions] purge sweep failed', err);
    }
  };
  void run();
  setInterval(() => void run(), DAY_MS).unref();
}

export function startBackgroundJobs(): void {
  // Delete resolved conversations past their retention window (env-gated).
  startRetentionJob();
  // Trial expiry, dunning transitions, the purge sweep and Stripe customer backfill.
  startBillingLifecycleJob();
  // Hard-delete what an operator deleted on purpose and nobody restored in 90 days.
  startDeletionPurgeJob();
  // Missed response deadlines: reassign and announce them. Every MINUTE, unlike the
  // sweeps above, because the whole value is escalating while the conversation can
  // still be answered — a daily pass would be a report, which is what this replaces.
  startResponseTargetSweep();
}
