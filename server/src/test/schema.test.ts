import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

/**
 * Structural guarantees of the multi-tenant schema, asserted against Prisma's own
 * DMMF. No database needed — these are properties of the schema itself, so they
 * run in CI on every commit and fail the moment someone adds a table that would
 * silently escape tenant scoping.
 *
 * The runtime counterpart lives in db/tenant.ts: a boot assertion that refuses to
 * start when a workspace_id-bearing model isn't registered in TENANT_MODELS. This
 * file catches the same class of mistake earlier and without a Postgres.
 */

/**
 * Models that legitimately have NO workspace_id, each for a stated reason. Adding
 * a name here is a deliberate act — the test below fails on anything unlisted, so
 * "I forgot to scope it" and "I decided not to scope it" can't be confused.
 */
const UNSCOPED_MODELS: Record<string, string> = {
  // A human, and the credentials/devices that belong to the human rather than to
  // any one workspace. Workspace context rides on the short-lived access token.
  users: 'login is global; role/seat live on workspace_members',
  refresh_tokens: 'a session belongs to the user and spans workspaces',
  user_tokens: 'email verification / password reset are user-level',
  push_subscriptions: 'a device belongs to the user; routing resolved at send time',

  // The tenant root itself, and reference data shared by all tenants.
  workspaces: 'the tenant root',
  plans: 'reference data (the plan catalog)',
  stripe_events: 'a global idempotency ledger keyed by Stripe event id',

  // Billing rows reached only through a workspace they already 1:1 or FK onto.
  subscriptions: 'one per workspace, unique on workspace_id',
  invoices: 'FKs workspace_id — see the note in the test',

  // Children reached exclusively through an already-scoped parent, protected by
  // that parent's cascade.
  member_website_access: 'child of workspace_members; cascades with it',
  bot_flow_versions: 'child of bot_flows; cascades with it',

  // Platform (vendor) plane. Deliberately disjoint from customer tenancy.
  platform_users: 'vendor staff',
  platform_sessions: 'vendor staff sessions',

  // Nullable workspace_id by design (a NULL means "platform-level").
  audit_log: 'workspace_id is nullable: NULL = a platform-level action',
  outbound_emails: 'workspace_id is nullable: NULL = a platform-level email',
  impersonation_sessions: 'has workspace_id, but is written on the vendor plane',
};

const models = Prisma.dmmf.datamodel.models;

function field(modelName: string, fieldName: string) {
  const m = models.find((x) => x.name === modelName);
  assert.ok(m, `model ${modelName} not found in DMMF`);
  return m.fields.find((f) => f.name === fieldName);
}

test('every model either carries workspace_id or is explicitly exempt', () => {
  const unexplained: string[] = [];
  for (const model of models) {
    const hasWorkspaceId = model.fields.some((f) => f.name === 'workspace_id');
    const isExempt = model.name in UNSCOPED_MODELS;
    if (!hasWorkspaceId && !isExempt) unexplained.push(model.name);
  }
  assert.deepEqual(
    unexplained,
    [],
    `these models have no workspace_id and no entry in UNSCOPED_MODELS. Either add ` +
      `workspace_id (and register the model in TENANT_MODELS in db/tenant.ts), or ` +
      `document why it is unscoped: ${unexplained.join(', ')}`,
  );
});

test('exemptions in UNSCOPED_MODELS all refer to models that exist', () => {
  const stale = Object.keys(UNSCOPED_MODELS).filter((n) => !models.some((m) => m.name === n));
  assert.deepEqual(stale, [], `stale exemptions — these models no longer exist: ${stale.join(', ')}`);
});

test('workspace_id is NOT NULL on every tenant model', () => {
  // The two exceptions are intentional and documented above: a NULL workspace on
  // audit_log / outbound_emails means "platform-level, not any customer's".
  const NULLABLE_BY_DESIGN = new Set(['audit_log', 'outbound_emails']);
  const offenders: string[] = [];
  for (const model of models) {
    const f = model.fields.find((x) => x.name === 'workspace_id');
    if (!f || NULLABLE_BY_DESIGN.has(model.name)) continue;
    if (!f.isRequired) offenders.push(model.name);
  }
  assert.deepEqual(
    offenders,
    [],
    `workspace_id must be NOT NULL so scoping is a uniform predicate: ${offenders.join(', ')}`,
  );
});

// The "does every tenant table have a leading-workspace_id index?" question is
// deliberately NOT asked here: Prisma's DMMF does not expose `@@index`, so a
// version of this test written against DMMF can only pass by carrying a long list
// of exemptions — which is a list, not a test. It lives in tenancy.test.ts, where
// pg_indexes can actually be read.

test('the composite-FK targets carry @@unique([workspace_id, id])', () => {
  // This is what makes a cross-tenant nested `connect` a Postgres error rather
  // than a code-review miss. Losing one of these silently removes that guarantee
  // for every child table that FKs onto it.
  for (const name of ['websites', 'conversations', 'workspace_members', 'bot_flows']) {
    const model = models.find((m) => m.name === name);
    assert.ok(model, `${name} missing`);
    const hasPair = model.uniqueFields.some(
      (u) => u.length === 2 && u.includes('workspace_id') && u.includes('id'),
    );
    assert.ok(hasPair, `${name} must declare @@unique([workspace_id, id]) — it is a composite-FK target`);
  }
});

test('public and private settings stay in separate models', () => {
  // The trust boundary is physical, not a naming convention: the widget boot route
  // selects from website_settings, and there is no path from there to a secret.
  const pub = models.find((m) => m.name === 'website_settings');
  assert.ok(pub);
  const secretish = /secret|api_key|password|token|webhook/i;
  const leaked = pub.fields.filter((f) => secretish.test(f.name)).map((f) => f.name);
  assert.deepEqual(leaked, [], `secret-looking fields in the PUBLIC settings model: ${leaked.join(', ')}`);

  // And the HMAC secret must not sit on `websites`, which the boot route also reads
  // — it is admin-only, so it is selected explicitly, never with a bare `select: *`.
  const site = models.find((m) => m.name === 'websites');
  assert.ok(site?.fields.some((f) => f.name === 'identity_secret'), 'websites.identity_secret missing');
});

test('conversations separates verified from unverified visitor data', () => {
  // The AI prompt and the agent "verified" card read custom_attributes; anything
  // the browser could have forged stays in metadata. Collapsing these two would
  // silently promote spoofable data to trusted.
  assert.ok(field('conversations', 'metadata'), 'conversations.metadata missing');
  assert.ok(field('conversations', 'custom_attributes'), 'conversations.custom_attributes missing');
});

test('the visitor identity graph is workspace-scoped', () => {
  // A global graph would tell workspace A that a visitor also chatted with
  // workspace B, and would fuse people across unrelated customers by fingerprint.
  for (const name of ['persons', 'visitor_links', 'person_signals', 'visitor_ips']) {
    const f = field(name, 'workspace_id');
    assert.ok(f?.isRequired, `${name}.workspace_id must exist and be required`);
  }
  const signals = models.find((m) => m.name === 'person_signals');
  assert.ok(
    signals?.uniqueFields.some((u) => u.includes('workspace_id') && u.includes('value')),
    'person_signals must be unique per (workspace, kind, value) — not globally',
  );
});
