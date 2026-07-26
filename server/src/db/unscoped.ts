import { PrismaClient } from '@prisma/client';
import { env } from '../env.js';

/**
 * The raw, UNSCOPED Prisma Client.
 *
 * Importing this bypasses tenant isolation entirely. It is legitimate in exactly
 * four places, and an ESLint `no-restricted-imports` rule enforces that:
 *
 *   db/         — building the scoped client, migrations, seeds, boot assertions
 *   auth/       — resolving a user or session BEFORE a workspace is known
 *   platform/   — the vendor plane, which is cross-tenant by definition
 *   billing/    — Stripe webhooks arrive with no request context at all
 *   jobs/       — trial expiry, dunning, retention and purge sweeps
 *
 * Everywhere else — routes, services, realtime, lib — use `req.db`, the
 * workspace-scoped client from tenant.ts. The scope is a property of the client,
 * not a predicate anyone has to remember.
 */
export const unscopedPrisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
