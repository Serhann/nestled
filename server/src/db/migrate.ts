import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Apply pending Prisma migrations. Runs `prisma migrate deploy` against
 * DATABASE_URL — forward-only, safe to run on every boot (already-applied
 * migrations are skipped). Works from both `src` (tsx dev) and `dist` (prod):
 * the server root is two levels up, where prisma/schema.prisma lives.
 */
export async function runMigrations(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url)); // .../{src,dist}/db
  const serverRoot = join(here, '..', '..'); // .../server or /app
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: serverRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

// Allow running standalone with `tsx src/db/migrate.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[migrate] done');
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
