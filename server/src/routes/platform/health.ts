import type { FastifyInstance } from 'fastify';
import { healthReport } from '../../services/platform/health.js';
import { clientIpDiagnostics } from '../../lib/clientIp.js';
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

  /**
   * What this request looks like to the IP resolver.
   *
   * "We are seeing Cloudflare's addresses instead of our visitors'" is a claim
   * about headers, and every answer to it that starts by reasoning about the proxy
   * chain is a guess. Curl this from a laptop and the guessing stops: it prints the
   * resolved address, which header was configured, and the raw value of each header
   * that could have supplied it.
   *
   * Staff-only. It reflects the caller's own request, but naming the header that
   * wins also names the header worth forging.
   */
  app.get('/platform/diagnostics/client-ip', { preHandler: platformRead }, async (req, reply) => {
    return reply.send(clientIpDiagnostics(req));
  });
}
