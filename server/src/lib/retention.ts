import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
// A retention sweep is cross-tenant by definition: it runs per workspace, honouring
// each one's plan-derived retention window.
// eslint-disable-next-line no-restricted-imports -- background sweep spans workspaces
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * Data-retention sweep.
 *
 * Retention is now PER PLAN, not one global env number: a customer on a plan
 * promising 365 days must not have their history deleted because the install-wide
 * default is 30. `RETENTION_DAYS` survives only as a self-host override, and as the
 * switch that enables the job at all.
 *
 * Files are removed before the rows, because a deleted row is an orphaned file
 * nobody will ever find again — the opposite order leaks disk forever.
 */
async function sweep(): Promise<void> {
  const workspaces = await unscopedPrisma.workspaces.findMany({
    where: { deleted_at: null },
    select: { id: true, plan: { select: { retention_days: true } } },
  });

  for (const ws of workspaces) {
    // The env value, when set, is an override for self-hosting; otherwise the plan
    // decides. 0 on either means "keep forever".
    const days = env.RETENTION_DAYS > 0 ? env.RETENTION_DAYS : ws.plan.retention_days;
    if (days <= 0) continue;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = {
      workspace_id: ws.id,
      status: 'resolved',
      updated_at: { lt: cutoff },
    } as const;

    // Remove the blobs first. `stored_files` is the single place a storage key
    // lives, so there is one path to build and one place to change for S3.
    const stale = await unscopedPrisma.attachments.findMany({
      where: { conversation: where },
      select: { file: { select: { id: true, storage_key: true, backend: true } } },
    });
    for (const row of stale) {
      if (row.file.backend !== 'local') continue; // S3 cleanup lands with S3 support
      await rm(join(env.UPLOAD_DIR, row.file.storage_key), { force: true }).catch(() => undefined);
    }
    if (stale.length > 0) {
      await unscopedPrisma.stored_files
        .deleteMany({ where: { id: { in: stale.map((s) => s.file.id) } } })
        .catch(() => undefined);
    }

    // Cascades to messages / attachments / notes / bot runs via ON DELETE CASCADE.
    const res = await unscopedPrisma.conversations.deleteMany({ where });
    if (res.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[retention] purged ${res.count} resolved conversations >${days}d for workspace ${ws.id}`);
    }
  }

  // Workspaces cancelled long enough ago to be past their purge date. Never done in
  // a webhook: a cancellation is frequently reversed, and "we deleted it instantly"
  // is not recoverable.
  const purgeable = await unscopedPrisma.workspaces.findMany({
    where: { purge_after: { lt: new Date() }, deleted_at: null },
    select: { id: true },
  });
  for (const ws of purgeable) {
    await unscopedPrisma.workspaces
      .update({ where: { id: ws.id }, data: { deleted_at: new Date() } })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.log(`[retention] soft-deleted workspace ${ws.id} past its purge date`);
  }
}

/** Run on boot and then daily. Errors are logged, never fatal. */
export function startRetentionJob(): void {
  const run = () =>
    sweep().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[retention] failed', err);
    });
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
