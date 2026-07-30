import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
// Deletion from the ops panel is cross-tenant by definition: the actor is staff, and
// the whole point is to reach a row inside a workspace nobody is signed in to.
// eslint-disable-next-line no-restricted-imports -- the vendor plane is cross-tenant
import { unscopedPrisma } from '../db/unscoped.js';
import { invalidateWorkspaceCache } from '../plugins/auth.js';

/**
 * Reversible deletion, and the sweep that finally makes it permanent.
 *
 * ── The rule that shapes everything here ────────────────────────────────────────
 *
 * Deleting a workspace has to take its websites and conversations with it, or a
 * deleted customer's widget keeps answering visitors. But some of those websites may
 * have been deleted weeks earlier by the customer, and undoing the workspace must not
 * bring those back. So a deletion is not "set a flag" — it is a recorded act that
 * names EXACTLY the rows whose `deleted_at` it set, and restore reverses that list and
 * nothing else. That record is `deletion_events`; see migration 0011.
 *
 * ── What is deletable, and what each type takes with it ─────────────────────────
 *
 *   workspace     the workspace, its live websites, its live conversations.
 *                 NOT its users: login is global and an agency user belongs to other
 *                 customers too. Removing a workspace must not lock someone out of a
 *                 different one.
 *   website       the website and its live conversations.
 *   user          the user only. Memberships stay, so a restore puts them back where
 *                 they were rather than in a workspace with no members.
 *   conversation  the conversation. Its messages, attachments and notes are reached
 *                 through it and die with it only on the hard delete, by cascade.
 *
 * ── Why the sweep is allowed to hard delete ────────────────────────────────────
 *
 * services/billing/lifecycle.ts states that hard removal is a deliberate operator
 * action rather than something a cron job does at 3am, and that still holds: this
 * sweep only ever removes rows named in a `deletion_events` row — deleted on purpose,
 * by a named actor, with a stated reason, at least RESTORE_WINDOW_DAYS ago. It makes
 * no decisions; it carries out one whose reversal window has closed. A workspace
 * soft-deleted by the billing purge has no event and is never touched by it.
 */

/** The reversal window. One constant; DEPLOY.md quotes it. */
export const RESTORE_WINDOW_DAYS = 90;

export const DELETABLE_TYPES = ['workspace', 'website', 'user', 'conversation'] as const;
export type DeletableType = (typeof DELETABLE_TYPES)[number];

export interface DeletionActor {
  type: 'platform_user' | 'user' | 'system';
  id: string | null;
  email: string | null;
}

/** The rows one act of deletion flipped, as stored in `deletion_events.targets`. */
interface TargetSet {
  table: 'workspaces' | 'websites' | 'users' | 'conversations';
  ids: string[];
}

export type SoftDeleteOutcome =
  | {
      ok: true;
      eventId: string;
      targets: TargetSet[];
      /** Whose workspace this belonged to. NULL for a user, who belongs to several. */
      workspaceId: string | null;
      /** Name, slug or email as it read at deletion time. */
      label: string | null;
    }
  | { ok: false; code: 'not_found' | 'already_deleted' };

export type RestoreOutcome =
  | { ok: true; restored: Record<string, number> }
  | { ok: false; code: 'not_found' | 'already_restored' | 'already_purged' };

/**
 * Soft-delete a thing and record how to undo it.
 *
 * One transaction: a flipped row with no event is an unreversible deletion, and an
 * event with no flipped rows is a restore button that does nothing.
 */
export async function softDelete(input: {
  type: DeletableType;
  id: string;
  reason: string;
  actor: DeletionActor;
  now?: Date;
}): Promise<SoftDeleteOutcome> {
  const now = input.now ?? new Date();

  const outcome = await unscopedPrisma.$transaction(async (tx): Promise<SoftDeleteOutcome> => {
    let workspaceId: string | null = null;
    let label: string | null = null;
    const targets: TargetSet[] = [];

    switch (input.type) {
      case 'workspace': {
        const row = await tx.workspaces.findUnique({
          where: { id: input.id },
          select: { id: true, name: true, deleted_at: true },
        });
        if (!row) return { ok: false, code: 'not_found' };
        if (row.deleted_at) return { ok: false, code: 'already_deleted' };
        workspaceId = row.id;
        label = row.name;

        // Read the ids BEFORE flipping them: the set of rows this act is responsible
        // for is "those that were live a moment ago", and after the UPDATE there is no
        // way to tell them from the ones that were already deleted.
        const websites = await tx.websites.findMany({
          where: { workspace_id: row.id, deleted_at: null },
          select: { id: true },
        });
        const conversations = await tx.conversations.findMany({
          where: { workspace_id: row.id, deleted_at: null },
          select: { id: true },
        });

        await tx.workspaces.update({ where: { id: row.id }, data: { deleted_at: now } });
        if (websites.length > 0) {
          await tx.websites.updateMany({
            where: { id: { in: websites.map((w) => w.id) } },
            data: { deleted_at: now },
          });
        }
        if (conversations.length > 0) {
          await tx.conversations.updateMany({
            where: { id: { in: conversations.map((c) => c.id) } },
            data: { deleted_at: now },
          });
        }

        targets.push({ table: 'workspaces', ids: [row.id] });
        if (websites.length > 0) targets.push({ table: 'websites', ids: websites.map((w) => w.id) });
        if (conversations.length > 0) {
          targets.push({ table: 'conversations', ids: conversations.map((c) => c.id) });
        }
        break;
      }

      case 'website': {
        const row = await tx.websites.findUnique({
          where: { id: input.id },
          select: { id: true, name: true, workspace_id: true, deleted_at: true },
        });
        if (!row) return { ok: false, code: 'not_found' };
        if (row.deleted_at) return { ok: false, code: 'already_deleted' };
        workspaceId = row.workspace_id;
        label = row.name;

        const conversations = await tx.conversations.findMany({
          where: { website_id: row.id, deleted_at: null },
          select: { id: true },
        });

        // `is_active: false` as well as the timestamp: every widget boot check reads
        // both, and a deleted website that is still flagged active is one forgotten
        // predicate away from serving.
        await tx.websites.update({
          where: { id: row.id },
          data: { deleted_at: now, is_active: false },
        });
        if (conversations.length > 0) {
          await tx.conversations.updateMany({
            where: { id: { in: conversations.map((c) => c.id) } },
            data: { deleted_at: now },
          });
        }

        targets.push({ table: 'websites', ids: [row.id] });
        if (conversations.length > 0) {
          targets.push({ table: 'conversations', ids: conversations.map((c) => c.id) });
        }
        break;
      }

      case 'user': {
        const row = await tx.users.findUnique({
          where: { id: input.id },
          select: { id: true, email: true, deleted_at: true },
        });
        if (!row) return { ok: false, code: 'not_found' };
        if (row.deleted_at) return { ok: false, code: 'already_deleted' };
        label = row.email;

        await tx.users.update({ where: { id: row.id }, data: { deleted_at: now } });
        // Their refresh tokens go, so the deletion takes effect on the next token
        // refresh rather than whenever they happen to sign out. This is deliberately
        // NOT in `targets`: a restore gives them their account back, not their old
        // session, and signing in again is not data loss.
        await tx.refresh_tokens.deleteMany({ where: { user_id: row.id } });

        targets.push({ table: 'users', ids: [row.id] });
        break;
      }

      case 'conversation': {
        const row = await tx.conversations.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            workspace_id: true,
            visitor_name: true,
            visitor_email: true,
            channel_address: true,
            deleted_at: true,
          },
        });
        if (!row) return { ok: false, code: 'not_found' };
        if (row.deleted_at) return { ok: false, code: 'already_deleted' };
        workspaceId = row.workspace_id;
        label = row.visitor_name ?? row.visitor_email ?? row.channel_address ?? 'Conversation';

        await tx.conversations.update({ where: { id: row.id }, data: { deleted_at: now } });
        targets.push({ table: 'conversations', ids: [row.id] });
        break;
      }
    }

    const event = await tx.deletion_events.create({
      data: {
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        actor_email: input.actor.email,
        workspace_id: workspaceId,
        target_type: input.type,
        target_id: input.id,
        target_label: label,
        reason: input.reason,
        targets: targets as object,
        purge_after: new Date(now.getTime() + RESTORE_WINDOW_DAYS * 86_400_000),
      },
      select: { id: true },
    });

    return { ok: true, eventId: event.id, targets, workspaceId, label };
  });

  // The auth plugin caches a workspace's plan and status for 30 seconds. A deletion
  // that takes effect on the next cache expiry is a deletion that served one more
  // page of a deleted customer's data.
  if (outcome.ok) invalidateAffected(outcome.targets);
  return outcome;
}

/**
 * Undo one recorded deletion, exactly.
 *
 * Rows that have since vanished (their parent was purged) simply do not come back;
 * `restored` reports what actually moved so the caller can say so rather than claim a
 * full recovery. Allowed until the sweep has run, even slightly past `purge_after` —
 * the window is a promise about when we stop keeping data, not a race the operator
 * has to win by an hour.
 */
export async function restoreDeletion(input: {
  eventId: string;
  actorId: string | null;
  now?: Date;
}): Promise<RestoreOutcome> {
  const now = input.now ?? new Date();

  const event = await unscopedPrisma.deletion_events.findUnique({
    where: { id: input.eventId },
    select: { id: true, targets: true, restored_at: true, purged_at: true },
  });
  if (!event) return { ok: false, code: 'not_found' };
  if (event.purged_at) return { ok: false, code: 'already_purged' };
  if (event.restored_at) return { ok: false, code: 'already_restored' };

  const targets = readTargets(event.targets);
  const restored: Record<string, number> = {};

  await unscopedPrisma.$transaction(async (tx) => {
    for (const set of targets) {
      if (set.ids.length === 0) continue;
      const where = { id: { in: set.ids } };
      const count =
        set.table === 'workspaces'
          ? (await tx.workspaces.updateMany({ where, data: { deleted_at: null } })).count
          : set.table === 'websites'
            ? (await tx.websites.updateMany({ where, data: { deleted_at: null } })).count
            : set.table === 'users'
              ? (await tx.users.updateMany({ where, data: { deleted_at: null } })).count
              : (await tx.conversations.updateMany({ where, data: { deleted_at: null } })).count;
      restored[set.table] = count;
    }

    // Conditional on still being pending, so a restore that raced the sweep loses
    // rather than recording an outcome the CHECK constraint forbids.
    await tx.deletion_events.updateMany({
      where: { id: event.id, restored_at: null, purged_at: null },
      data: { restored_at: now, restored_by: input.actorId },
    });
  });

  // A restored website is deliberately left `is_active: false`. Bringing a widget back
  // up on a customer's live site is their call to make, not a side effect of undoing a
  // mistake in our panel.
  invalidateAffected(targets);
  return { ok: true, restored };
}

export interface PurgeReport {
  /** Events whose reversal window closed and whose rows are now gone. */
  purged: number;
  /** Events the sweep could not complete. They stay pending and are retried. */
  failed: number;
  byType: Record<string, number>;
}

/**
 * Hard-delete what was never restored.
 *
 * Blobs before rows, for the same reason retention.ts does it in that order: a deleted
 * `stored_files` row is a file on disk nobody will ever find again, and the opposite
 * order leaks disk forever.
 *
 * Each event is independent — one failure must not stop the sweep, or a single
 * undeletable row keeps every other customer's data past the window we promised.
 */
export async function purgeExpiredDeletions(now: Date = new Date()): Promise<PurgeReport> {
  const due = await unscopedPrisma.deletion_events.findMany({
    where: { restored_at: null, purged_at: null, purge_after: { lt: now } },
    orderBy: { purge_after: 'asc' },
    take: 200,
    select: { id: true, target_type: true, target_id: true, workspace_id: true },
  });

  const report: PurgeReport = { purged: 0, failed: 0, byType: {} };

  for (const event of due) {
    try {
      await removeBlobs(event.target_type as DeletableType, event.target_id);

      // deleteMany rather than delete: a row already gone (its parent was purged
      // first, or an operator removed it by hand) is the desired end state, not an
      // error that should keep this event pending forever.
      const where = { id: event.target_id };
      switch (event.target_type as DeletableType) {
        case 'workspace':
          await unscopedPrisma.workspaces.deleteMany({ where });
          break;
        case 'website':
          await unscopedPrisma.websites.deleteMany({ where });
          break;
        case 'user':
          await unscopedPrisma.users.deleteMany({ where });
          break;
        case 'conversation':
          await unscopedPrisma.conversations.deleteMany({ where });
          break;
      }

      await unscopedPrisma.deletion_events.updateMany({
        where: { id: event.id, restored_at: null, purged_at: null },
        data: { purged_at: now },
      });

      // The event row survives its workspace (workspace_id is ON DELETE SET NULL) and
      // `target_label` was captured at deletion time, so the log still names what was
      // removed. This audit row is the same promise for the audit trail: `audit_log`
      // rows for a purged workspace are cascade-deleted with it, so a platform-scoped
      // one (workspace_id NULL) is what remains to say we did this.
      await unscopedPrisma.audit_log
        .create({
          data: {
            workspace_id: null,
            actor_type: 'system',
            action: 'platform.deletion_purged',
            target_type: event.target_type,
            target_id: event.target_id,
            details: {
              deletion_event_id: event.id,
              workspace_id: event.workspace_id,
              window_days: RESTORE_WINDOW_DAYS,
            } as object,
          },
        })
        .catch(() => undefined);

      if (event.workspace_id) invalidateWorkspaceCache(event.workspace_id);
      report.purged += 1;
      report.byType[event.target_type] = (report.byType[event.target_type] ?? 0) + 1;
    } catch (err) {
      report.failed += 1;
      // eslint-disable-next-line no-console
      console.error(`[deletions] purge failed for ${event.target_type} ${event.target_id}`, err);
    }
  }

  return report;
}

/**
 * Remove the files that are about to lose their rows.
 *
 * `stored_files` is the single place a storage key lives, which is what makes this one
 * function rather than a search of the filesystem — and what will make S3 one change
 * here rather than a rewrite.
 */
async function removeBlobs(type: DeletableType, id: string): Promise<void> {
  const where =
    type === 'workspace'
      ? { workspace_id: id }
      : type === 'website'
        ? { attachments: { some: { conversation: { website_id: id } } } }
        : type === 'conversation'
          ? { attachments: { some: { conversation_id: id } } }
          : null;
  // A user owns no files: their avatar row is `ON DELETE SET NULL` and the file
  // belongs to a workspace that is still live.
  if (!where) return;

  const files = await unscopedPrisma.stored_files.findMany({
    where,
    select: { id: true, storage_key: true, backend: true },
  });
  for (const file of files) {
    if (file.backend !== 'local') continue; // S3 cleanup lands with S3 support
    await rm(join(env.UPLOAD_DIR, file.storage_key), { force: true }).catch(() => undefined);
  }
  if (files.length > 0) {
    // The rows for a workspace or conversation would cascade anyway; deleting them
    // here keeps "blob gone, row gone" in one place instead of split across a cascade.
    await unscopedPrisma.stored_files
      .deleteMany({ where: { id: { in: files.map((f) => f.id) } } })
      .catch(() => undefined);
  }
}

/** `targets` comes back from Prisma as `Json`. Read it defensively. */
function readTargets(value: unknown): TargetSet[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is TargetSet =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as TargetSet).table === 'string' &&
      Array.isArray((entry as TargetSet).ids),
  );
}

function invalidateAffected(targets: TargetSet[]): void {
  for (const set of targets) {
    if (set.table !== 'workspaces') continue;
    for (const id of set.ids) invalidateWorkspaceCache(id);
  }
}
