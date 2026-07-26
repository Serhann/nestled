import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * A published flow, run to completion BY A VISITOR through the real widget
 * endpoints.
 *
 * Nothing here reaches into the engine. The point is the whole seam: the builder
 * publishes, a visitor on a customer's site answers questions, and the agent who
 * picks the chat up afterwards reads a normal transcript with the collected email
 * in it. If any layer between those two people is wrong, this test is what says so.
 */

let app: FastifyInstance;
let token: string;
let workspaceId: string;
let websiteId: string;
let publicKey: string;
let flowId: string;

const PASSWORD = 'correct horse battery';

/** greet → choices → collect email → hours condition → ai_answer → handoff. */
const SIX_NODE_FLOW = {
  entry: 'greet',
  nodes: [
    { id: 'greet', type: 'message', text: 'Hi! I can help with orders.', next: 'topic' },
    {
      id: 'topic',
      type: 'choices',
      text: 'What is this about?',
      save_as: 'topic',
      options: [
        { label: 'An order', value: 'order', next: 'email' },
        { label: 'Something else', value: 'other', next: 'email' },
      ],
    },
    {
      id: 'email',
      type: 'collect',
      field: 'email',
      prompt: 'What email address is on the order?',
      expect: 'email',
      next: 'open',
    },
    {
      id: 'open',
      type: 'condition',
      when: { kind: 'hours', open: true },
      then: 'answer',
      otherwise: 'human',
    },
    { id: 'answer', type: 'ai_answer', prompt: 'How long does delivery take?', next: 'human' },
    { id: 'human', type: 'handoff', message: 'Let me get a colleague for you.' },
  ],
};

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada', email: 'ada@example.com', password: PASSWORD, workspace_name: 'Acme' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  token = signup.json().access_token;
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  workspaceId = me.json().workspaces[0].id;

  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Acme Storefront' },
  });
  websiteId = site.json().website.id;
  publicKey = site.json().website.public_key;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

const agent = () => ({ authorization: `Bearer ${token}` });

test('a six-node flow publishes cleanly', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/bots`,
    headers: agent(),
    payload: {
      name: 'Order triage',
      is_active: true,
      // Started by a conversation starter rather than by every visitor: an empty
      // entry deliberately never fires on its own.
      entry: { starter: 'orders' },
      draft_graph: SIX_NODE_FLOW,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  flowId = created.json().item.id;

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/bots/${flowId}/publish`,
    headers: agent(),
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().item.published_version, 1);
});

test('a visitor completes the flow through the widget, and the agent reads the transcript', async () => {
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
    payload: { session_token: session.session_token, starter_key: 'orders' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { conversation_id, visitor_token } = created.json();
  const visitor = { authorization: `Bearer ${visitor_token}` };

  const thread = async (): Promise<
    { content: string; sender_type: string; metadata: Record<string, unknown> }[]
  > => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/widget/conversations/${conversation_id}/messages`,
      headers: visitor,
    });
    return res.json().messages;
  };

  // The greeting and the first question are already there — the flow ran on the
  // server before the create call returned, so the visitor never sees an empty box.
  let messages = await thread();
  assert.deepEqual(
    messages.map((m) => m.content),
    ['Hi! I can help with orders.', 'What is this about?'],
  );
  assert.ok(messages.every((m) => m.sender_type === 'bot'));

  // The choices step carries the hint that tells the widget to render buttons. This
  // is the entire client contract: the widget renders, it never interprets.
  const hint = messages[1]!.metadata['bot:step'] as {
    kind: string;
    options: { label: string; value: string }[];
  };
  assert.equal(hint.kind, 'choices');
  assert.deepEqual(hint.options, [
    { label: 'An order', value: 'order' },
    { label: 'Something else', value: 'other' },
  ]);

  const say = async (content: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/widget/conversations/${conversation_id}/messages`,
      headers: visitor,
      payload: { content },
    });
    assert.equal(res.statusCode, 201, res.body);
  };

  await say('An order');
  messages = await thread();
  assert.equal(messages[messages.length - 1]!.content, 'What email address is on the order?');

  // Something that is not an email address gets the question again rather than
  // being stored — a bot that accepts "no thanks" as an email is worse than one
  // that asks twice.
  await say('not an email');
  messages = await thread();
  assert.equal(messages[messages.length - 1]!.content, 'What email address is on the order?');

  // A version published mid-run must NOT change what this conversation is doing.
  await app.inject({
    method: 'PUT',
    url: `/api/v1/w/${workspaceId}/bots/${flowId}`,
    headers: agent(),
    payload: {
      draft_graph: {
        ...SIX_NODE_FLOW,
        nodes: SIX_NODE_FLOW.nodes.map((n) =>
          n.id === 'human' ? { ...n, message: 'VERSION TWO SPEAKING' } : n,
        ),
      },
    },
  });
  const republished = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/bots/${flowId}/publish`,
    headers: agent(),
  });
  assert.equal(republished.json().item.published_version, 2);

  await say('buyer@example.com');

  const run = await unscopedPrisma.bot_flow_runs.findFirstOrThrow({
    where: { conversation_id },
  });
  assert.equal(run.status, 'handoff');
  assert.equal(run.flow_version, 1, 'the run stays pinned to the version it started on');
  assert.deepEqual(run.state, {
    collected: { topic: 'order', email: 'buyer@example.com' },
    awaiting: null,
    steps: (run.state as { steps: number }).steps,
  });

  messages = await thread();
  assert.ok(
    messages.some((m) => m.content === 'Let me get a colleague for you.'),
    'the flow must reach its handoff step',
  );
  assert.ok(
    !messages.some((m) => m.content.includes('VERSION TWO')),
    'a version published mid-run must not change a running conversation',
  );

  // The bot outranks the plain AI auto-reply: two assistants answering the same
  // question is worse than either alone.
  assert.ok(
    !messages.some((m) => m.sender_type === 'ai'),
    'the AI auto-reply must stay out of the way while a flow is running',
  );

  // And the agent inbox shows all of it as an ordinary conversation, because the
  // bot wrote through the ordinary message path.
  const inbox = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${workspaceId}/conversations/${conversation_id}`,
    headers: agent(),
  });
  assert.equal(inbox.statusCode, 200, inbox.body);
  const conversation = inbox.json().conversation;
  assert.equal(conversation.needs_human, true);
  assert.equal(conversation.metadata.handoff.by, 'bot');
  const senders: string[] = conversation.messages.map((m: { sender_type: string }) => m.sender_type);
  assert.ok(senders.includes('bot'));
  assert.ok(senders.includes('visitor'));
  // The collected email is on the run, where a later step or an integration can
  // read it, not buried in the message text.
  assert.equal((run.state as { collected: { email: string } }).collected.email, 'buyer@example.com');
});

test('a flow whose entry does not match leaves the conversation alone', async () => {
  const session = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: session.session_token },
  });
  const { conversation_id } = created.json();

  const run = await unscopedPrisma.bot_flow_runs.findFirst({ where: { conversation_id } });
  assert.equal(run, null, 'no starter, no flow');
  const messages = await unscopedPrisma.messages.count({ where: { conversation_id } });
  assert.equal(messages, 0);
});

test('a trigger can start a flow, and the widget is never told which one', async () => {
  const trigger = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/triggers`,
    headers: agent(),
    payload: {
      name: 'Exit intent triage',
      identifier: 'exit-triage',
      actions: { start_bot: flowId },
      events: { on_leave_intent: true },
    },
  });
  assert.equal(trigger.statusCode, 201, trigger.body);
  const triggerId = trigger.json().item.id;

  // Boot is anonymous, so it gets a boolean, not the flow id.
  const boot = await app.inject({ method: 'GET', url: `/api/v1/widget/boot?key=${publicKey}` });
  const served = boot.json().triggers.find((t: { id: string }) => t.id === triggerId);
  assert.equal(served.actions.starts_bot, true);
  assert.equal(served.actions.start_bot, undefined);
  assert.ok(!boot.body.includes(flowId), 'the boot payload must not name the flow');

  const session = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: session.session_token, metadata: { trigger_id: triggerId } },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { conversation_id } = created.json();

  // The trigger overrides entry matching, so the flow runs without the starter.
  const run = await unscopedPrisma.bot_flow_runs.findFirstOrThrow({ where: { conversation_id } });
  assert.equal(run.flow_id, flowId);
  // …on the version published most recently, which by now is 2.
  assert.equal(run.flow_version, 2);

  // The counter the campaign report reads is still maintained.
  const stored = await unscopedPrisma.triggers.findUniqueOrThrow({ where: { id: triggerId } });
  assert.equal(stored.conversation_count, 1);

  // And the analytics endpoint the widget already used still works, unauthenticated.
  const fired = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/triggers/${triggerId}/fire`,
  });
  assert.equal(fired.statusCode, 200);
});

test('a version whose graph no longer validates is refused rather than executed', async () => {
  // Written straight into a version row, which is the shape of "published before
  // this validation rule existed" or "edited outside the application". The runtime
  // must not run it, and must not break the chat either.
  const flow = await unscopedPrisma.bot_flows.create({
    data: {
      workspace_id: workspaceId,
      website_id: websiteId,
      name: 'Runaway',
      is_active: true,
      entry: { starter: 'runaway' },
      draft_graph: {},
      published_version: 1,
    },
  });
  await unscopedPrisma.bot_flow_versions.create({
    data: {
      flow_id: flow.id,
      version: 1,
      graph: {
        entry: 'a',
        nodes: [
          { id: 'a', type: 'message', text: 'round and round', next: 'b' },
          { id: 'b', type: 'message', text: 'and round', next: 'a' },
        ],
      },
    },
  });

  const session = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/conversations',
    payload: { session_token: session.session_token, starter_key: 'runaway' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { conversation_id } = created.json();

  const run = await unscopedPrisma.bot_flow_runs.findFirst({ where: { conversation_id } });
  assert.equal(run, null, 'an unexecutable version must not start a run');
  const posted = await unscopedPrisma.messages.count({ where: { conversation_id } });
  assert.equal(posted, 0, 'and must not post anything');
});
