import type { FastifyRequest } from 'fastify';
// Audit spans both planes and `workspace_id` is NULLABLE here (NULL = a
// platform-level action), so a workspace-scoped client could neither write a
// staff action nor a pre-tenant one like signup.
// eslint-disable-next-line no-restricted-imports -- audit_log is intentionally unscoped
import { unscopedPrisma } from '../db/unscoped.js';

interface AuditEntry {
  action: string;
  /** NULL = a platform-level action not attributable to one customer. */
  workspaceId?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Record an action.
 *
 * Best-effort: an audit write must never break the request it describes, so
 * failures are logged and swallowed.
 *
 * A staff action performed ON a workspace is written into THAT workspace's log,
 * visible to the customer — half of what makes impersonation defensible (the other
 * half being the impersonation_sessions list, which has no delete). The actor is
 * resolved from the request, so an impersonated request is recorded as the platform
 * user driving it rather than as the customer whose session it borrows.
 */
export async function audit(req: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    const impersonation = req.auth?.impersonation;
    const actor = impersonation
      ? {
          actor_type: 'platform_user',
          actor_id: impersonation.platformUserId,
          actor_email: null,
        }
      : req.platform
        ? { actor_type: 'platform_user', actor_id: req.platform.id, actor_email: req.platform.email }
        : req.auth
          ? { actor_type: 'user', actor_id: req.auth.userId, actor_email: req.auth.email }
          : { actor_type: 'system', actor_id: null, actor_email: null };

    await unscopedPrisma.audit_log.create({
      data: {
        workspace_id: entry.workspaceId ?? req.auth?.workspace?.id ?? null,
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        actor_email: actor.actor_email,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        details: (entry.details ?? {}) as object,
        ip_address: req.ip,
        request_id: String(req.id),
        impersonation_session_id: impersonation?.sessionId ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, 'failed to write audit log');
  }
}
