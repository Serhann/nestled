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
 *
 * A few files outside those directories genuinely need it, and they say so with an
 * `eslint-disable-next-line no-restricted-imports` carrying a REASON. The point of
 * the rule is not to make the unscoped client unreachable — some flows legitimately
 * precede a workspace — but to make reaching for it a visible, deliberate act. The
 * disables are therefore the audit surface:
 *
 *   grep -rn "no-restricted-imports --" server/src
 *
 * That list should be short and every entry should be obviously true. Today:
 *   routes/v1/auth.ts        signup/login/reset run before a workspace exists
 *   routes/v1/me.ts          cross-workspace by definition (lists all of them)
 *   routes/v1/workspaces.ts  workspace creation + the shared plan catalog
 *   routes/v1/team.ts        invite acceptance precedes membership
 *   lib/audit.ts             audit_log.workspace_id is nullable (platform actions)
 *   lib/slug.ts              slug uniqueness is global, by design
 *   services/email.ts        outbound_emails.workspace_id is nullable
 *   services/billing/*       webhooks arrive with no request context, the nightly
 *                            sweeps span every workspace, and `subscriptions` and
 *                            `invoices` are in INTENTIONALLY_UNSCOPED (tenant.ts)
 */
export const unscopedPrisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
