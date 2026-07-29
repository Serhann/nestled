import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { globalSearch } from '../../services/platform/search.js';
import { platformRead } from './guards.js';

/**
 * The one input. Dispatch lives in services/platform/search.ts, which explains
 * why this feature is the headline of the panel rather than a nicety.
 *
 * Deliberately NOT audited per query. Search is the first thing a support agent
 * does on every ticket, dozens of times a day, and it reads only identity-shaped
 * metadata (names, plans, which workspace a domain belongs to) — never message
 * content. Auditing it would bury the entries that matter (impersonations, plan
 * changes, lifecycle actions) under noise, which is the failure mode that makes
 * audit logs stop being read at all.
 */
export async function platformSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/search', { preHandler: platformRead }, async (req, reply) => {
    const parsed = z.object({ q: z.string().min(1).max(200) }).safeParse(req.query);
    if (!parsed.success) return reply.send({ query: '', interpretedAs: 'text', results: [] });
    return reply.send(await globalSearch(parsed.data.q));
  });
}
