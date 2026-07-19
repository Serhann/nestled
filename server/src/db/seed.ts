import { prisma } from './prisma.js';
import { runMigrations } from './migrate.js';
import { ensureSeedAdmin } from './seedAdmin.js';

/**
 * CLI seed (dev): apply migrations, then create the first admin from
 * SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME. Idempotent.
 *
 *   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run seed
 *
 * In Docker the app seeds on boot via ensureSeedAdmin(); this script is for
 * local (tsx) use.
 */
async function seed() {
  await runMigrations();
  if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.log(
      '[seed] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — ' +
        'create the first admin via POST /api/auth/register',
    );
    return;
  }
  await ensureSeedAdmin();
}

seed()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed', err);
    process.exit(1);
  });
