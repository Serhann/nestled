import type { FastifyInstance } from 'fastify';
import { healthReport } from '../../services/platform/health.js';
import { platformRead } from './guards.js';

/**
 * Fleet health. Behind staff auth, unlike `/healthz`, which is the load balancer's
 * liveness probe and must stay a public two-field answer — an unauthenticated
 * endpoint that reports socket counts, queue depths and which integrations are
 * unconfigured is reconnaissance.
 */
export async function platformHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/health', { preHandler: platformRead }, async (_req, reply) => {
    return reply.send(await healthReport());
  });
}
