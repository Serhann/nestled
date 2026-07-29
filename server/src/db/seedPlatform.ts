import { unscopedPrisma as prisma } from './unscoped.js';
import { hashPassword } from '../auth/password.js';

/**
 * Bootstrap the first platform (vendor staff) user from SEED_PLATFORM_*.
 *
 * Runs only while `platform_users` is completely empty, then no-ops forever — the
 * same shape as ensureSeedAdmin, and for the same reason: the ops panel has no
 * signup, by design, so there must be exactly one way in on a fresh install and it
 * must close behind itself. Once a staff account exists, further accounts are
 * created from inside the panel by a superadmin, where the action is audited.
 *
 * The seeded account gets NO TOTP factor, which means it is read-only until
 * somebody enrolls one at /platform/me/totp. That is deliberate: an account
 * provisioned from an environment variable — a value that lives in a compose file,
 * a CI secret store and probably a chat log — should not be able to change a
 * customer's plan or impersonate them on the strength of that variable alone.
 */
export async function ensureSeedPlatformUser(): Promise<void> {
  const email = process.env.SEED_PLATFORM_EMAIL?.toLowerCase().trim();
  const password = process.env.SEED_PLATFORM_PASSWORD;
  if (!email || !password) return;

  const count = await prisma.platform_users.count();
  if (count > 0) {
    const existing = await prisma.platform_users.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!existing) {
      // eslint-disable-next-line no-console
      console.warn(
        `[seed] SEED_PLATFORM_EMAIL is set to ${email} but staff accounts already exist, ` +
          'so the bootstrap was skipped. Create the account from inside the ops panel, ' +
          'where it is audited.',
      );
    }
    return;
  }

  await prisma.platform_users.create({
    data: {
      email,
      password_hash: await hashPassword(password),
      name: process.env.SEED_PLATFORM_NAME ?? 'Platform admin',
      role: 'superadmin',
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[seed] created the first platform user ${email} — read-only until a TOTP factor is enrolled`,
  );
}
