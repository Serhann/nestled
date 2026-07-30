import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import {
  DELETABLE_TYPES,
  RESTORE_WINDOW_DAYS,
  restoreDeletion,
  softDelete,
} from '../../lib/deletions.js';
import { platformRead, platformWrite } from './guards.js';

/**
 * Deletion, its record, and the way back.
 *
 * Three endpoints and one audit view, because the interesting part of deletion is not
 * the delete — it is being able to answer "who removed this, why, and can I get it
 * back?" three weeks later, in front of the customer it happened to.
 *
 * ── Who may delete ──────────────────────────────────────────────────────────────
 *
 * `superadmin` only, which is stricter than the rest of this surface: extending a
 * trial or lifting a suspension is reversible by pulling the same lever the other way,
 * and support pulls those daily. Deletion is reversible for ninety days and then it is
 * not, so it sits with the role that is already trusted with role changes. Restore is
 * open to support as well — undoing is the safe direction, and making someone hunt for
 * a superadmin to recover a customer's inbox is how a five-minute problem becomes an
 * afternoon.
 *
 * ── Why the reason is mandatory ────────────────────────────────────────────────
 *
 * Same rule as the lifecycle levers. In ninety days this row may be the only surviving
 * explanation of why a customer's data is gone, and the person who typed it may not
 * work here any more.
 */

const deleteBody = z.object({
  type: z.enum(DELETABLE_TYPES),
  id: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

const listQuery = z.object({
  status: z.enum(['pending', 'restored', 'purged', 'all']).default('pending'),
  workspace_id: z.string().uuid().optional(),
  type: z.enum(DELETABLE_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

const auditQuery = z.object({
  workspace_id: z.string().uuid().optional(),
  /** Prefix match: `platform.` narrows to staff actions, `platform.workspace_` to levers. */
  action: z.string().max(120).optional(),
  actor_email: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

export async function platformDeletionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/platform/deletions', { preHandler: platformWrite('superadmin') }, async (req, reply) => {
    const body = parseBody(deleteBody, req.body, reply);
    if (!body) return;

    const outcome = await softDelete({
      type: body.type,
      id: body.id,
      reason: body.reason,
      actor: { type: 'platform_user', id: req.platform!.id, email: req.platform!.email },
    });

    if (!outcome.ok) {
      return reply
        .code(outcome.code === 'not_found' ? 404 : 409)
        .send({ error: outcome.code === 'not_found' ? 'Not found' : 'Already deleted', code: outcome.code });
    }

    // Two records, deliberately. `deletion_events` is the machine-readable undo;
    // `audit_log` is the customer-visible history, written into THEIR workspace so a
    // deletion we performed appears in the log they can read — the same rule
    // impersonation follows.
    await audit(req, {
      action: 'platform.deleted',
      // A deleted USER belongs to no single workspace, so their record is
      // platform-scoped. Everything else is written into the customer's own log, where
      // they can read it — the same rule impersonation follows.
      workspaceId: outcome.workspaceId,
      targetType: body.type,
      targetId: body.id,
      details: {
        reason: body.reason,
        deletion_event_id: outcome.eventId,
        label: outcome.label,
        rows: Object.fromEntries(outcome.targets.map((t) => [t.table, t.ids.length])),
        restorable_until_days: RESTORE_WINDOW_DAYS,
      },
    });

    return reply.code(201).send({
      deletion: { id: outcome.eventId, restore_window_days: RESTORE_WINDOW_DAYS },
      affected: Object.fromEntries(outcome.targets.map((t) => [t.table, t.ids.length])),
    });
  });

  app.post(
    '/platform/deletions/:id/restore',
    { preHandler: platformWrite('support', 'billing') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ reason: z.string().min(3).max(500) }), req.body, reply);
      if (!body) return;

      const event = await unscopedPrisma.deletion_events.findUnique({
        where: { id },
        select: { id: true, workspace_id: true, target_type: true, target_id: true, target_label: true },
      });
      if (!event) return reply.code(404).send({ error: 'Not found' });

      const outcome = await restoreDeletion({ eventId: id, actorId: req.platform!.id });
      if (!outcome.ok) {
        const message =
          outcome.code === 'already_purged'
            ? `This was deleted more than ${RESTORE_WINDOW_DAYS} days ago and has been removed for good.`
            : outcome.code === 'already_restored'
              ? 'This deletion has already been undone.'
              : 'Not found';
        return reply.code(outcome.code === 'not_found' ? 404 : 409).send({ error: message, code: outcome.code });
      }

      await audit(req, {
        action: 'platform.deletion_restored',
        workspaceId: event.workspace_id,
        targetType: event.target_type,
        targetId: event.target_id,
        details: { reason: body.reason, deletion_event_id: id, restored: outcome.restored },
      });

      // `restored` counts what actually moved. A website whose workspace was purged
      // cannot come back, and the panel says so rather than showing a success toast
      // over an empty recovery.
      return reply.send({ restored: outcome.restored });
    },
  );

  app.get('/platform/deletions', { preHandler: platformRead }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const q = parsed.data;

    const where = {
      ...(q.workspace_id ? { workspace_id: q.workspace_id } : {}),
      ...(q.type ? { target_type: q.type } : {}),
      ...(q.status === 'pending'
        ? { restored_at: null, purged_at: null }
        : q.status === 'restored'
          ? { restored_at: { not: null } }
          : q.status === 'purged'
            ? { purged_at: { not: null } }
            : {}),
    };

    const [rows, total] = await Promise.all([
      unscopedPrisma.deletion_events.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * q.per_page,
        take: q.per_page,
        select: {
          id: true,
          actor_type: true,
          actor_email: true,
          workspace_id: true,
          target_type: true,
          target_id: true,
          target_label: true,
          reason: true,
          targets: true,
          created_at: true,
          purge_after: true,
          restored_at: true,
          purged_at: true,
          // Null once the workspace itself has been purged, which is why
          // `target_label` exists.
          workspace: { select: { name: true, slug: true } },
        },
      }),
      unscopedPrisma.deletion_events.count({ where }),
    ]);

    return reply.send({
      deletions: rows.map((row) => ({
        ...row,
        /** Days left to undo it. Negative means the sweep has not caught up yet. */
        restore_days_left: Math.ceil((row.purge_after.getTime() - Date.now()) / 86_400_000),
      })),
      total,
      page: q.page,
      per_page: q.per_page,
      restore_window_days: RESTORE_WINDOW_DAYS,
    });
  });

  /**
   * The audit log, across every workspace.
   *
   * `/platform/workspaces/:id/activity` already shows one customer's history; this is
   * the same table read the other way, for "what did we do yesterday" and for finding
   * the deletion somebody is asking about when they cannot remember which workspace it
   * was in.
   */
  app.get('/platform/audit', { preHandler: platformRead }, async (req, reply) => {
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const q = parsed.data;

    const where = {
      ...(q.workspace_id ? { workspace_id: q.workspace_id } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.actor_email ? { actor_email: { contains: q.actor_email, mode: 'insensitive' as const } } : {}),
    };

    const [rows, total] = await Promise.all([
      unscopedPrisma.audit_log.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * q.per_page,
        take: q.per_page,
        select: {
          id: true,
          workspace_id: true,
          actor_type: true,
          actor_email: true,
          action: true,
          target_type: true,
          target_id: true,
          details: true,
          ip_address: true,
          created_at: true,
          impersonation_session_id: true,
          workspace: { select: { name: true, slug: true } },
        },
      }),
      unscopedPrisma.audit_log.count({ where }),
    ]);

    // Which rows the panel may offer an Undo button for. Resolved here rather than in
    // the UI: whether a deletion is still reversible is a fact about `deletion_events`,
    // and a button that appears from a string match on the action name would keep
    // offering to undo things that were purged months ago.
    const eventIds = rows
      .map((row) => (row.details as { deletion_event_id?: string } | null)?.deletion_event_id)
      .filter((id): id is string => typeof id === 'string');
    const pending = eventIds.length
      ? await unscopedPrisma.deletion_events.findMany({
          where: { id: { in: eventIds }, restored_at: null, purged_at: null },
          select: { id: true, purge_after: true },
        })
      : [];
    const restorable = new Map(pending.map((p) => [p.id, p.purge_after]));

    return reply.send({
      entries: rows.map((row) => {
        const eventId = (row.details as { deletion_event_id?: string } | null)?.deletion_event_id;
        const purgeAfter = eventId ? restorable.get(eventId) : undefined;
        return {
          ...row,
          restore: purgeAfter
            ? {
                deletion_event_id: eventId,
                days_left: Math.ceil((purgeAfter.getTime() - Date.now()) / 86_400_000),
              }
            : null,
        };
      }),
      total,
      page: q.page,
      per_page: q.per_page,
    });
  });
}
