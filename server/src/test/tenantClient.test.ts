import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unscopedPrisma } from '../db/unscoped.js';
import {
  tenantDb,
  TenantScopeError,
  TENANT_MODELS,
  assertTenantModelsRegistered,
  findUnregisteredTenantModels,
} from '../db/tenant.js';

/**
 * The tenant-scoped Prisma client.
 *
 * tenancy.test.ts proves the DATABASE refuses cross-tenant writes. This file
 * proves the layer above it: that every read is filtered and every write is
 * stamped, for each Prisma operation shape, so a route handler cannot see another
 * workspace's rows even when it writes a query with no `where` at all.
 *
 * The distinction matters. The database stops you WRITING a bad reference; only
 * this layer stops you READING someone else's rows with `findMany({})`.
 */

const WS_A = 'aaaaaaaa-0000-0000-0000-00000000ca01';
const WS_B = 'bbbbbbbb-0000-0000-0000-00000000cb02';
const SITE_A1 = 'aaaa1111-0000-0000-0000-00000000c101';
const SITE_A2 = 'aaaa1111-0000-0000-0000-00000000c102';
const SITE_B1 = 'bbbb1111-0000-0000-0000-00000000c201';

/** Full access to workspace A. */
const dbA = tenantDb({ workspaceId: WS_A, websiteIds: null });
/** Workspace A, but narrowed to ONE of its two websites (a scoped member). */
const dbA1 = tenantDb({ workspaceId: WS_A, websiteIds: [SITE_A1] });
/** An impersonated read-only session on A. */
const dbAReadOnly = tenantDb({ workspaceId: WS_A, websiteIds: null, readOnly: true });

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  const plan = await unscopedPrisma.plans.findFirstOrThrow({ where: { code: 'pro' } });
  await unscopedPrisma.workspaces.createMany({
    data: [
      { id: WS_A, name: 'Acme', slug: 'acme-tc', plan_id: plan.id },
      { id: WS_B, name: 'Beta', slug: 'beta-tc', plan_id: plan.id },
    ],
  });
  await unscopedPrisma.websites.createMany({
    data: [
      { id: SITE_A1, workspace_id: WS_A, public_key: 'nst_tc_a1', name: 'A one' },
      { id: SITE_A2, workspace_id: WS_A, public_key: 'nst_tc_a2', name: 'A two' },
      { id: SITE_B1, workspace_id: WS_B, public_key: 'nst_tc_b1', name: 'B one' },
    ],
  });
});

after(async () => {
  await unscopedPrisma.$disconnect();
});

beforeEach(async () => {
  // Content models are rebuilt per test so each one starts from a known set.
  await unscopedPrisma.canned_responses.deleteMany({});
  await unscopedPrisma.knowledge_base.deleteMany({});
});

// ── Reads ────────────────────────────────────────────────────────────────────

test('findMany with no where returns only this workspace', async () => {
  await unscopedPrisma.canned_responses.createMany({
    data: [
      { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
      { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
    ],
  });
  const rows = await dbA.canned_responses.findMany();
  assert.deepEqual(rows.map((r) => r.shortcut), ['a1']);
});

test('count is scoped', async () => {
  await unscopedPrisma.canned_responses.createMany({
    data: [
      { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
      { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
      { workspace_id: WS_B, shortcut: 'b2', title: 'B', content: 'b' },
    ],
  });
  assert.equal(await dbA.canned_responses.count(), 1);
});

test('findUnique on another workspace\'s row returns null, not the row', async () => {
  // Rewritten to findFirst internally: findUnique's `where` accepts only unique
  // fields, so the predicate could not otherwise be merged in.
  const foreign = await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
  });
  assert.equal(await dbA.canned_responses.findUnique({ where: { id: foreign.id } }), null);
});

test('findUniqueOrThrow on another workspace\'s row throws', async () => {
  const foreign = await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
  });
  await assert.rejects(() => dbA.canned_responses.findUniqueOrThrow({ where: { id: foreign.id } }));
});

test('findUnique still finds our OWN row (the rewrite must not break reads)', async () => {
  const own = await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
  });
  const found = await dbA.canned_responses.findUnique({ where: { id: own.id } });
  assert.equal(found?.id, own.id);
});

test('a caller-supplied where is ANDed with the scope, never replaced by it', async () => {
  await unscopedPrisma.canned_responses.createMany({
    data: [
      { workspace_id: WS_A, shortcut: 'keep', title: 'A', content: 'a' },
      { workspace_id: WS_A, shortcut: 'drop', title: 'A', content: 'a' },
      { workspace_id: WS_B, shortcut: 'keep', title: 'B', content: 'b' },
    ],
  });
  const rows = await dbA.canned_responses.findMany({ where: { shortcut: 'keep' } });
  assert.deepEqual(rows.map((r) => r.workspace_id), [WS_A]);
});

// ── Writes ───────────────────────────────────────────────────────────────────

test('create stamps our workspace and OVERWRITES a body-supplied one', async () => {
  // The attack this closes: a request body carrying `workspace_id` for someone
  // else. The extension does not merge the caller's value, it replaces it.
  const row = await dbA.canned_responses.create({
    data: {
      workspace_id: WS_B, // hostile
      shortcut: 'a1',
      title: 'A',
      content: 'a',
    } as never,
  });
  assert.equal(row.workspace_id, WS_A);
});

test('createMany stamps every row', async () => {
  await dbA.canned_responses.createMany({
    data: [
      { workspace_id: WS_B, shortcut: 'a1', title: 'A', content: 'a' },
      { shortcut: 'a2', title: 'A', content: 'a' },
    ] as never,
  });
  const rows = await unscopedPrisma.canned_responses.findMany({ orderBy: { shortcut: 'asc' } });
  assert.deepEqual(rows.map((r) => r.workspace_id), [WS_A, WS_A]);
});

test('update cannot reach another workspace\'s row', async () => {
  const foreign = await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
  });
  // P2025 — indistinguishable from "no such id", which is the point: a 403 here
  // would confirm the row exists.
  await assert.rejects(
    () => dbA.canned_responses.update({ where: { id: foreign.id }, data: { title: 'pwned' } }),
    /No .*record|P2025/i,
  );
  const after_ = await unscopedPrisma.canned_responses.findUniqueOrThrow({ where: { id: foreign.id } });
  assert.equal(after_.title, 'B');
});

test('delete cannot reach another workspace\'s row', async () => {
  const foreign = await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
  });
  await assert.rejects(() => dbA.canned_responses.delete({ where: { id: foreign.id } }));
  assert.ok(await unscopedPrisma.canned_responses.findUnique({ where: { id: foreign.id } }));
});

test('deleteMany with no where deletes only our rows', async () => {
  // The single most dangerous shape in the codebase: a bare deleteMany.
  await unscopedPrisma.canned_responses.createMany({
    data: [
      { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
      { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
    ],
  });
  const { count } = await dbA.canned_responses.deleteMany({});
  assert.equal(count, 1);
  const survivors = await unscopedPrisma.canned_responses.findMany();
  assert.deepEqual(survivors.map((r) => r.workspace_id), [WS_B]);
});

test('updateMany with no where updates only our rows', async () => {
  await unscopedPrisma.canned_responses.createMany({
    data: [
      { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
      { workspace_id: WS_B, shortcut: 'b1', title: 'B', content: 'b' },
    ],
  });
  await dbA.canned_responses.updateMany({ data: { title: 'touched' } });
  const b = await unscopedPrisma.canned_responses.findFirstOrThrow({ where: { workspace_id: WS_B } });
  assert.equal(b.title, 'B');
});

test('upsert stamps the workspace on create and is scoped on update', async () => {
  const created = await dbA.canned_responses.upsert({
    where: { workspace_id_shortcut: { workspace_id: WS_A, shortcut: 'a1' } },
    create: { workspace_id: WS_B, shortcut: 'a1', title: 'A', content: 'a' } as never,
    update: { title: 'updated' },
  });
  assert.equal(created.workspace_id, WS_A);
});

// ── Per-website narrowing ────────────────────────────────────────────────────

test('a website-scoped member sees only their granted website', async () => {
  const rows = await dbA1.websites.findMany();
  assert.deepEqual(rows.map((r) => r.id), [SITE_A1]);
});

test('a full-access member sees every website in the workspace', async () => {
  const rows = await dbA.websites.findMany({ orderBy: { name: 'asc' } });
  assert.deepEqual(rows.map((r) => r.id), [SITE_A1, SITE_A2]);
});

test('a website-scoped member still sees workspace-wide (website_id NULL) content', async () => {
  // The subtle one. Shared content uses website_id = NULL to mean "all websites".
  // A naive `website_id IN (...)` filter would hide the workspace's entire shared
  // knowledge base from every narrowed member — correct-looking and badly wrong.
  await unscopedPrisma.knowledge_base.createMany({
    data: [
      { workspace_id: WS_A, website_id: null, question: 'shared', answer: 'x' },
      { workspace_id: WS_A, website_id: SITE_A1, question: 'mine', answer: 'x' },
      { workspace_id: WS_A, website_id: SITE_A2, question: 'theirs', answer: 'x' },
    ],
  });
  const rows = await dbA1.knowledge_base.findMany({ orderBy: { question: 'asc' } });
  assert.deepEqual(rows.map((r) => r.question), ['mine', 'shared']);
});

// ── Read-only (impersonation) ────────────────────────────────────────────────

test('a read-only scope permits reads', async () => {
  await unscopedPrisma.canned_responses.create({
    data: { workspace_id: WS_A, shortcut: 'a1', title: 'A', content: 'a' },
  });
  assert.equal((await dbAReadOnly.canned_responses.findMany()).length, 1);
});

test('a read-only scope throws on every write shape', async () => {
  // Mechanical, not a set of remembered checks: support staff cannot mutate a
  // customer's data even if a route forgets to check the scope.
  await assert.rejects(
    () => dbAReadOnly.canned_responses.create({ data: { shortcut: 'x', title: 'x', content: 'x' } as never }),
    TenantScopeError,
  );
  await assert.rejects(
    () => dbAReadOnly.canned_responses.updateMany({ data: { title: 'x' } }),
    TenantScopeError,
  );
  await assert.rejects(() => dbAReadOnly.canned_responses.deleteMany({}), TenantScopeError);
});

// ── Registry / boot assertion ────────────────────────────────────────────────

test('the boot assertion passes for the current schema', () => {
  assert.doesNotThrow(() => assertTenantModelsRegistered());
});

test('the boot assertion CATCHES a tenant model that was never registered', () => {
  // The direction that matters. If this ever stops failing, adding a table with a
  // workspace_id silently produces a model that runs unscoped and leaks across
  // customers — which is the single worst bug this codebase can have.
  const { unregistered } = findUnregisteredTenantModels(
    [
      { name: 'conversations', fields: [{ name: 'workspace_id' }] },
      { name: 'shiny_new_feature', fields: [{ name: 'id' }, { name: 'workspace_id' }] },
    ],
    { conversations: 'workspace' },
    new Set(),
  );
  assert.deepEqual(unregistered, ['shiny_new_feature']);
});

test('the boot assertion ignores models with no workspace_id', () => {
  const { unregistered } = findUnregisteredTenantModels(
    [{ name: 'plans', fields: [{ name: 'id' }, { name: 'code' }] }],
    {},
    new Set(),
  );
  assert.deepEqual(unregistered, []);
});

test('the boot assertion catches a registry entry whose model was deleted', () => {
  const { stale } = findUnregisteredTenantModels(
    [{ name: 'conversations', fields: [{ name: 'workspace_id' }] }],
    { conversations: 'workspace', quick_actions: 'workspace' },
    new Set(),
  );
  assert.deepEqual(stale, ['quick_actions']);
});

test('every registered tenant model is actually queryable', () => {
  // Catches a typo in TENANT_MODELS, which would otherwise silently mean "this
  // model is not scoped" — the exact failure the registry exists to prevent.
  for (const name of Object.keys(TENANT_MODELS)) {
    assert.ok(
      name in unscopedPrisma,
      `TENANT_MODELS lists "${name}", which is not a Prisma model — check the spelling`,
    );
  }
});

test('untenanted models pass through unscoped', async () => {
  // plans is reference data shared by every tenant; scoping it would return zero
  // rows and break signup, which needs a plan to point at.
  const plans = await dbA.plans.findMany();
  assert.ok(plans.length >= 4, 'the scoped client must not filter reference data');
});
