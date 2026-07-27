import type { FastifyInstance } from 'fastify';
import { platformAuthRoutes } from './auth.js';
import { platformSearchRoutes } from './search.js';
import { platformWorkspaceRoutes } from './workspaces.js';
import { platformPlanRoutes } from './plans.js';
import { platformDunningRoutes } from './dunning.js';
import { platformHealthRoutes } from './health.js';
import { platformSettingsRoutes } from './settings.js';
import { platformImpersonationRoutes } from './impersonation.js';

/**
 * The platform (ops) surface, mounted under /platform/*.
 *
 * A different authentication MECHANISM from the customer plane: opaque bearer
 * sessions checked against platform_sessions on every request. No JWT verifier is
 * mounted here, and /api/* never reads those tables. Both directions are pinned by
 * test/platformAuth.test.ts — a valid customer JWT is rejected here, and a valid
 * staff session is rejected there.
 *
 * Every route in this tree reads the unscoped Prisma client directly, and the
 * ESLint tenant-import guard is switched off for this directory alone (see
 * eslint.config.js). That is correct rather than convenient: this surface exists to
 * look at every workspace at once, so requiring a disable comment on each query
 * would bury the handful of genuinely notable exceptions elsewhere in noise.
 */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  await app.register(platformAuthRoutes);
  await app.register(platformSearchRoutes);
  await app.register(platformWorkspaceRoutes);
  await app.register(platformPlanRoutes);
  await app.register(platformDunningRoutes);
  await app.register(platformHealthRoutes);
  await app.register(platformSettingsRoutes);
  await app.register(platformImpersonationRoutes);
}
