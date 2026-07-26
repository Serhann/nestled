// Called from the presence socket and the widget plane, each of which passes the
// workspace it resolved from a signed token.
// eslint-disable-next-line no-restricted-imports -- writes for a caller-supplied workspace
import { unscopedPrisma } from '../db/unscoped.js';
import type { GeoLocation } from './geo.js';

/**
 * Record an IP a visitor connected from, upserting by (workspace, visitor, ip) so
 * every distinct address is kept as the visitor moves between networks.
 *
 * Best-effort: tracking must never throw into the request path it observes.
 */
export async function recordVisitorIp(
  workspaceId: string,
  visitorId: string | null | undefined,
  ip: string,
  geo: GeoLocation | null,
): Promise<void> {
  if (!workspaceId || !visitorId || !ip || ip === 'unknown') return;
  try {
    // A single atomic upsert rather than find-then-write: two page loads racing
    // would otherwise both see "absent" and one insert would fail.
    await unscopedPrisma.$executeRaw`
      INSERT INTO visitor_ips (id, workspace_id, visitor_id, ip, geo, hits, first_seen, last_seen)
      VALUES (gen_random_uuid(), ${workspaceId}::uuid, ${visitorId}, ${ip},
              ${geo ? JSON.stringify(geo) : null}::jsonb, 1, now(), now())
      ON CONFLICT (workspace_id, visitor_id, ip)
      DO UPDATE SET hits = visitor_ips.hits + 1,
                    last_seen = now(),
                    geo = COALESCE(EXCLUDED.geo, visitor_ips.geo)
    `;
  } catch {
    /* tracking is best-effort */
  }
}
