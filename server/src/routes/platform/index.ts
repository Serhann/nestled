import type { FastifyInstance } from 'fastify';

/**
 * The platform (ops) surface, mounted under /platform/*.
 *
 * A different authentication MECHANISM from the customer plane: opaque bearer
 * sessions checked against platform_sessions on every request. No JWT verifier is
 * mounted here, and /api/* never reads those tables.
 *
 * Registered from index.ts so the surface exists as a seam before it is filled.
 */
export async function platformRoutes(_app: FastifyInstance): Promise<void> {
  // Phase 13.
}
