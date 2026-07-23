import { prisma } from '../db/prisma.js';
import type { GeoLocation } from './geo.js';

/**
 * Record an IP a visitor connected from. Upserts by (visitor_id, ip) so every
 * distinct IP is kept — even when the visitor's IP changes over time. Best-effort
 * and never throws into the request path.
 */
export async function recordVisitorIp(
  visitorId: string | null | undefined,
  ip: string,
  geo: GeoLocation | null,
): Promise<void> {
  if (!visitorId || !ip || ip === 'unknown') return;
  try {
    const existing = await prisma.visitor_ips.findUnique({
      where: { visitor_id_ip: { visitor_id: visitorId, ip } },
      select: { id: true },
    });
    if (existing) {
      await prisma.visitor_ips.update({
        where: { id: existing.id },
        data: { hits: { increment: 1 }, last_seen: new Date(), ...(geo ? { geo: geo as object } : {}) },
      });
    } else {
      await prisma.visitor_ips.create({
        data: { visitor_id: visitorId, ip, geo: (geo ?? undefined) as object | undefined },
      });
    }
  } catch {
    /* tracking is best-effort */
  }
}
