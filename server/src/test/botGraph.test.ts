import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from '../services/bot/validate.js';

/**
 * Graph validation, as pure unit tests.
 *
 * There is no database here and no server, which is the whole reason validate.ts
 * is a pure function: every rejection reason is one literal graph and one
 * assertion, so the file that decides whether a customer can publish is the
 * cheapest thing in the suite to keep honest.
 */

const codes = (graph: unknown): string[] => validateGraph(graph).map((i) => i.code);

test('a well-formed flow has no issues', () => {
  const graph = {
    entry: 'greet',
    nodes: [
      { id: 'greet', type: 'message', text: 'Hello', next: 'ask' },
      {
        id: 'ask',
        type: 'choices',
        text: 'What do you need?',
        save_as: 'topic',
        options: [
          { label: 'Orders', next: 'bye' },
          { label: 'Returns', next: 'bye' },
        ],
      },
      { id: 'bye', type: 'end', message: 'Thanks!' },
    ],
  };
  assert.deepEqual(validateGraph(graph), []);
});

test('a missing entry node is rejected', () => {
  const graph = {
    entry: 'does-not-exist',
    nodes: [{ id: 'greet', type: 'message', text: 'Hello', next: null }],
  };
  assert.ok(codes(graph).includes('entry_missing'));

  // …and so is a graph that never names one at all.
  assert.ok(codes({ nodes: [] }).includes('entry_missing'));
});

test('an unknown node type is rejected', () => {
  const graph = {
    entry: 'greet',
    nodes: [
      { id: 'greet', type: 'message', text: 'Hello', next: 'karaoke' },
      { id: 'karaoke', type: 'sing', song: 'Africa' },
    ],
  };
  const issues = validateGraph(graph);
  const unknown = issues.find((i) => i.code === 'unknown_node_type');
  assert.ok(unknown, 'the unknown type must be named');
  assert.equal(unknown.node_id, 'karaoke');
});

test('a dangling edge is rejected, and the broken handle is named', () => {
  const graph = {
    entry: 'greet',
    nodes: [{ id: 'greet', type: 'message', text: 'Hello', next: 'ghost' }],
  };
  const issue = validateGraph(graph).find((i) => i.code === 'dangling_edge');
  assert.ok(issue);
  assert.equal(issue.node_id, 'greet');
  // Which handle broke, not just which node — a ten-option menu with one bad
  // branch is otherwise a hunt.
  assert.equal(issue.handle, 'next');
});

test('a dangling handle inside a choices option is rejected', () => {
  const graph = {
    entry: 'ask',
    nodes: [
      {
        id: 'ask',
        type: 'choices',
        text: 'Which?',
        options: [
          { label: 'A', next: 'bye' },
          { label: 'B', next: 'nowhere' },
        ],
      },
      { id: 'bye', type: 'end' },
    ],
  };
  const issue = validateGraph(graph).find((i) => i.code === 'dangling_edge');
  assert.ok(issue);
  assert.equal(issue.handle, 'options[1].next');
});

test('a choices node with no options is rejected', () => {
  const graph = {
    entry: 'ask',
    nodes: [{ id: 'ask', type: 'choices', text: 'Pick one', options: [] }],
  };
  assert.ok(codes(graph).includes('choices_empty'));
});

test('an unreachable node is rejected', () => {
  const graph = {
    entry: 'greet',
    nodes: [
      { id: 'greet', type: 'message', text: 'Hello', next: null },
      { id: 'orphan', type: 'message', text: 'Nobody gets here', next: null },
    ],
  };
  const issue = validateGraph(graph).find((i) => i.code === 'unreachable_node');
  assert.ok(issue);
  assert.equal(issue.node_id, 'orphan');
});

test('a cycle with no wait is rejected', () => {
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', type: 'message', text: 'ping', next: 'b' },
      { id: 'b', type: 'message', text: 'pong', next: 'a' },
    ],
  };
  const looping = validateGraph(graph).filter((i) => i.code === 'infinite_loop');
  assert.equal(looping.length, 2, 'both nodes in the cycle should be flagged');
});

test('a cycle broken by a wait is allowed', () => {
  // The legitimate shape this rule has to leave alone: poll the visitor, pause,
  // ask again. Without the wait the same graph would spin the server.
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', type: 'message', text: 'Still there?', next: 'pause' },
      { id: 'pause', type: 'wait', next: 'a' },
    ],
  };
  assert.deepEqual(validateGraph(graph), []);
});

test('a self-loop with no wait is rejected', () => {
  const graph = {
    entry: 'a',
    nodes: [{ id: 'a', type: 'message', text: 'again', next: 'a' }],
  };
  assert.ok(codes(graph).includes('infinite_loop'));
});

test('two nodes sharing an id are rejected', () => {
  const graph = {
    entry: 'a',
    nodes: [
      { id: 'a', type: 'message', text: 'one', next: null },
      { id: 'a', type: 'message', text: 'two', next: null },
    ],
  };
  assert.ok(codes(graph).includes('duplicate_node_id'));
});

test('a graph that is not a graph is rejected without throwing', () => {
  assert.ok(codes(null).includes('graph_malformed'));
  assert.ok(codes('a flow').includes('graph_malformed'));
  assert.ok(codes({ entry: 'a', nodes: 'not an array' }).includes('graph_malformed'));
});

test('every problem is reported at once, not one per round trip', () => {
  const graph = {
    entry: 'greet',
    nodes: [
      { id: 'greet', type: 'message', text: 'Hello', next: 'ghost' },
      { id: 'ask', type: 'choices', text: 'Pick', options: [] },
      { id: 'mystery', type: 'interpretive-dance' },
    ],
  };
  const found = new Set(codes(graph));
  // Fixing a flow one error at a time is how a twelve-node graph becomes an
  // afternoon, so this is a behaviour worth pinning rather than an implementation
  // detail.
  assert.ok(found.has('dangling_edge'));
  assert.ok(found.has('choices_empty'));
  assert.ok(found.has('unknown_node_type'));
});
