import type { FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

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
    await query(
      `INSERT INTO audit_log (agent_id, agent_email, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.agent?.id ?? null,
        req.agent?.email ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.details ?? {},
        req.ip,
      ],
    );
  } catch (err) {
    req.log.error({ err }, 'failed to write audit log');
  }
}
