import type { FastifyInstance } from 'fastify';
import { requireWorkspace, can } from '../../plugins/auth.js';
import { businessMinutesBetween, type BusinessHoursRow } from '../../lib/businessHours.js';

/**
 * Response-time reporting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two decisions here are what separate this from the reporting people complain about.
 *
 * **Percentiles, not an average.** A mean response time is dominated by the handful of
 * conversations somebody forgot about, so it moves for reasons nobody can act on. p50
 * says "a typical customer waits this long" and p90 says "one in ten waits this long",
 * and those are two different, actionable sentences. An average says neither.
 *
 * **Measured in the same open minutes the promise was made in.** The report reuses
 * `businessMinutesBetween`, the function that set the deadline. If a report counted
 * wall-clock time while the target counted open time, a team would see themselves
 * missing a promise the product says they kept — and then believe neither number.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The window, capped. A year of message rows is not a dashboard query. */
const MAX_DAYS = 90;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank. Interpolating between two samples invents a response time that never
  // happened, which is a strange thing to put on a page about honesty.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/w/:workspaceId/reports/response-times',
    { preHandler: [requireWorkspace, can('conversation:read')] },
    async (req, reply) => {
      const q = req.query as { days?: string; website_id?: string };
      const days = Math.min(Math.max(Number(q.days) || 30, 1), MAX_DAYS);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Through req.db, so a member scoped to one website reports on that website only
      // — otherwise a narrowed agent's dashboard would quietly include work they cannot
      // see, which is both a leak and a confusing number.
      const conversations = await req.db.conversations.findMany({
        where: {
          created_at: { gte: since },
          ...(q.website_id ? { website_id: q.website_id } : {}),
        },
        select: {
          website_id: true,
          channel: true,
          created_at: true,
          first_response_at: true,
          response_breached_at: true,
          status: true,
          assigned_member_id: true,
        },
        take: 20_000,
      });

      // One hours row per website involved, fetched once rather than per conversation.
      const websiteIds = [...new Set(conversations.map((c) => c.website_id))];
      const hoursRows = await req.db.website_business_hours.findMany({
        where: { website_id: { in: websiteIds } },
        select: { website_id: true, enabled: true, timezone: true, rules: true, holidays: true },
      });
      const hoursBy = new Map(hoursRows.map((h) => [h.website_id, h as BusinessHoursRow]));

      const answeredMinutes: number[] = [];
      const byChannel = new Map<string, number[]>();
      let answered = 0;
      let unanswered = 0;
      let breached = 0;

      for (const conv of conversations) {
        if (conv.response_breached_at) breached += 1;
        if (!conv.first_response_at) {
          // Still open with nobody having replied. Counted, not silently dropped: a
          // report that only measures the conversations you DID answer flatters you
          // exactly where it matters least.
          if (conv.status !== 'resolved') unanswered += 1;
          continue;
        }
        answered += 1;
        const minutes = businessMinutesBetween(
          conv.created_at,
          conv.first_response_at,
          hoursBy.get(conv.website_id) ?? null,
        );
        answeredMinutes.push(minutes);
        const list = byChannel.get(conv.channel) ?? [];
        list.push(minutes);
        byChannel.set(conv.channel, list);
      }

      answeredMinutes.sort((a, b) => a - b);

      return reply.send({
        days,
        total: conversations.length,
        answered,
        /** Open, and nobody has replied. The number a manager actually wants. */
        unanswered,
        breached,
        first_response_minutes: {
          p50: percentile(answeredMinutes, 50),
          p90: percentile(answeredMinutes, 90),
          fastest: answeredMinutes[0] ?? null,
          slowest: answeredMinutes[answeredMinutes.length - 1] ?? null,
        },
        by_channel: [...byChannel.entries()]
          .map(([channel, minutes]) => {
            const sorted = [...minutes].sort((a, b) => a - b);
            return {
              channel,
              answered: sorted.length,
              p50: percentile(sorted, 50),
              p90: percentile(sorted, 90),
            };
          })
          .sort((a, b) => b.answered - a.answered),
        /**
         * Stated rather than implied: every duration above is in OPEN minutes, the same
         * unit the targets are set in. A reader who assumes wall-clock will read these
         * as impossibly fast.
         */
        unit: 'business_minutes',
      });
    },
  );
}
