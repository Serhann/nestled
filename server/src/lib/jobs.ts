import { startRetentionJob } from './retention.js';

/**
 * Every recurring background job, started from one place.
 *
 * These run in-process, which is the same one-replica assumption the realtime
 * layer already makes (see DEPLOY.md). Two replicas would run each job twice —
 * acceptable for the idempotent sweeps here, but it is the reason a second
 * replica needs the Redis bus and an external scheduler together, not separately.
 */
export function startBackgroundJobs(): void {
  // Delete resolved conversations past their retention window (env-gated).
  startRetentionJob();
}
