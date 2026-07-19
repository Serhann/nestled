import { PrismaClient } from '@prisma/client';
import { env } from '../env.js';

/**
 * Single Prisma Client for the process. Replaces the old pg connection pool —
 * Prisma manages its own pool internally. Query logging is on in dev only.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
