import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDatabaseUrl, redactDatabaseUrl } from './url.js';

/**
 * Apply pending Prisma migrations. Runs `prisma migrate deploy` against
 * DATABASE_URL — forward-only, safe to run on every boot (already-applied
 * migrations are skipped). Works from both `src` (tsx dev) and `dist` (prod):
 * the server root is two levels up, where prisma/schema.prisma lives.
 *
 * The credentials are percent-encoded on the way through (see db/url.ts). This
 * file deliberately does NOT import env.ts: `npm run migrate` runs it as the
 * compose release step, where a schema that demands the JWT secrets to apply a
 * migration would be a requirement invented by the wrong module.
 */
export async function runMigrations(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required to run migrations');
  const { url, repaired } = normalizeDatabaseUrl(raw);
  if (repaired) {
    // eslint-disable-next-line no-console
    console.warn(
      `[migrate] DATABASE_URL credentials contained characters that must be ` +
        `percent-encoded; using the encoded form (${redactDatabaseUrl(url)}).`,
    );
  }

  const here = dirname(fileURLToPath(import.meta.url)); // .../{src,dist}/db
  const serverRoot = join(here, '..', '..'); // .../server or /app
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: serverRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
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
      // A bad DATABASE_URL is a configuration mistake, and its own message says
      // what to change — printing a stack trace through the child-process
      // plumbing buries that. Everything else keeps the stack.
      const config = err instanceof Error && err.message.startsWith('DATABASE_URL');
      // eslint-disable-next-line no-console
      console.error(config ? `\n[migrate] ${err.message}\n` : err);
      process.exit(1);
    });
}
