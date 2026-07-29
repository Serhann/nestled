import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { hashPassword } from '../auth/password.js';
import { currentCode, generateTotpSecret } from '../lib/totp.js';
import { classify } from '../services/platform/search.js';

/**
 * The panel itself: global search, workspace list and detail, plan overrides, the
 * dunning worklist and health.
 *
 * The search assertions carry the most weight. It is the feature that decides
 * whether the panel saves support time or merely displays data, and the thing that
 * makes it work — dispatching on the SHAPE of what was pasted — is exactly the kind
 * of behaviour that rots silently when someone adds a sixth case.
 */

let app: FastifyInstance;
let staffToken: string;
let workspaceA: string;
let workspaceB: string;
let websiteA: string;
let websiteKeyA: string;
let conversationA: string;
let adaUserId: string;

const STAFF_SECRET = generateTotpSecret();
const STAFF_PASSWORD = 'staff password long enough';
const CUSTOMER_PASSWORD = 'correct horse battery';

const staffAuth = () => ({ authorization: `Bearer ${staffToken}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: staffAuth() });

async function signup(name: string, email: string, workspace: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: CUSTOMER_PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().access_token as string;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces, platform_users CASCADE');
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });

  app = await buildServer();
  await app.ready();

  await unscopedPrisma.platform_users.create({
    data: {
      email: 'ops@nestled.chat',
      name: 'Ops',
      role: 'superadmin',
      password_hash: await hashPassword(STAFF_PASSWORD),
      totp_secret: STAFF_SECRET,
      totp_enabled: true,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    payload: { email: 'ops@nestled.chat', password: STAFF_PASSWORD, totp: currentCode(STAFF_SECRET) },
  });
  assert.equal(login.statusCode, 200, login.body);
  staffToken = login.json().token;

  const ada = await signup('Ada Lovelace', 'ada@example.com', 'Acme');
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });
  adaUserId = (await unscopedPrisma.users.findUniqueOrThrow({ where: { email: 'ada@example.com' } })).id;

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${ada}` },
  });
  workspaceA = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceA}/websites`,
    headers: { authorization: `Bearer ${ada}` },
    payload: { name: 'Acme Storefront', primary_domain: 'acme.com' },
  });
  assert.equal(site.statusCode, 201, site.body);
  websiteA = site.json().website.id;
  websiteKeyA = site.json().website.public_key;

  const bob = await signup('Bob', 'bob@example.com', 'Beta');
  workspaceB = (
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${bob}` } })
  ).json().workspaces[0].id;

  const conv = await unscopedPrisma.conversations.create({
    data: {
      workspace_id: workspaceA,
      website_id: websiteA,
      visitor_id: 'v-search',
      visitor_token_hash: `hash-${Date.now()}`,
      visitor_name: 'Grace Hopper',
      visitor_email: 'grace@customer.example',
    },
    select: { id: true },
  });
  conversationA = conv.id;

  // A host the widget has been seen loading on but which the customer never listed
  // — the single most useful support signal the domain search can surface.
  await unscopedPrisma.website_domains.create({
    data: {
      workspace_id: workspaceA,
      website_id: websiteA,
      host: 'staging.acme.com',
      hits: 42,
      authorized: false,
    },
  });
});

after(async () => {
  // The plan catalog survives a TRUNCATE of users/workspaces, so anything this file
  // added to it has to be removed here or it leaks into every later suite.
  await unscopedPrisma.workspaces.deleteMany({});
  await unscopedPrisma.plans.deleteMany({ where: { is_public: false } });
  await app.close();
  await unscopedPrisma.$disconnect();
});

// ── Global search ────────────────────────────────────────────────────────────

test('the classifier reads each input shape, including the ones humans paste', () => {
  assert.equal(classify('ada@example.com'), 'email');
  assert.equal(classify('nst_abc123XYZ'), 'website_key');
  // Real keys are base64url, so `-` and `_` appear in about a third of them.
  assert.equal(classify('nst_Ab3-_xYz012345678_-abc'), 'website_key');
  assert.equal(classify('acme.com'), 'domain');
  assert.equal(classify('https://www.acme.com/pricing?x=1'), 'domain');
  assert.equal(classify('acme.co.uk'), 'domain');
  assert.equal(classify('3f8b8c1e-1111-4222-8333-444455556666'), 'uuid');
  assert.equal(classify('Acme'), 'text');
  // An address is an address even inside a URL-shaped string; @ wins over the dot.
  assert.equal(classify('grace@customer.example'), 'email');
});

test('an email finds the account, its workspaces, and its visitor traces', async () => {
  const res = await get('/platform/search?q=ada%40example.com');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().interpretedAs, 'email');

  const results = res.json().results as { kind: string; id: string; matched: string }[];
  const user = results.find((r) => r.kind === 'user');
  assert.ok(user, 'the account itself');
  assert.equal(user.id, adaUserId);
  // Each membership is its own hop, so an agency user does not need a second search.
  assert.ok(results.some((r) => r.kind === 'workspace' && r.id === workspaceA && r.matched === 'member of'));

  // An address with no account but a conversation still resolves — "we have no
  // account for you" is frequently the wrong answer.
  const visitor = await get('/platform/search?q=grace%40customer.example');
  const visitorResults = visitor.json().results as { kind: string; id: string }[];
  assert.equal(visitor.json().interpretedAs, 'email');
  assert.ok(visitorResults.some((r) => r.kind === 'conversation' && r.id === conversationA));
});

test('a widget public key resolves straight to its website and workspace', async () => {
  const res = await get(`/platform/search?q=${websiteKeyA}`);
  assert.equal(res.json().interpretedAs, 'website_key');
  const results = res.json().results as { kind: string; id: string; workspaceId: string }[];
  assert.equal(results.length, 1);
  assert.equal(results[0]!.kind, 'website');
  assert.equal(results[0]!.id, websiteA);
  assert.equal(results[0]!.workspaceId, workspaceA);
});

test('a domain matches configured AND observed hosts, and says which', async () => {
  const configured = await get('/platform/search?q=acme.com');
  assert.equal(configured.json().interpretedAs, 'domain');
  const hits = configured.json().results as { id: string; matched: string }[];
  assert.ok(hits.some((r) => r.id === websiteA && r.matched === 'configured domain'));

  // A pasted URL is the same question.
  const fromUrl = await get('/platform/search?q=https%3A%2F%2Facme.com%2Fpricing');
  assert.ok((fromUrl.json().results as { id: string }[]).some((r) => r.id === websiteA));

  // A host seen loading the widget but never authorized.
  const observed = await get('/platform/search?q=staging.acme.com');
  const observedResults = observed.json().results as { matched: string; sublabel: string }[];
  assert.ok(observedResults.some((r) => r.matched === 'observed loading'));
  assert.match(observedResults[0]!.sublabel, /NOT authorized/);
});

test('a uuid is ambiguous, so every table it could name is queried', async () => {
  const asWorkspace = await get(`/platform/search?q=${workspaceA}`);
  assert.equal(asWorkspace.json().interpretedAs, 'uuid');
  assert.equal((asWorkspace.json().results as { kind: string }[])[0]!.kind, 'workspace');

  const asConversation = await get(`/platform/search?q=${conversationA}`);
  const convResults = asConversation.json().results as { kind: string; workspaceId: string }[];
  assert.equal(convResults[0]!.kind, 'conversation');
  // Always one hop to the owning customer, whatever was pasted.
  assert.equal(convResults[0]!.workspaceId, workspaceA);

  const asWebsite = await get(`/platform/search?q=${websiteA}`);
  assert.equal((asWebsite.json().results as { kind: string }[])[0]!.kind, 'website');

  const unknown = await get('/platform/search?q=00000000-0000-4000-8000-000000000000');
  assert.deepEqual(unknown.json().results, []);
});

test('free text falls back to names and slugs across workspaces, users and websites', async () => {
  const res = await get('/platform/search?q=Acme');
  assert.equal(res.json().interpretedAs, 'text');
  const results = res.json().results as { kind: string; id: string }[];
  assert.ok(results.some((r) => r.kind === 'workspace' && r.id === workspaceA));
  assert.ok(results.some((r) => r.kind === 'website' && r.id === websiteA));
});

test('search requires a staff session', async () => {
  const res = await app.inject({ method: 'GET', url: '/platform/search?q=acme' });
  assert.equal(res.statusCode, 401);
});

// ── Workspace list and detail ────────────────────────────────────────────────

test('the list filters, searches by member email, and paginates', async () => {
  const all = await get('/platform/workspaces');
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().total, 2);

  const byMember = await get('/platform/workspaces?q=ada%40example.com');
  assert.equal(byMember.json().total, 1);
  assert.equal(byMember.json().workspaces[0].id, workspaceA);

  const byDomain = await get('/platform/workspaces?q=acme.com');
  assert.equal(byDomain.json().total, 1);

  const byStatus = await get('/platform/workspaces?status=active');
  assert.equal(byStatus.json().total, 0, 'both workspaces are trialing');

  const paged = await get('/platform/workspaces?per_page=1');
  assert.equal(paged.json().workspaces.length, 1);
  assert.equal(paged.json().total_pages, 2);
});

test('a soft-deleted workspace is hidden unless asked for', async () => {
  await unscopedPrisma.workspaces.update({ where: { id: workspaceB }, data: { deleted_at: new Date() } });
  assert.equal((await get('/platform/workspaces')).json().total, 1);
  assert.equal((await get('/platform/workspaces?include_deleted=true')).json().total, 2);
  await unscopedPrisma.workspaces.update({ where: { id: workspaceB }, data: { deleted_at: null } });
});

test('every detail tab answers, and none of them leaks a customer secret', async () => {
  const overview = await get(`/platform/workspaces/${workspaceA}`);
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().owners[0].email, 'ada@example.com');
  assert.equal(overview.json().signals.installed_websites, 0);

  const plan = await get(`/platform/workspaces/${workspaceA}/plan`);
  assert.equal(plan.statusCode, 200);
  assert.equal(plan.json().is_override, false);
  assert.ok(Array.isArray(plan.json().catalog));

  const usage = await get(`/platform/workspaces/${workspaceA}/usage`);
  assert.equal(usage.statusCode, 200);
  assert.equal(typeof usage.json().current.conversations, 'number');
  assert.equal(usage.json().levels.websites, 1);
  assert.equal(usage.json().levels.seats, 1);

  const websites = await get(`/platform/workspaces/${workspaceA}/websites`);
  assert.equal(websites.statusCode, 200);
  const site = websites.json().websites[0];
  assert.equal(site.id, websiteA);
  // Whether a signing secret exists is a support fact; the value is a customer
  // credential and must never appear on this plane.
  assert.equal(site.identity_secret, undefined);
  assert.equal(typeof site.has_identity_secret, 'boolean');
  assert.ok(site.domains.some((d: { host: string }) => d.host === 'staging.acme.com'));

  const members = await get(`/platform/workspaces/${workspaceA}/members`);
  assert.equal(members.json().members[0].user.email, 'ada@example.com');
  assert.equal(members.json().members[0].user.password_hash, undefined);

  const conversations = await get(`/platform/workspaces/${workspaceA}/conversations`);
  assert.equal(conversations.json().total, 1);
  const conv = conversations.json().conversations[0];
  // METADATA ONLY. Reading what was said requires impersonation with a reason.
  assert.equal(conv.id, conversationA);
  assert.equal(conv.messages, undefined);
  assert.equal(conv.metadata, undefined);
  assert.equal(conv.custom_attributes, undefined);

  const activity = await get(`/platform/workspaces/${workspaceA}/activity`);
  assert.equal(activity.statusCode, 200);
  assert.ok(Array.isArray(activity.json().impersonations));

  assert.equal((await get('/platform/workspaces/00000000-0000-4000-8000-000000000000')).statusCode, 404);
});

test('notes are append-only audit entries, and stay out of the activity tab', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceA}/notes`,
    headers: staffAuth(),
    payload: { body: 'Owner asked us to watch their AI spend this month.' },
  });
  assert.equal(created.statusCode, 201, created.body);

  const notes = await get(`/platform/workspaces/${workspaceA}/notes`);
  assert.equal(notes.json().notes.length, 1);
  assert.equal(notes.json().notes[0].details.body, 'Owner asked us to watch their AI spend this month.');
  assert.equal(notes.json().notes[0].actor_email, 'ops@nestled.chat');

  const activity = await get(`/platform/workspaces/${workspaceA}/activity`);
  const inActivity = (activity.json().entries as { action: string }[]).some(
    (e) => e.action === 'platform.note',
  );
  assert.equal(inActivity, false, 'notes must not pollute the activity list');
});

test('lifecycle levers require a reason and take effect immediately', async () => {
  const noReason = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceA}/lifecycle`,
    headers: staffAuth(),
    payload: { action: 'extend_trial', days: 14 },
  });
  assert.equal(noReason.statusCode, 400);

  const before_ = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceA } });
  const extended = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceA}/lifecycle`,
    headers: staffAuth(),
    payload: { action: 'extend_trial', days: 30, reason: 'customer is evaluating with a second team' },
  });
  assert.equal(extended.statusCode, 200, extended.body);
  const after_ = await unscopedPrisma.workspaces.findUniqueOrThrow({ where: { id: workspaceA } });
  assert.ok(after_.trial_ends_at! > before_.trial_ends_at!);

  // The reason is on the record, in the customer's own log.
  const entry = await unscopedPrisma.audit_log.findFirst({
    where: { workspace_id: workspaceA, action: 'platform.workspace_extend_trial' },
  });
  assert.ok(entry);
  assert.equal((entry.details as { reason: string }).reason, 'customer is evaluating with a second team');
  assert.equal(entry.actor_type, 'platform_user');
});

// ── Plans and overrides ──────────────────────────────────────────────────────

test('a per-workspace override is a private plan cloned from what they have today', async () => {
  const before_ = await get(`/platform/workspaces/${workspaceA}/plan`);
  const basePlan = before_.json().plan;
  assert.equal(before_.json().is_override, false);

  const res = await app.inject({
    method: 'PUT',
    url: `/platform/workspaces/${workspaceA}/plan-override`,
    headers: staffAuth(),
    payload: {
      reason: 'sales agreed 10 websites during the annual negotiation',
      max_websites: 10,
      allow_live_view: true,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().created, true);

  const plan = res.json().plan;
  assert.equal(plan.is_public, false, 'an override must not appear in the pricing page');
  assert.equal(plan.max_websites, 10);
  assert.equal(plan.allow_live_view, true);
  // Cloned, so the customer keeps everything their paid tier already granted.
  assert.equal(plan.max_conversations_month, basePlan.max_conversations_month);
  assert.equal(plan.max_seats, basePlan.max_seats);

  // The product reads workspace.plan.*, so the exception is live everywhere at once.
  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
    where: { id: workspaceA },
    select: { plan: true },
  });
  assert.equal(ws.plan.id, plan.id);
  assert.equal(ws.plan.max_websites, 10);

  // A second adjustment edits the same row rather than stacking another one.
  const again = await app.inject({
    method: 'PUT',
    url: `/platform/workspaces/${workspaceA}/plan-override`,
    headers: staffAuth(),
    payload: { reason: 'same negotiation, corrected the seat count', max_seats: 25 },
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().created, false);
  assert.equal(again.json().plan.id, plan.id);
  assert.equal(again.json().plan.max_websites, 10, 'the earlier override must survive');
  assert.equal(await unscopedPrisma.plans.count({ where: { is_public: false } }), 1);
});

test('removing an override returns the workspace to the catalog and tidies up', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/platform/workspaces/${workspaceA}/plan-override`,
    headers: staffAuth(),
    payload: { plan_code: 'pro', reason: 'contract ended, back on the list price' },
  });
  assert.equal(res.statusCode, 200, res.body);

  const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
    where: { id: workspaceA },
    select: { plan: { select: { code: true } } },
  });
  assert.equal(ws.plan.code, 'pro');
  assert.equal(await unscopedPrisma.plans.count({ where: { is_public: false } }), 0);
});

test('editing a catalog plan reports how many customers it touched', async () => {
  const pro = await unscopedPrisma.plans.findFirstOrThrow({ where: { code: 'pro' } });
  const onPro = await unscopedPrisma.workspaces.count({ where: { plan_id: pro.id } });

  const res = await app.inject({
    method: 'PATCH',
    url: `/platform/plans/${pro.id}`,
    headers: staffAuth(),
    payload: { max_triggers: 99 },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().plan.max_triggers, 99);
  // The blast radius is reported because editing a catalog plan changes the limits
  // of every customer on it at once, and that is easy to forget from a form.
  assert.equal(res.json().workspaces_affected, onPro);
  assert.ok(onPro > 0, 'precondition: somebody is on this plan');

  await unscopedPrisma.plans.update({ where: { id: pro.id }, data: { max_triggers: pro.max_triggers } });
});

test('exactly one plan stays the trial default', async () => {
  const original = await unscopedPrisma.plans.findFirstOrThrow({ where: { is_trial_default: true } });
  const starter = await unscopedPrisma.plans.findFirstOrThrow({ where: { code: 'starter' } });
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: `/platform/plans/${starter.id}`,
      headers: staffAuth(),
      payload: { is_trial_default: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    // Signup picks the trial default with findFirst, so two rows carrying the flag
    // is a silent bug: new customers land on whichever Postgres returned first.
    assert.equal(await unscopedPrisma.plans.count({ where: { is_trial_default: true } }), 1);
    assert.equal(
      (await unscopedPrisma.plans.findFirstOrThrow({ where: { is_trial_default: true } })).code,
      'starter',
    );
  } finally {
    // The plan catalog is install-wide state shared by every test file in this
    // serial run — leaving `starter` as the trial default silently changes which
    // plan later suites sign up onto, and they fail somewhere unrelated.
    await unscopedPrisma.plans.updateMany({ data: { is_trial_default: false } });
    await unscopedPrisma.plans.update({ where: { id: original.id }, data: { is_trial_default: true } });
  }
});

// ── Dunning ──────────────────────────────────────────────────────────────────

test('the worklist buckets each workspace once, in its most urgent bucket', async () => {
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceA },
    data: {
      subscription_status: 'past_due',
      grace_until: new Date(Date.now() + 3 * 86_400_000),
      purge_after: null,
    },
  });
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceB },
    data: { subscription_status: 'trialing', trial_ends_at: new Date(Date.now() + 2 * 86_400_000) },
  });

  const res = await get('/platform/dunning');
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().rows as { workspace_id: string; bucket: string; priority: number }[];

  const forA = rows.filter((r) => r.workspace_id === workspaceA);
  assert.equal(forA.length, 1, 'a workspace must appear exactly once, however many states it is in');
  // past_due AND in grace: grace is the more urgent conversation, because it has a
  // deadline attached.
  assert.equal(forA[0]!.bucket, 'grace');
  assert.ok(rows.some((r) => r.workspace_id === workspaceB && r.bucket === 'trial_ending'));

  // Ordered by urgency, not by insertion.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1]!.priority >= rows[i]!.priority, 'the worklist must be sorted by priority');
  }

  const filtered = await get('/platform/dunning?bucket=trial_ending');
  assert.ok((filtered.json().rows as { bucket: string }[]).every((r) => r.bucket === 'trial_ending'));
  // Totals cover every bucket even when the rows are filtered — the summary is what
  // gets read first.
  assert.ok(filtered.json().totals.grace);
});

test('a pending purge outranks everything, because it is the irreversible one', async () => {
  await unscopedPrisma.workspaces.update({
    where: { id: workspaceA },
    data: { purge_after: new Date(Date.now() + 5 * 86_400_000) },
  });
  const rows = (await get('/platform/dunning')).json().rows as { workspace_id: string; bucket: string }[];
  assert.equal(rows[0]!.workspace_id, workspaceA);
  assert.equal(rows[0]!.bucket, 'pending_purge');

  // And support can cancel it — the one lever here whose absence is unrecoverable.
  const cancelled = await app.inject({
    method: 'POST',
    url: `/platform/workspaces/${workspaceA}/lifecycle`,
    headers: staffAuth(),
    payload: { action: 'cancel_purge', reason: 'customer cancelled by mistake and re-subscribed' },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().workspace.purge_after, null);
});

// ── Health ───────────────────────────────────────────────────────────────────

test('health reports every subsystem with a server-computed status', async () => {
  const res = await get('/platform/health');
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json();

  for (const key of ['database', 'realtime', 'push', 'geoip', 'retention', 'email', 'billing']) {
    assert.ok(report[key], `missing subsystem: ${key}`);
    assert.ok(['ok', 'warn', 'fail'].includes(report[key].status), `${key}.status = ${report[key].status}`);
    // Thresholds live server-side so the page and any future alert agree.
    assert.equal(typeof report[key].detail, 'string');
  }

  assert.equal(report.database.status, 'ok');
  assert.equal(typeof report.database.latency_ms, 'number');
  assert.equal(report.realtime.agentSockets, 0);
  assert.equal(report.realtime.visitorSockets, 0);
  assert.equal(typeof report.push.stored_subscriptions, 'number');
  assert.equal(report.geoip.source, 'disabled');
  assert.equal(typeof report.billing.unprocessed_stripe_events, 'number');
  assert.equal(typeof report.process.uptime_seconds, 'number');
});

test('health is behind staff auth, unlike the load balancer probe', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/platform/health' })).statusCode, 401);
  // /healthz stays public and stays two fields — anything more is reconnaissance.
  const probe = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(Object.keys(probe.json()).sort(), ['db', 'status']);
});
