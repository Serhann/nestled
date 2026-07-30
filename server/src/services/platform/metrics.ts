/**
 * In-process operational counters, read by the ops health page.
 *
 * Deliberately NOT a database table. These are "is the box healthy right now"
 * numbers, not business facts: they reset on deploy, and that is the correct
 * semantics — a push failure from three restarts ago tells you nothing, and paying
 * a write per failed push to learn otherwise is a bad trade. Anything that must
 * survive a restart belongs in `audit_log` or its own table instead.
 *
 * Single-replica, like the rest of the realtime plane (see realtime/hub.ts). With a
 * second replica each process reports its own numbers, which is why the health
 * endpoint labels them per-process rather than pretending they are a cluster total.
 */

export interface JobRun {
  at: Date;
  ok: boolean;
  durationMs: number;
  error?: string;
}

const jobRuns = new Map<string, JobRun>();
const counters = new Map<string, number>();

const startedAt = new Date();

/** Record the outcome of a background sweep. The health page reads the latest. */
export function recordJobRun(name: string, run: JobRun): void {
  jobRuns.set(name, run);
}

export function lastJobRun(name: string): JobRun | null {
  return jobRuns.get(name) ?? null;
}

export function bump(counter: string, by = 1): void {
  counters.set(counter, (counters.get(counter) ?? 0) + by);
}

export function counter(name: string): number {
  return counters.get(name) ?? 0;
}

/**
 * A failed Web Push send. `status` is the push service's HTTP code; 404/410 mean
 * the device is gone and are counted separately from a real fault, because a
 * pruned subscription is housekeeping and a 500 from the push service is an
 * incident.
 */
export function recordPushFailure(status: number | undefined): void {
  bump('push.failed');
  if (status === 404 || status === 410) bump('push.expired');
  else bump('push.error');
}

/**
 * An unhandled promise rejection that lib/crashGuard.ts contained.
 *
 * Counted rather than only logged because the whole risk of surviving one is that nobody
 * notices. The most recent message is kept too: "12 of these happened" sends somebody to
 * the logs, "12, the last was `Vapid private key should be 32 bytes long`" sends them to
 * the setting.
 */
export function recordUnhandledRejection(message: string): void {
  bump('process.unhandled_rejections');
  lastRejection = { at: new Date(), message: message.slice(0, 300) };
}

let lastRejection: { at: Date; message: string } | null = null;

export function lastUnhandledRejection(): { at: Date; message: string } | null {
  return lastRejection;
}

export function processStartedAt(): Date {
  return startedAt;
}

/** Test seam: these are module-level, and tests assert on exact values. */
export function resetMetrics(): void {
  jobRuns.clear();
  counters.clear();
  lastRejection = null;
}
