/*
 * Server test suite (Phase 10). Runs against a Postgres given by DATABASE_URL
 * (e.g. `docker compose up -d db`, or a throwaway `postgres:16` on :55432).
 *   npm test
 * Focus: the Phase 1 security regressions (visitor scope, role enforcement)
 * plus core flows. Uses Fastify's app.inject — no real socket needed.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Provide safe defaults BEFORE importing anything that reads env.ts.
process.env.NODE_ENV ??= 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-abcdefghijklmnop';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-abcdefghijklmnop';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173';
// Tests run against a DEDICATED database (never the dev DB) — the suite
// TRUNCATEs tables, so it must not share a DB with `npm run dev`. Default to
// jetchat_test on the same server; create it if missing.
process.env.DATABASE_URL ??= 'postgres://jetchat:jetchat@localhost:55432/jetchat_test';

{
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch {
    /* already exists — fine */
  } finally {
    await admin.end().catch(() => undefined);
  }
}

const { buildServer } = await import('../index.js');
const { runMigrations } = await import('../db/migrate.js');
const { prisma } = await import('../db/prisma.js');
const { topRelevant, keywordAnswer } = await import('../services/ai/knowledge.js');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

before(async () => {
  await runMigrations();
  // Fresh data; keep the singleton settings rows.
  await prisma.$executeRawUnsafe(`TRUNCATE agents, conversations, messages, refresh_tokens,
    push_subscriptions, attachments, canned_responses, conversation_notes,
    triggers, trigger_actions, trigger_events, trigger_behaviors,
    trigger_platforms, ai_usage, audit_log RESTART IDENTITY CASCADE`);
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ── Visitor scope (Phase 1 vulnerability regression) ─────────────────────────
test('visitor can only access its own conversation', async () => {
  const a = await app.inject({ method: 'POST', url: '/api/conversations', payload: { visitor_id: 'v1' } });
  assert.equal(a.statusCode, 201);
  const { conversation_id: c1, visitor_token: t1 } = a.json();
  assert.ok(c1 && t1);

  // own read OK
  const own = await app.inject({
    method: 'GET',
    url: `/api/conversations/${c1}/messages`,
    headers: { authorization: `Bearer ${t1}` },
  });
  assert.equal(own.statusCode, 200);

  // no token → 401
  const noTok = await app.inject({ method: 'GET', url: `/api/conversations/${c1}/messages` });
  assert.equal(noTok.statusCode, 401);

  // second conversation, read with first token → 401 (the core vuln)
  const b = await app.inject({ method: 'POST', url: '/api/conversations', payload: { visitor_id: 'v2' } });
  const { conversation_id: c2 } = b.json();
  const cross = await app.inject({
    method: 'GET',
    url: `/api/conversations/${c2}/messages`,
    headers: { authorization: `Bearer ${t1}` },
  });
  assert.equal(cross.statusCode, 401, 'cross-conversation read must be blocked');
});

test('protected endpoints reject anonymous callers', async () => {
  for (const url of ['/api/settings', '/api/agent/conversations', '/api/agents']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} must require auth`);
  }
});

test('public widget config never leaks secrets', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/widget-config' });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /api_key|webhook|password|token/i);
});

// ── Auth + roles ─────────────────────────────────────────────────────────────
let adminAccess = '';
let agentAccess = '';

test('first register bootstraps an admin; second is closed', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'Boss', email: 'boss@jetfood.com', password: 'supersecret1' },
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().agent.role, 'admin');
  adminAccess = first.json().access_token;

  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'X', email: 'x@x.com', password: 'supersecret1' },
  });
  assert.equal(second.statusCode, 403, 'registration must close after the first admin');
});

test('login rejects a wrong password', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'boss@jetfood.com', password: 'wrongpass1' },
  });
  assert.equal(res.statusCode, 401);
});

test('role enforcement: agent cannot use admin endpoints', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { authorization: `Bearer ${adminAccess}` },
    payload: { name: 'Aylin', email: 'aylin@jetfood.com', password: 'agentpass1', role: 'agent' },
  });
  assert.equal(created.statusCode, 201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'aylin@jetfood.com', password: 'agentpass1' },
  });
  agentAccess = login.json().access_token;

  // agent blocked from admin-only agent creation
  const blocked = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { authorization: `Bearer ${agentAccess}` },
    payload: { name: 'Z', email: 'z@z.com', password: 'password1', role: 'agent' },
  });
  assert.equal(blocked.statusCode, 403);

  // but agent CAN list conversations
  const list = await app.inject({
    method: 'GET',
    url: '/api/agent/conversations',
    headers: { authorization: `Bearer ${agentAccess}` },
  });
  assert.equal(list.statusCode, 200);
});

// ── Push subscription lifecycle ──────────────────────────────────────────────
test('push subscribe/unsubscribe lifecycle (auth required)', async () => {
  const sub = {
    subscription: { endpoint: 'https://example.com/push/abc', keys: { p256dh: 'BPtest', auth: 'authtest' } },
  };
  const noAuth = await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: sub });
  assert.equal(noAuth.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    headers: { authorization: `Bearer ${agentAccess}` },
    payload: sub,
  });
  assert.equal(ok.statusCode, 201);

  const un = await app.inject({
    method: 'POST',
    url: '/api/push/unsubscribe',
    headers: { authorization: `Bearer ${agentAccess}` },
    payload: { endpoint: sub.subscription.endpoint },
  });
  assert.equal(un.statusCode, 200);
});

// ── Trigger CRUD + analytics ─────────────────────────────────────────────────
test('trigger create → active → fire → delete', async () => {
  const body = {
    name: 'Greeter',
    identifier: 'greeter',
    is_active: true,
    priority: 0,
    actions: { show_message: true, message_content: 'Hi', localized_messages: {}, open_chatbox: false, play_sound: false },
    events: { on_leave_intent: false, on_click_link: false, click_selectors: [], on_pages: false, page_urls: [], on_url_parameters: false, url_parameters: {}, after_delay: true, delay_seconds: 5 },
    behaviors: { show_as_website: false, execute_if_online: false, execute_on_first_visit: false, execute_if_no_other_trigger: false, country_restriction: [] },
    platforms: { desktop_enabled: true, mobile_enabled: true },
  };
  const create = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers: { authorization: `Bearer ${adminAccess}` },
    payload: body,
  });
  assert.equal(create.statusCode, 201);
  const id = create.json().id;

  const active = await app.inject({ method: 'GET', url: '/api/triggers/active' });
  assert.equal(active.statusCode, 200);
  assert.ok(active.json().triggers.some((t: { id: string }) => t.id === id));

  await app.inject({ method: 'POST', url: `/api/triggers/${id}/fire` });
  const list = await app.inject({
    method: 'GET',
    url: '/api/triggers',
    headers: { authorization: `Bearer ${adminAccess}` },
  });
  const t = list.json().triggers.find((x: { id: string }) => x.id === id);
  assert.equal(t.fire_count, 1);

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/triggers/${id}`,
    headers: { authorization: `Bearer ${adminAccess}` },
  });
  assert.equal(del.statusCode, 200);
});

// ── Knowledge-base scoring (pure unit) ───────────────────────────────────────
test('KB retrieval scores the most relevant entry first', () => {
  const kb = [
    { question: 'What are your hours?', answer: 'Open 9-9.', category: 'general', keywords: ['hours', 'open'], priority: 0 },
    { question: 'Where are you located?', answer: 'Downtown.', category: 'general', keywords: ['location', 'address'], priority: 0 },
  ];
  const top = topRelevant('what are your opening hours', kb, 1);
  assert.equal(top[0]?.answer, 'Open 9-9.');
  assert.equal(keywordAnswer('hours?', kb), 'Open 9-9.');
});
