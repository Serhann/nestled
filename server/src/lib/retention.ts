import { rm } from 'node:fs/promises';
import { env } from '../env.js';
import { query } from '../db/pool.js';

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

  // Delete attachment files for conversations about to be purged.
  const stale = await query<{ storage_path: string }>(
    `SELECT a.storage_path
       FROM attachments a JOIN conversations c ON c.id = a.conversation_id
      WHERE c.status = 'resolved' AND c.updated_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  for (const row of stale.rows) {
    await rm(row.storage_path, { force: true }).catch(() => undefined);
  }

  // Cascades to messages / attachments / notes via FK ON DELETE CASCADE.
  const res = await query(
    `DELETE FROM conversations
      WHERE status = 'resolved' AND updated_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  if (res.rowCount && res.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[retention] purged ${res.rowCount} resolved conversations > ${days}d`);
  }
}

/** Run the sweep on boot and then daily. Errors are logged, never fatal. */
export function startRetentionJob(): void {
  if (env.RETENTION_DAYS <= 0) return;
  const run = () => sweep().catch((err) => console.error('[retention] failed', err));
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
