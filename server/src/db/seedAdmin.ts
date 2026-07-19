import { prisma } from './prisma.js';
import { hashPassword } from '../auth/password.js';

/**
 * Create the first admin from SEED_ADMIN_* env vars, but only if no agents
 * exist yet. Idempotent and safe to call on every boot — once an admin exists
 * it does nothing. This is how the Docker image seeds (the standalone
 * `npm run seed` uses tsx, which isn't present in the production image).
 */
export async function ensureSeedAdmin(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? 'Admin';
  if (!email || !password) return;

  const count = await prisma.agents.count();
  if (count > 0) return;

  const password_hash = await hashPassword(password);
  await prisma.agents.create({
    data: { name, email: email.toLowerCase(), password_hash, role: 'admin' },
  });
  // eslint-disable-next-line no-console
  console.log(`[seed] created first admin ${email}`);
}
