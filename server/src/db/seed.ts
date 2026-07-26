import { randomBytes } from 'node:crypto';
import { prisma } from './prisma.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../auth/password.js';

/**
 * Development seed: one workspace with an owner, a website, and enough content to
 * exercise the inbox. Idempotent — safe to re-run, and safe after a
 * `prisma migrate reset`.
 *
 * Deliberately NOT the production bootstrap. That is ensureSeedAdmin() in
 * seedAdmin.ts, which runs on every boot and creates only the first user; real
 * customers arrive through self-serve signup (Phase 3).
 *
 *   cd server && npm run seed
 */

const DEV_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? 'dev@nestled.chat').toLowerCase();
const DEV_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'devpassword1';

/** Website public keys are unguessable by design; mint them the same way here. */
function publicKey(): string {
  return `nst_${randomBytes(24).toString('base64url').slice(0, 24)}`;
}

async function seed(): Promise<void> {
  await runMigrations();

  const plan = await prisma.plans.findUnique({ where: { code: 'pro' } });
  if (!plan) {
    throw new Error(
      'no plans found — the plan catalog is seeded by migration 0001_init. Check that migrations applied.',
    );
  }

  const user = await prisma.users.upsert({
    where: { email: DEV_EMAIL },
    update: {},
    create: {
      email: DEV_EMAIL,
      name: 'Dev Owner',
      password_hash: await hashPassword(DEV_PASSWORD),
      // A dev account skips the verification mail; requireVerified would otherwise
      // block widget serving and outbound email.
      email_verified_at: new Date(),
    },
  });

  const workspace = await prisma.workspaces.upsert({
    where: { slug: 'acme' },
    update: {},
    create: {
      name: 'Acme Inc.',
      slug: 'acme',
      plan_id: plan.id,
      subscription_status: 'trialing',
      trial_ends_at: new Date(Date.now() + 14 * 864e5),
      timezone: 'Europe/Istanbul',
      private_settings: { create: {} },
    },
  });

  await prisma.workspace_members.upsert({
    where: { workspace_id_user_id: { workspace_id: workspace.id, user_id: user.id } },
    update: {},
    create: { workspace_id: workspace.id, user_id: user.id, role: 'owner', all_websites: true },
  });
  await prisma.users.update({
    where: { id: user.id },
    data: { default_workspace_id: workspace.id },
  });

  // A website is always created together with its 1:1 settings and business-hours
  // rows, never lazily, so the widget boot route can rely on them existing instead
  // of merging defaults at read time.
  const existing = await prisma.websites.findFirst({
    where: { workspace_id: workspace.id, name: 'Acme Storefront' },
  });
  const website =
    existing ??
    (await prisma.websites.create({
      data: {
        workspace_id: workspace.id,
        public_key: publicKey(),
        name: 'Acme Storefront',
        primary_domain: 'acme.com',
        settings: {
          create: {
            workspace_id: workspace.id,
            primary_color: '#4f46e5',
            system_prompt:
              'You are the customer support assistant for Acme Inc. Answer only questions about Acme and its products or services. If you do not know the answer, hand off to a human.',
            rating_tags: ['Fast reply', 'Solved my problem', 'Friendly'],
          },
        },
        hours: {
          create: {
            workspace_id: workspace.id,
            timezone: 'Europe/Istanbul',
            rules: [
              { dow: 1, intervals: [['09:00', '18:00']] },
              { dow: 2, intervals: [['09:00', '18:00']] },
              { dow: 3, intervals: [['09:00', '18:00']] },
              { dow: 4, intervals: [['09:00', '18:00']] },
              { dow: 5, intervals: [['09:00', '18:00']] },
            ],
          },
        },
      },
    }));

  // Guarded by a count rather than skipDuplicates: knowledge_base has no natural
  // unique key (two websites in one workspace may legitimately answer the same
  // question differently), so skipDuplicates would have nothing to conflict on and
  // would re-insert on every run.
  if ((await prisma.knowledge_base.count({ where: { workspace_id: workspace.id } })) === 0) {
    await prisma.knowledge_base.createMany({
      data: [
        {
          workspace_id: workspace.id,
          question: 'What are your opening hours?',
          answer: 'We reply Monday to Friday, 09:00–18:00 Istanbul time.',
          category: 'general',
          keywords: ['hours', 'open', 'when'],
        },
        {
          workspace_id: workspace.id,
          question: 'How do I get a refund?',
          answer:
            'Refunds are available within 14 days of purchase. Reply here and an agent will start one for you.',
          category: 'billing',
          keywords: ['refund', 'money back', 'return'],
        },
      ],
    });
  }

  await prisma.canned_responses.createMany({
    data: [
      {
        workspace_id: workspace.id,
        shortcut: 'hello',
        title: 'Greeting',
        content: 'Hi! Thanks for reaching out — how can I help?',
      },
      {
        workspace_id: workspace.id,
        shortcut: 'checking',
        title: 'One moment',
        content: 'Let me check that for you — one moment.',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.starters.createMany({
    data: [
      { workspace_id: workspace.id, key: 'question', label: 'I have a question', priority: 10 },
      {
        workspace_id: workspace.id,
        key: 'problem',
        label: 'Something is broken',
        kind: 'human',
        priority: 20,
      },
      {
        workspace_id: workspace.id,
        key: 'human',
        label: 'Talk to a person',
        kind: 'human',
        priority: 30,
      },
    ],
    skipDuplicates: true,
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      '[seed] ready',
      `  workspace : ${workspace.name}  (/w/${workspace.slug})`,
      `  owner     : ${DEV_EMAIL} / ${DEV_PASSWORD}`,
      `  website   : ${website.name}`,
      `  embed key : ${website.public_key}`,
      '',
      `  Widget sandbox: http://localhost:5173/sandbox.html?key=${website.public_key}`,
    ].join('\n'),
  );
}

seed()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
