import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, type EngineIO, type RunState } from '../services/bot/engine.js';
import type { BotGraph } from '../services/bot/types.js';

/**
 * The interpreter itself, with no database.
 *
 * `runTurn` takes everything it can DO as an interface, which is what lets the
 * simulator reuse the runtime — and, here, what lets the branching rules be tested
 * without a workspace, a conversation or a clock.
 */

interface Recorder extends EngineIO {
  said: string[];
  actions: string[];
}

function recorder(opts: { open?: boolean; attributes?: Record<string, unknown> } = {}): Recorder {
  const said: string[] = [];
  const actions: string[] = [];
  return {
    said,
    actions,
    async say(text) {
      said.push(text);
    },
    async aiAnswer(question) {
      return { text: `answered: ${question}`, handoff: false };
    },
    async tag(tags) {
      actions.push(`tag:${tags.join(',')}`);
    },
    async handoff(reason) {
      actions.push(`handoff:${reason}`);
    },
    async route() {
      actions.push('route');
    },
    async withinHours() {
      return opts.open ?? true;
    },
    async attributes() {
      return opts.attributes ?? {};
    },
    async lastVisitorMessage() {
      return 'where is my order?';
    },
  };
}

const fresh = (): RunState => ({ collected: {}, awaiting: null, steps: 0 });

test('the step budget stops a runaway graph instead of spinning', async () => {
  // Unpublishable by validate.ts and unexecutable via parseGraph — this is the
  // third line of defence, for a graph that reached the interpreter anyway.
  const graph: BotGraph = {
    entry: 'a',
    nodes: [
      { id: 'a', type: 'message', text: 'round', next: 'b' },
      { id: 'b', type: 'message', text: 'and round', next: 'a' },
    ],
  };
  const io = recorder();
  const result = await runTurn(graph, fresh(), io, { startNodeId: null, input: null, runId: null });

  assert.equal(result.status, 'abandoned');
  assert.ok(io.said.length > 0, 'it should have run');
  assert.ok(io.said.length <= 250, `bounded, got ${io.said.length}`);
});

test('a condition reads collected state and business hours, never metadata', async () => {
  const graph: BotGraph = {
    entry: 'check',
    nodes: [
      {
        id: 'check',
        type: 'condition',
        when: { kind: 'attribute', key: 'plan', op: 'eq', value: 'enterprise' },
        then: 'vip',
        otherwise: 'standard',
      },
      { id: 'vip', type: 'end', message: 'Straight through to your account team.' },
      { id: 'standard', type: 'end', message: 'Someone will be with you shortly.' },
    ],
  };

  // The attribute source is the HMAC-VERIFIED bag. A flow that branched on the
  // unverified `metadata` would be branching on something the browser can set.
  const vip = recorder({ attributes: { plan: 'enterprise' } });
  await runTurn(graph, fresh(), vip, { startNodeId: null, input: null, runId: null });
  assert.deepEqual(vip.said, ['Straight through to your account team.']);

  const other = recorder({ attributes: { plan: 'free' } });
  await runTurn(graph, fresh(), other, { startNodeId: null, input: null, runId: null });
  assert.deepEqual(other.said, ['Someone will be with you shortly.']);
});

test('out of hours takes the closed branch', async () => {
  const graph: BotGraph = {
    entry: 'open',
    nodes: [
      { id: 'open', type: 'condition', when: { kind: 'hours', open: true }, then: 'live', otherwise: 'later' },
      { id: 'live', type: 'end', message: "We're here now." },
      { id: 'later', type: 'end', message: "We're closed — leave a note." },
    ],
  };
  const closed = recorder({ open: false });
  await runTurn(graph, fresh(), closed, { startNodeId: null, input: null, runId: null });
  assert.deepEqual(closed.said, ["We're closed — leave a note."]);
});

test('an ai_answer the assistant cannot produce becomes a handoff, not silence', async () => {
  const graph: BotGraph = {
    entry: 'ask',
    nodes: [
      { id: 'ask', type: 'ai_answer', prompt: 'anything', next: 'bye' },
      { id: 'bye', type: 'end' },
    ],
  };
  const io = recorder();
  io.aiAnswer = async () => null; // no quota / no provider / nothing to say
  const result = await runTurn(graph, fresh(), io, { startNodeId: null, input: null, runId: null });

  assert.deepEqual(io.said, []);
  assert.deepEqual(io.actions, ['handoff:The assistant could not answer']);
  assert.equal(result.status, 'handoff');
});

test('a wait blocks the turn and resumes on the next message', async () => {
  const graph: BotGraph = {
    entry: 'ping',
    nodes: [
      { id: 'ping', type: 'message', text: 'Still there?', next: 'hold' },
      { id: 'hold', type: 'wait', next: 'bye' },
      { id: 'bye', type: 'end', message: 'Good to hear.' },
    ],
  };
  const io = recorder();
  const first = await runTurn(graph, fresh(), io, { startNodeId: null, input: null, runId: null });
  assert.equal(first.status, 'running');
  assert.deepEqual(first.state.awaiting, { node_id: 'hold', kind: 'wait' });
  assert.deepEqual(io.said, ['Still there?']);

  // An agent writing while the flow waits must not advance it — only the visitor can.
  const nudged = await runTurn(graph, first.state, io, {
    startNodeId: first.currentNodeId,
    input: null,
    runId: null,
  });
  assert.equal(nudged.status, 'running');
  assert.deepEqual(io.said, ['Still there?']);

  const second = await runTurn(graph, first.state, io, {
    startNodeId: first.currentNodeId,
    input: 'yes',
    runId: null,
  });
  assert.equal(second.status, 'completed');
  assert.deepEqual(io.said, ['Still there?', 'Good to hear.']);
});

test('a tag node writes tags and carries on', async () => {
  const graph: BotGraph = {
    entry: 'mark',
    nodes: [
      { id: 'mark', type: 'tag', tags: ['billing', 'urgent'], next: 'bye' },
      { id: 'bye', type: 'end' },
    ],
  };
  const io = recorder();
  const result = await runTurn(graph, fresh(), io, { startNodeId: null, input: null, runId: null });
  assert.deepEqual(io.actions, ['tag:billing,urgent']);
  assert.equal(result.status, 'completed');
});
