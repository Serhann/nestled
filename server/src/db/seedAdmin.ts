import { unscopedPrisma as prisma } from './unscoped.js';
import { hashPassword } from '../auth/password.js';

/**
 * Bootstrap the very first user from SEED_ADMIN_* env vars, but only while the
 * install has no users at all. Idempotent and safe to call on every boot — once a
 * user exists it does nothing. This is how the Docker image bootstraps (the
 * standalone `npm run seed` uses tsx, which isn't in the production image).
 *
 * It creates a user AND a workspace the user owns, because under a multi-tenant
 * schema a user without a membership can't reach anything: workspaces.plan_id is
 * NOT NULL and every tenant row hangs off a workspace.
 *
 * This is not how customers are created — they sign up (Phase 3). It exists so a
 * fresh self-hosted or staging install has somewhere to log in.
 */
export async function ensureSeedAdmin(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? 'Admin';
  if (!email || !password) return;

  const count = await prisma.users.count();
  if (count > 0) return;

  // The most capable public plan, with status 'active' rather than 'trialing': a
  // self-hosted install is not evaluating anything and shouldn't be silently
  // limited by a plan nobody chose, nor expire in 14 days.
  const plan = await prisma.plans.findFirst({
    where: { is_public: true },
    orderBy: { sort_order: 'desc' },
  });
  if (!plan) {
    // eslint-disable-next-line no-console
    console.warn('[seed] plan catalog is empty — skipping first-user bootstrap');
    return;
  }

  const slug =
    (email.split('@')[1] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const password_hash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const user = await tx.users.create({
      data: {
        name,
        email,
        password_hash,
        // Env-provisioned, so there is no mailbox to prove — and requireVerified
        // would otherwise lock this account out of the thing it exists to run.
        email_verified_at: new Date(),
      },
    });
    const workspace = await tx.workspaces.create({
      data: {
        name,
        slug,
        plan_id: plan.id,
        subscription_status: 'active',
        private_settings: { create: {} },
      },
    });
    await tx.workspace_members.create({
      data: { workspace_id: workspace.id, user_id: user.id, role: 'owner', all_websites: true },
    });
    await tx.users.update({ where: { id: user.id }, data: { default_workspace_id: workspace.id } });
  });

  // eslint-disable-next-line no-console
  console.log(`[seed] created the first user ${email} and workspace /w/${slug}`);
}
