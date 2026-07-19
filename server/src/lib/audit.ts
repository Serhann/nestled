import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma.js';

interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Record an admin/agent action. Best-effort: an audit write must never break
 * the request it describes, so failures are logged and swallowed.
 */
export async function audit(req: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    await prisma.audit_log.create({
      data: {
        agent_id: req.agent?.id ?? null,
        agent_email: req.agent?.email ?? null,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        details: (entry.details ?? {}) as object,
        ip_address: req.ip,
      },
    });
  } catch (err) {
    req.log.error({ err }, 'failed to write audit log');
  }
}
