/**
 * @deprecated Legacy alias for the UNSCOPED client. Being removed.
 *
 * Every import of this from routes/, services/, realtime/ or lib/ is a lint error
 * and a file that has not yet been ported to the tenant-scoped `req.db`. The
 * remaining count is the port-progress metric for Phases 3–5:
 *
 *   npx eslint server/src 2>&1 | grep -c "db/prisma"
 *
 * It must reach zero before Phase 5 is done, at which point this file is deleted.
 * There is deliberately only ONE real client (db/unscoped.ts) so there is no
 * second, quietly-unscoped path for someone to reach for.
 */
export { unscopedPrisma as prisma } from './unscoped.js';
