import { rm } from 'node:fs/promises';
import { env } from '../env.js';
import { prisma } from '../db/prisma.js';

/**
 * Optional data-retention sweep (Phase 10). When RETENTION_DAYS > 0, resolved
 * conversations older than that are deleted (cascading to their messages,
 * attachments rows, notes), and the attachment files on disk are removed first.
 * Presence is in-memory + TTL-swept already, so nothing to do there.
 * No-op when RETENTION_DAYS = 0.
 */
async function sweep(): Promise<void> {
  const days = env.RETENTION_DAYS;
  if (days <= 0) return;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Delete attachment files for conversations about to be purged.
  const stale = await prisma.attachments.findMany({
    where: { conversation: { status: 'resolved', updated_at: { lt: cutoff } } },
    select: { storage_path: true },
  });
  for (const row of stale) {
    await rm(row.storage_path, { force: true }).catch(() => undefined);
  }

  // Cascades to messages / attachments / notes via FK ON DELETE CASCADE.
  const res = await prisma.conversations.deleteMany({
    where: { status: 'resolved', updated_at: { lt: cutoff } },
  });
  if (res.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`[retention] purged ${res.count} resolved conversations > ${days}d`);
  }
}

/** Run the sweep on boot and then daily. Errors are logged, never fatal. */
export function startRetentionJob(): void {
  if (env.RETENTION_DAYS <= 0) return;
  const run = () => sweep().catch((err) => console.error('[retention] failed', err));
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
