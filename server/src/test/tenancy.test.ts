import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation, asserted against a real Postgres.
 *
 * These are the guarantees the schema's header comment claims, and the reason the
 * composite-FK pattern exists: a cross-tenant write must be rejected by the
 * DATABASE, not by remembering to add a predicate. Every assertion below would
 * still pass if db/tenant.ts were deleted — that is the point. The application
 * layer (Phase 2) is the first lock; this is the structural one behind it.
 *
 * Requires a Postgres. Point TEST_DATABASE_URL at a throwaway database:
 *   docker run -d --name nestled-test-db -e POSTGRES_USER=nestled \
 *     -e POSTGRES_PASSWORD=nestled -e POSTGRES_DB=nestled_test -p 5546:5432 postgres:16-alpine
 *   cd server && npx prisma migrate deploy
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

const WS_A = 'aaaaaaaa-0000-0000-0000-0000000000a0';
const WS_B = 'bbbbbbbb-0000-0000-0000-0000000000b0';
const SITE_A = 'aaaa1111-0000-0000-0000-0000000000a1';
const SITE_B = 'bbbb1111-0000-0000-0000-0000000000b1';
const MEMBER_A = 'aaaa2222-0000-0000-0000-0000000000a2';
const MEMBER_B = 'bbbb2222-0000-0000-0000-0000000000b2';
const CONV_A = 'aaaa3333-0000-0000-0000-0000000000a3';

/** Assert that a write is refused by Postgres, and by the constraint we expect. */
async function rejects(fn: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, expected, `rejected, but not by the expected constraint:\n${msg}`);
    return;
  }
  assert.fail('the write SUCCEEDED — tenant isolation is not enforced by the database');
}

before(async () => {
  // Clean slate, then two workspaces that are identical apart from their ids.
  await prisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  const plan = await prisma.plans.findFirstOrThrow({ where: { code: 'pro' } });

  await prisma.users.createMany({
    data: [
      { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', password_hash: 'x', name: 'A' },
      { id: '22222222-2222-2222-2222-222222222222', email: 'b@example.com', password_hash: 'x', name: 'B' },
    ],
  });
  await prisma.workspaces.createMany({
    data: [
      { id: WS_A, name: 'Acme', slug: 'acme', plan_id: plan.id },
      { id: WS_B, name: 'Beta', slug: 'beta', plan_id: plan.id },
    ],
  });
  await prisma.websites.createMany({
    data: [
      { id: SITE_A, workspace_id: WS_A, public_key: 'nst_a', name: 'Acme site' },
      { id: SITE_B, workspace_id: WS_B, public_key: 'nst_b', name: 'Beta site' },
    ],
  });
  await prisma.workspace_members.createMany({
    data: [
      { id: MEMBER_A, workspace_id: WS_A, user_id: '11111111-1111-1111-1111-111111111111', role: 'owner' },
      { id: MEMBER_B, workspace_id: WS_B, user_id: '22222222-2222-2222-2222-222222222222', role: 'owner' },
    ],
  });
  await prisma.conversations.create({
    data: { id: CONV_A, workspace_id: WS_A, website_id: SITE_A, visitor_id: 'v1', visitor_token_hash: 'h1' },
  });
});

after(async () => {
  await prisma.$disconnect();
});

test('a conversation cannot reference another workspace\'s website', async () => {
  await rejects(
    () =>
      prisma.conversations.create({
        data: { workspace_id: WS_B, website_id: SITE_A, visitor_id: 'v2', visitor_token_hash: 'h2' },
      }),
    /conversations_workspace_id_website_id_fkey/,
  );
});

test('a conversation cannot be assigned to another workspace\'s member', async () => {
  // The single-column FK Prisma generates would allow this; the migration replaces
  // it with the composite pair precisely to close it.
  await rejects(
    () => prisma.conversations.update({ where: { id: CONV_A }, data: { assigned_member_id: MEMBER_B } }),
    /conversations_assigned_member_fkey/,
  );
});

test('a conversation CAN be assigned to its own workspace\'s member', async () => {
  const updated = await prisma.conversations.update({
    where: { id: CONV_A },
    data: { assigned_member_id: MEMBER_A },
  });
  assert.equal(updated.assigned_member_id, MEMBER_A);
});

test('a message cannot be filed under the wrong workspace', async () => {
  await rejects(
    () =>
      prisma.messages.create({
        data: { workspace_id: WS_B, conversation_id: CONV_A, content: 'hi', sender_type: 'visitor' },
      }),
    /messages_workspace_id_conversation_id_fkey/,
  );
});

test('an invalid status is refused by a CHECK constraint', async () => {
  await rejects(
    () => prisma.$executeRawUnsafe(`UPDATE conversations SET status='banana' WHERE id='${CONV_A}'`),
    /conversations_status_check/,
  );
});

test('the message trigger keeps message_count and updated_at in sync', async () => {
  const before = await prisma.conversations.findUniqueOrThrow({ where: { id: CONV_A } });
  await prisma.messages.create({
    data: { workspace_id: WS_A, conversation_id: CONV_A, content: 'hello', sender_type: 'visitor' },
  });
  const after_ = await prisma.conversations.findUniqueOrThrow({ where: { id: CONV_A } });
  assert.equal(after_.message_count, before.message_count + 1);
  assert.ok(after_.updated_at >= before.updated_at);
});

test('deleting a member clears the assignee but keeps the conversation and its workspace', async () => {
  // Postgres 15+ `ON DELETE SET NULL (assigned_member_id)` must null ONLY that
  // column. If it nulled workspace_id too (NOT NULL) the delete would error, and if
  // it cascaded, an agent leaving would delete their customers' conversations.
  await prisma.conversations.update({ where: { id: CONV_A }, data: { assigned_member_id: MEMBER_A } });
  await prisma.workspace_members.delete({ where: { id: MEMBER_A } });

  const conv = await prisma.conversations.findUnique({ where: { id: CONV_A } });
  assert.ok(conv, 'the conversation must survive its assignee being deleted');
  assert.equal(conv.assigned_member_id, null);
  assert.equal(conv.workspace_id, WS_A);
});

test('only one pending invite per email per workspace, case-insensitively', async () => {
  await prisma.invites.create({
    data: {
      workspace_id: WS_A,
      email: 'new@example.com',
      token_hash: 'tok-1',
      expires_at: new Date(Date.now() + 7 * 864e5),
    },
  });
  await rejects(
    () =>
      prisma.invites.create({
        data: {
          workspace_id: WS_A,
          email: 'NEW@example.com', // same mailbox, different case
          token_hash: 'tok-2',
          expires_at: new Date(Date.now() + 7 * 864e5),
        },
      }),
    // Prisma surfaces a partial unique index by its field list, not its name.
    /Unique constraint failed.*lower\(email\)/s,
  );

  // Revoking the first must release the slot — otherwise a mistyped invite would
  // permanently block that address.
  await prisma.invites.updateMany({ where: { workspace_id: WS_A }, data: { revoked_at: new Date() } });
  const second = await prisma.invites.create({
    data: {
      workspace_id: WS_A,
      email: 'new@example.com',
      token_hash: 'tok-3',
      expires_at: new Date(Date.now() + 7 * 864e5),
    },
  });
  assert.ok(second.id);
});

test('every tenant table has an index leading with workspace_id', async () => {
  // Correct-but-unindexed scoping degrades to a sequential scan as soon as one
  // tenant grows, and slow scoping is scoping someone eventually removes. Asked
  // here rather than against DMMF because DMMF does not expose @@index.
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`
    SELECT c.table_name::text AS table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'workspace_id'
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class t   ON t.oid = i.indrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
        WHERE t.relname = c.table_name
          AND a.attname = 'workspace_id'
      )
    ORDER BY 1
  `);
  assert.deepEqual(
    rows.map((r) => r.table_name),
    [],
    'these tables carry workspace_id but no index leading with it',
  );
});

test('the plan catalog is seeded and ordered', async () => {
  // workspaces.plan_id is NOT NULL, so signup cannot work without these rows —
  // which is why they are in the migration and not a manual step.
  const plans = await prisma.plans.findMany({ orderBy: { sort_order: 'asc' } });
  assert.deepEqual(plans.map((p) => p.code), ['free', 'starter', 'pro', 'business']);
  // Limits must be monotonically non-decreasing up the ladder, or the upgrade
  // path sells a downgrade on some dimension.
  for (let i = 1; i < plans.length; i++) {
    const prev = plans[i - 1]!;
    const next = plans[i]!;
    assert.ok(
      next.max_conversations_month >= prev.max_conversations_month,
      `${next.code} allows fewer conversations than ${prev.code}`,
    );
    assert.ok(
      next.max_websites >= prev.max_websites,
      `${next.code} allows fewer websites than ${prev.code}`,
    );
  }
});
