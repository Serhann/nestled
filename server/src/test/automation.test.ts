import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { invalidateWorkspaceCache } from '../plugins/auth.js';

/**
 * Triggers, routing rules and bot flows over the API.
 *
 * The two things worth pinning here are the ones a customer notices: a plan limit
 * that refuses cleanly instead of letting them build something they cannot use,
 * and the guarantee that workspace B holding workspace A's id learns nothing.
 */

let app: FastifyInstance;
let adaToken: string;
let bobToken: string;
let adaWs: string;
let bobWs: string;
let adaSite: string;
let bobSite: string;
let adaMemberId: string;

const PASSWORD = 'correct horse battery';

async function signup(name: string, email: string, workspace: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  await unscopedPrisma.users.update({ where: { email }, data: { email_verified_at: new Date() } });
  return res.json().access_token as string;
}

async function workspaceOf(token: string): Promise<string> {
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return me.json().workspaces[0].id as string;
}

async function makeWebsite(token: string, workspaceId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().website.id as string;
}

/** Move a workspace onto a named plan and drop the 30s auth cache. */
async function setPlan(workspaceId: string, code: string): Promise<void> {
  const plan = await unscopedPrisma.plans.findUniqueOrThrow({ where: { code } });
  await unscopedPrisma.workspaces.update({ where: { id: workspaceId }, data: { plan_id: plan.id } });
  invalidateWorkspaceCache(workspaceId);
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  adaToken = await signup('Ada', 'ada@example.com', 'Acme');
  bobToken = await signup('Bob', 'bob@example.com', 'Beta');
  adaWs = await workspaceOf(adaToken);
  bobWs = await workspaceOf(bobToken);
  adaSite = await makeWebsite(adaToken, adaWs, 'Acme Storefront');
  bobSite = await makeWebsite(bobToken, bobWs, 'Beta Storefront');
  adaMemberId = (
    await unscopedPrisma.workspace_members.findFirstOrThrow({ where: { workspace_id: adaWs } })
  ).id;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

const ada = () => ({ authorization: `Bearer ${adaToken}` });
const bob = () => ({ authorization: `Bearer ${bobToken}` });

// ── Triggers ─────────────────────────────────────────────────────────────────

test('a trigger round-trips through create, list, update and delete', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: {
      name: 'Pricing page nudge',
      identifier: 'pricing-nudge',
      // NULL website_id means "every website in this workspace" — the shape that
      // replaced the old `sites String[]`, which could name a deleted site.
      website_id: null,
      actions: { show_message: true, message_content: 'Questions about pricing?' },
      events: { on_pages: true, page_urls: ['https://acme.com/pricing'] },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().item.id as string;
  // Defaults are filled in by zod, so the JSONB is a record rather than whatever
  // the client happened to send.
  assert.equal(created.json().item.actions.open_chatbox, false);
  assert.equal(created.json().item.platforms.desktop_enabled, true);

  const listed = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
  });
  assert.equal(listed.json().items.length, 1);

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/v1/w/${adaWs}/triggers/${id}`,
    headers: ada(),
    payload: { is_active: false },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().item.is_active, false);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${adaWs}/triggers/${id}`,
    headers: ada(),
  });
  assert.equal(removed.statusCode, 200);
});

test('an unknown key in the actions bag is a 400, not silently stored', async () => {
  // The point of validating the JSONB is that it stays a record. A typo that lands
  // in the column and never fires is the failure mode this prevents.
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: {
      name: 'Typo',
      identifier: 'typo',
      actions: { show_massage: true },
    },
  });
  assert.equal(res.statusCode, 400);
});

test('a duplicate identifier is a clean 409', async () => {
  const payload = { name: 'One', identifier: 'only-one' };
  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: { ...payload, name: 'Two' },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'identifier_taken');

  await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${adaWs}/triggers/${first.json().item.id}`,
    headers: ada(),
  });
});

test('the trigger plan limit refuses with a 402 the billing page can render', async () => {
  await setPlan(adaWs, 'free'); // free includes exactly one trigger
  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: { name: 'First', identifier: 'first' },
  });
  assert.equal(first.statusCode, 201, first.body);

  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: { name: 'Second', identifier: 'second' },
  });
  assert.equal(second.statusCode, 402, second.body);
  // The same body shape every other plan limit produces, so the client renders all
  // of them through one component.
  const body = second.json();
  assert.equal(body.code, 'plan_limit');
  assert.equal(body.metric, 'triggers');
  assert.equal(body.limit, 1);
  assert.equal(body.used, 1);

  await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${adaWs}/triggers/${first.json().item.id}`,
    headers: ada(),
  });
  await setPlan(adaWs, 'pro');
});

test('a website_id from another workspace is a 404, not a dangling scope', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: { name: 'Cross', identifier: 'cross', website_id: bobSite },
  });
  assert.equal(res.statusCode, 404);
});

// ── Routing rules ────────────────────────────────────────────────────────────

test('a routing rule round-trips, and its pool must be in the workspace', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/routing`,
    headers: ada(),
    payload: {
      name: 'Pricing goes to sales',
      website_id: adaSite,
      priority: 10,
      conditions: { pages: ['*/pricing*'], max_concurrent: 3 },
      strategy: 'round_robin',
      member_pool: [adaMemberId],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().item.id as string;
  assert.equal(created.json().item.conditions.max_concurrent, 3);

  const bad = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/routing`,
    headers: ada(),
    payload: {
      name: 'Routes to a stranger',
      // A member id from nowhere would make the rule route to nobody, silently.
      member_pool: ['00000000-0000-0000-0000-000000000000'],
    },
  });
  assert.equal(bad.statusCode, 404);

  const listed = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${adaWs}/routing`,
    headers: ada(),
  });
  assert.equal(listed.json().items.length, 1);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${adaWs}/routing/${id}`,
    headers: ada(),
  });
  assert.equal(removed.statusCode, 200);
});

test('an unknown strategy is refused by the enum, not by the database', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/routing`,
    headers: ada(),
    payload: { name: 'Coin flip', strategy: 'random' },
  });
  assert.equal(res.statusCode, 400);
});

// ── Bot flows ────────────────────────────────────────────────────────────────

test('bot flows are plan-gated before they are limit-gated', async () => {
  await setPlan(adaWs, 'free'); // free does not include the bot at all
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: ada(),
    payload: { name: 'Blocked' },
  });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().metric, 'bot_flows');
  await setPlan(adaWs, 'pro');
});

test('publishing an invalid draft is a 422 listing every problem', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: ada(),
    payload: {
      name: 'Half built',
      // Saving a broken draft is ALLOWED — a builder that refuses to save
      // half-finished work is a builder people lose work in.
      draft_graph: {
        entry: 'greet',
        nodes: [
          { id: 'greet', type: 'message', text: 'Hi', next: 'ghost' },
          { id: 'ask', type: 'choices', text: 'Pick', options: [] },
        ],
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().item.id as string;

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/publish`,
    headers: ada(),
  });
  assert.equal(published.statusCode, 422, published.body);
  const found = new Set(published.json().issues.map((i: { code: string }) => i.code));
  assert.ok(found.has('dangling_edge'));
  assert.ok(found.has('choices_empty'));

  await app.inject({ method: 'DELETE', url: `/api/v1/w/${adaWs}/bots/${id}`, headers: ada() });
});

test('publish snapshots a version, and rollback just repoints at an old one', async () => {
  const v1 = {
    entry: 'greet',
    nodes: [{ id: 'greet', type: 'message', text: 'Version one', next: null }],
  };
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: ada(),
    payload: { name: 'Versioned', draft_graph: v1 },
  });
  const id = created.json().item.id as string;

  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/publish`,
    headers: ada(),
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().item.published_version, 1);

  await app.inject({
    method: 'PUT',
    url: `/api/v1/w/${adaWs}/bots/${id}`,
    headers: ada(),
    payload: {
      draft_graph: {
        entry: 'greet',
        nodes: [{ id: 'greet', type: 'message', text: 'Version two', next: null }],
      },
    },
  });
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/publish`,
    headers: ada(),
  });
  assert.equal(second.json().item.published_version, 2);

  const versions = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${adaWs}/bots/${id}/versions`,
    headers: ada(),
  });
  assert.deepEqual(
    versions.json().versions.map((v: { version: number }) => v.version),
    [2, 1],
  );

  const rolled = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/rollback`,
    headers: ada(),
    payload: { version: 1 },
  });
  assert.equal(rolled.statusCode, 200, rolled.body);
  assert.equal(rolled.json().item.published_version, 1);

  // Version 1 still says what it said. Immutability is what lets a conversation
  // already halfway through a flow keep executing the graph it started on.
  const stored = await unscopedPrisma.bot_flow_versions.findFirstOrThrow({
    where: { flow_id: id, version: 1 },
  });
  assert.deepEqual(stored.graph, v1);

  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/rollback`,
    headers: ada(),
    payload: { version: 99 },
  });
  assert.equal(missing.statusCode, 404);
});

test('simulate runs the real engine and reports what the visitor would see', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: ada(),
    payload: {
      name: 'Simulated',
      draft_graph: {
        entry: 'greet',
        nodes: [
          { id: 'greet', type: 'message', text: 'Hello there', next: 'ask' },
          {
            id: 'ask',
            type: 'choices',
            text: 'Orders or returns?',
            save_as: 'topic',
            options: [
              { label: 'Orders', next: 'bye' },
              { label: 'Returns', next: 'bye' },
            ],
          },
          { id: 'bye', type: 'end', message: 'Thanks!' },
        ],
      },
    },
  });
  const id = created.json().item.id as string;

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${id}/simulate`,
    headers: ada(),
    payload: { inputs: ['Orders'] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const sim = res.json();
  assert.deepEqual(
    sim.steps.map((s: { text: string }) => s.text),
    ['Hello there', 'Orders or returns?', 'Thanks!'],
  );
  // The choices step carries the buttons the widget would render.
  assert.deepEqual(sim.steps[1].options, [
    { label: 'Orders', value: 'Orders' },
    { label: 'Returns', value: 'Returns' },
  ]);
  assert.equal(sim.status, 'completed');
  assert.deepEqual(sim.collected, { topic: 'Orders' });
});

// ── Cross-tenant ─────────────────────────────────────────────────────────────

test("workspace B holding workspace A's ids learns nothing", async () => {
  const trigger = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/triggers`,
    headers: ada(),
    payload: { name: 'Ada only', identifier: 'ada-only' },
  });
  const rule = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/routing`,
    headers: ada(),
    payload: { name: 'Ada only', strategy: 'least_active' },
  });
  const flow = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: ada(),
    payload: {
      name: 'Ada only',
      draft_graph: { entry: 'a', nodes: [{ id: 'a', type: 'message', text: 'Hi', next: null }] },
    },
  });
  assert.equal(flow.statusCode, 201, flow.body);
  const triggerId = trigger.json().item.id as string;
  const ruleId = rule.json().item.id as string;
  const flowId = flow.json().item.id as string;
  await app.inject({
    method: 'POST',
    url: `/api/v1/w/${adaWs}/bots/${flowId}/publish`,
    headers: ada(),
  });

  // Under Bob's OWN workspace, with Ada's ids. 404 every time — never a 200, and
  // never a 403, which would confirm the id exists.
  const attempts: [string, string, object?][] = [
    ['PUT', `/api/v1/w/${bobWs}/triggers/${triggerId}`, { name: 'Mine now' }],
    ['DELETE', `/api/v1/w/${bobWs}/triggers/${triggerId}`],
    ['PUT', `/api/v1/w/${bobWs}/routing/${ruleId}`, { name: 'Mine now' }],
    ['DELETE', `/api/v1/w/${bobWs}/routing/${ruleId}`],
    ['GET', `/api/v1/w/${bobWs}/bots/${flowId}`],
    ['PUT', `/api/v1/w/${bobWs}/bots/${flowId}`, { name: 'Mine now' }],
    ['DELETE', `/api/v1/w/${bobWs}/bots/${flowId}`],
    ['POST', `/api/v1/w/${bobWs}/bots/${flowId}/publish`, {}],
    ['GET', `/api/v1/w/${bobWs}/bots/${flowId}/versions`],
    ['POST', `/api/v1/w/${bobWs}/bots/${flowId}/rollback`, { version: 1 }],
    ['POST', `/api/v1/w/${bobWs}/bots/${flowId}/simulate`, {}],
  ];
  for (const [method, url, payload] of attempts) {
    const res = await app.inject({ method: method as 'GET', url, headers: bob(), payload });
    assert.equal(res.statusCode, 404, `${method} ${url} returned ${res.statusCode}: ${res.body}`);
  }

  // And addressing Ada's workspace directly with Bob's token is a 404 at the guard.
  const trespass = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${adaWs}/bots`,
    headers: bob(),
  });
  assert.equal(trespass.statusCode, 404);

  // Bob's own lists stay empty — nothing leaked sideways into them either.
  for (const surface of ['triggers', 'routing', 'bots']) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/w/${bobWs}/${surface}`,
      headers: bob(),
    });
    assert.deepEqual(listed.json().items, [], `${surface} must be empty for Bob`);
  }

  // A trigger may not point start_bot at another workspace's flow.
  const stolenBot = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${bobWs}/triggers`,
    headers: bob(),
    payload: { name: 'Borrowed', identifier: 'borrowed', actions: { start_bot: flowId } },
  });
  assert.equal(stolenBot.statusCode, 404);
});
