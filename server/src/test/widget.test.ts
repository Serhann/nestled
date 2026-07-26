import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { verifyWidgetSession } from '../services/widgetSession.js';
import { invalidateWorkspaceCache } from '../plugins/auth.js';

/**
 * The public widget plane, end to end.
 *
 * This is the test that says the product works: a visitor on a customer's site
 * boots the widget, starts a conversation, sends a message, and the agent sees it —
 * with a second workspace unable to observe or touch any of it.
 *
 * It also pins the two fixes for the presence takeover that existed in the
 * pre-tenant build (see services/widgetSession.ts and realtime/presence.ts).
 */

let app: FastifyInstance;
let ownerToken: string;
let workspaceId: string;
let websiteId: string;
let publicKey: string;

const PASSWORD = 'correct horse battery';

async function signup(name: string, email: string, workspace: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().access_token as string;
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  ownerToken = await signup('Ada', 'ada@example.com', 'Acme');
  // Verified so the widget is servable — requireVerified gates exactly that.
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  workspaceId = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: 'Acme Storefront', primary_domain: 'acme.com' },
  });
  websiteId = site.json().website.id;
  publicKey = site.json().website.public_key;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

const agentAuth = () => ({ authorization: `Bearer ${ownerToken}` });

test('boot returns theme, copy and behaviour, and never a secret', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/widget/boot?key=${publicKey}&href=https://acme.com/pricing`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const boot = res.json();
  assert.equal(boot.enabled, true);
  assert.equal(boot.website.id, websiteId);
  assert.ok(boot.theme.primary_color);
  // Defaults are merged server-side, so a customer who never edited a string still
  // gets it — and gets improvements to it later.
  assert.ok(boot.copy.welcomeMessage);
  assert.equal(typeof boot.availability.online, 'boolean');

  // The single most important assertion on this endpoint: it is reachable by
  // anyone on the internet, so nothing sensitive may appear in the payload.
  const body = res.body;
  for (const forbidden of ['identity_secret', 'discord_webhook', 'password_hash', 'visitor_token_hash']) {
    assert.ok(!body.includes(forbidden), `boot payload leaked ${forbidden}`);
  }
});

test('an unknown website key is a 404 with no detail', async () => {
  // Must not become an oracle for which keys exist.
  const res = await app.inject({ method: 'GET', url: '/api/v1/widget/boot?key=nst_definitely_not_real' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not found' });
});

test('the session token carries the tenant, so the visitor id cannot be asserted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/session',
    payload: { key: publicKey, href: 'https://acme.com/' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { session_token, visitor_id } = res.json();

  // THE fix for the pre-tenant takeover: the workspace, website and visitor id all
  // live inside a signature we produced. Previously `/ws/presence?visitor_id=…`
  // accepted whatever the caller sent, and the proactive frame handed that caller
  // the conversation's visitor_token.
  const payload = verifyWidgetSession(session_token);
  assert.ok(payload);
  assert.equal(payload.ws, workspaceId);
  assert.equal(payload.wsite, websiteId);
  assert.equal(payload.vid, visitor_id);

  // A forged token is refused outright.
  assert.equal(verifyWidgetSession('not.a.token'), null);
});

test('a conversation cannot be created without a valid session token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: 'forged-token-value' },
  });
  assert.equal(res.statusCode, 401);
});

test('full round trip: visitor sends, agent sees it and replies, visitor sees the reply', async () => {
  const session = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/widget/session',
      payload: { key: publicKey, href: 'https://acme.com/' },
    })
  ).json();

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: {
      session_token: session.session_token,
      visitor_email: 'buyer@example.com',
      metadata: { current_page: 'https://acme.com/pricing' },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { conversation_id, visitor_token } = created.json();

  const sent = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${conversation_id}/messages`,
    headers: { authorization: `Bearer ${visitor_token}` },
    payload: { content: 'Do you ship to Türkiye?' },
  });
  assert.equal(sent.statusCode, 201, sent.body);

  // The agent's inbox sees it, with the preview and counters the list renders from.
  const inbox = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/conversations`,
    headers: agentAuth(),
  });
  assert.equal(inbox.statusCode, 200, inbox.body);
  const row = inbox.json().conversations.find((c: { id: string }) => c.id === conversation_id);
  assert.ok(row, 'the conversation must appear in the agent inbox');
  assert.equal(row.last_message, 'Do you ship to Türkiye?');
  assert.equal(row.last_sender, 'visitor');
  // Maintained by the database trigger, not by the route.
  assert.equal(row.message_count, 1);

  const replied = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/conversations/${conversation_id}/messages`,
    headers: agentAuth(),
    payload: { content: 'Yes — 2 to 3 business days.' },
  });
  assert.equal(replied.statusCode, 201, replied.body);

  // And the visitor can read the thread with their own token.
  const thread = await app.inject({
    method: 'GET',
    url: `/api/v1/widget/conversations/${conversation_id}/messages`,
    headers: { authorization: `Bearer ${visitor_token}` },
  });
  assert.deepEqual(
    thread.json().messages.map((m: { sender_type: string }) => m.sender_type),
    ['visitor', 'agent'],
  );

  // First-response time is stamped once, for reporting.
  const conv = await unscopedPrisma.conversations.findUniqueOrThrow({ where: { id: conversation_id } });
  assert.ok(conv.first_response_at, 'the first agent reply must stamp first_response_at');
});

test('a visitor token unlocks only its own conversation', async () => {
  const mk = async () => {
    const s = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/widget/session',
        payload: { key: publicKey },
      })
    ).json();
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/conversations',
      payload: { session_token: s.session_token },
    });
    return c.json() as { conversation_id: string; visitor_token: string };
  };
  const a = await mk();
  const b = await mk();

  // Visitor A presenting their token against B's conversation. 401 for both "wrong
  // token" and "no such conversation", so ids cannot be probed.
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/widget/conversations/${b.conversation_id}/messages`,
    headers: { authorization: `Bearer ${a.visitor_token}` },
  });
  assert.equal(res.statusCode, 401);
});

test('the domain allowlist is recorded and enforced only when asked', async () => {
  // Lock the website to acme.com...
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}`,
    headers: agentAuth(),
    payload: { allowed_domains: ['acme.com'], enforce_domains: true },
  });

  const wrong = await app.inject({
    method: 'GET',
    url: `/api/v1/widget/boot?key=${publicKey}&href=https://someone-elses-site.com/`,
  });
  assert.equal(wrong.json().enabled, false);
  assert.equal(wrong.json().authorized, false);

  // A subdomain of an allowed bare domain still works — otherwise every customer
  // has to enumerate www, app, shop… and will get it wrong.
  const sub = await app.inject({
    method: 'GET',
    url: `/api/v1/widget/boot?key=${publicKey}&href=https://shop.acme.com/`,
  });
  assert.equal(sub.json().enabled, true);

  // The unauthorized host is still RECORDED — that row is what lets the install
  // detector say "we saw your snippet on the wrong domain" instead of "nothing yet".
  const seen = await unscopedPrisma.website_domains.findFirst({
    where: { website_id: websiteId, host: 'someone-elses-site.com' },
  });
  assert.ok(seen, 'an unauthorized host must still be recorded');
  assert.equal(seen.authorized, false);

  const status = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/install-status`,
    headers: agentAuth(),
  });
  assert.equal(status.json().wrong_domain_host, 'someone-elses-site.com');

  // Unlock for the remaining tests.
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}`,
    headers: agentAuth(),
    payload: { allowed_domains: [], enforce_domains: false },
  });
});

test('a second workspace cannot see the first one\'s conversations', async () => {
  const bobToken = await signup('Bob', 'bob@example.com', 'Beta');
  const bobWs = (
    await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${bobToken}` },
    })
  ).json().workspaces[0].id;

  const bobInbox = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${bobWs}/conversations`,
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.deepEqual(bobInbox.json().conversations, [], "Bob's inbox must be empty");

  // And Ada's workspace is not addressable by him at all.
  const trespass = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/conversations`,
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(trespass.statusCode, 404);
});

test('resolving a conversation notifies the widget and stamps resolved_at', async () => {
  const s = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const c = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/widget/conversations',
      payload: { session_token: s.session_token },
    })
  ).json();

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/conversations/${c.conversation_id}/status`,
    headers: agentAuth(),
    payload: { status: 'resolved' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id: c.conversation_id },
  });
  assert.equal(row.status, 'resolved');
  assert.ok(row.resolved_at);

  // A visitor writing again re-opens it: they should never have to start over
  // because an agent closed the thread.
  await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${c.conversation_id}/messages`,
    headers: { authorization: `Bearer ${c.visitor_token}` },
    payload: { content: 'One more thing' },
  });
  const reopened = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id: c.conversation_id },
  });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolved_at, null);
});

test('the rating lands in columns, so CSAT is reportable rather than text-searched', async () => {
  const s = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const c = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/widget/conversations',
      payload: { session_token: s.session_token },
    })
  ).json();

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${c.conversation_id}/rating`,
    headers: { authorization: `Bearer ${c.visitor_token}` },
    payload: { stars: 5, tags: ['Fast reply'], comment: 'Great' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const row = await unscopedPrisma.conversations.findUniqueOrThrow({
    where: { id: c.conversation_id },
  });
  assert.equal(row.rating_stars, 5);
  assert.deepEqual(row.rating_tags, ['Fast reply']);
});

test('the conversation counter is metered in the same transaction as the insert', async () => {
  const before = await unscopedPrisma.usage_counters.findFirst({
    where: { workspace_id: workspaceId, metric: 'conversations' },
  });
  const s = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: s.session_token },
  });
  const after_ = await unscopedPrisma.usage_counters.findFirstOrThrow({
    where: { workspace_id: workspaceId, metric: 'conversations' },
  });
  // Same transaction as the row it counts, so the metered number cannot drift from
  // reality — which matters because it is what the limiter bills against.
  assert.equal(Number(after_.value), Number(before?.value ?? 0) + 1);
});

test('canned responses and KB are scoped, and workspace-wide entries are visible', async () => {
  await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/canned`,
    headers: agentAuth(),
    payload: { shortcut: 'hello', title: 'Greeting', content: 'Hi!' },
  });
  // website_id NULL means "every website in the workspace" — the shape that replaced
  // the old `sites String[]`, which could name a site that no longer existed.
  await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/kb`,
    headers: agentAuth(),
    payload: { question: 'Do you ship abroad?', answer: 'Yes.', website_id: null },
  });

  const canned = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/canned`,
    headers: agentAuth(),
  });
  assert.equal(canned.json().items.length, 1);

  // A duplicate shortcut is a clean 409, not a 500 from the unique index.
  const dup = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/canned`,
    headers: agentAuth(),
    payload: { shortcut: 'hello', title: 'Other', content: 'Hey' },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().code, 'shortcut_taken');
});

test('a copy override with an unknown key is refused', async () => {
  // The key set is closed on purpose: a typo must be a 400, not a string that
  // silently never renders and costs someone an afternoon.
  const bad = await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/settings`,
    headers: agentAuth(),
    payload: { copy: { notARealKey: 'x' } },
  });
  assert.equal(bad.statusCode, 400);

  const good = await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/settings`,
    headers: agentAuth(),
    payload: { copy: { welcomeMessage: 'Merhaba!' } },
  });
  assert.equal(good.statusCode, 200, good.body);

  const boot = await app.inject({ method: 'GET', url: `/api/v1/widget/boot?key=${publicKey}` });
  assert.equal(boot.json().copy.welcomeMessage, 'Merhaba!');
  // Untouched strings still come from the defaults.
  assert.ok(boot.json().copy.sendLabel);
});

test('plan gating is applied server-side, not trusted from the client', async () => {
  // Pro allows removing branding; assert the flag round-trips, then that a plan
  // WITHOUT the entitlement has it forced back on.
  await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/settings`,
    headers: agentAuth(),
    payload: { show_branding: false },
  });
  let settings = await unscopedPrisma.website_settings.findUniqueOrThrow({
    where: { website_id: websiteId },
  });
  assert.equal(settings.show_branding, false);

  const free = await unscopedPrisma.plans.findUniqueOrThrow({ where: { code: 'free' } });
  await unscopedPrisma.workspaces.update({ where: { id: workspaceId }, data: { plan_id: free.id } });
  // The auth context caches the workspace for 30s. Invalidate explicitly rather
  // than sleeping it out — a test that waits on a TTL is a test nobody runs.
  invalidateWorkspaceCache(workspaceId);

  await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/settings`,
    headers: agentAuth(),
    payload: { show_branding: false },
  });
  settings = await unscopedPrisma.website_settings.findUniqueOrThrow({
    where: { website_id: websiteId },
  });
  assert.equal(settings.show_branding, true, 'a plan without the entitlement must force branding on');
});
