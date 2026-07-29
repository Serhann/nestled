import { BOT_NODE_TYPES, botNodeSchema, type BotGraph, type BotNode } from './types.js';

/**
 * Bot graph validation.
 *
 * A PURE function over the graph — no database, no request, no clock. That is what
 * makes every rejection reason a one-line unit test, and it is also why the
 * publish route can afford to run it on every save.
 *
 * It returns EVERY problem it finds rather than the first. Publishing is where a
 * customer discovers their flow is broken, and handing back one error at a time
 * turns fixing a twelve-node graph into a dozen round trips.
 */

export interface GraphIssue {
  /** Stable machine code, so the builder can highlight the right thing. */
  code:
    | 'graph_malformed'
    | 'entry_missing'
    | 'duplicate_node_id'
    | 'unknown_node_type'
    | 'node_malformed'
    | 'dangling_edge'
    | 'choices_empty'
    | 'unreachable_node'
    | 'infinite_loop';
  node_id?: string;
  /** The edge that is broken, e.g. `next`, `then`, `options[1].next`. */
  handle?: string;
  message: string;
}

/** Every outgoing edge of a node, with the handle name for a precise error. */
function edgesOf(node: BotNode): { handle: string; target: string }[] {
  const out: { handle: string; target: string }[] = [];
  const push = (handle: string, target: string | null | undefined): void => {
    if (typeof target === 'string') out.push({ handle, target });
  };
  switch (node.type) {
    case 'choices':
      node.options.forEach((opt, i) => push(`options[${i}].next`, opt.next));
      break;
    case 'condition':
      push('then', node.then);
      push('otherwise', node.otherwise);
      break;
    case 'end':
      break;
    default:
      push('next', node.next);
  }
  return out;
}

/**
 * Nodes whose outgoing edges cannot close a loop, because reaching them stops the
 * turn until the visitor writes again.
 *
 * ONLY `wait` counts, even though `choices` and `collect` also block. A flow author
 * should not have to know which node types happen to block in the current runtime;
 * "put a Wait in the loop" is a rule that stays true if the runtime changes.
 */
const LOOP_BRAKES = new Set<string>(['wait']);

/**
 * Find cycles that contain no brake.
 *
 * Cutting every brake node's outgoing edges first means an ordinary cycle in what
 * remains IS a cycle with no brake — no separate "does this cycle contain a wait?"
 * pass, which is the version that gets subtly wrong on overlapping cycles.
 */
function findRunawayCycles(nodes: BotNode[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, LOOP_BRAKES.has(node.type) ? [] : edgesOf(node).map((e) => e.target));
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const offending = new Set<string>();

  const visit = (start: string): void => {
    // Explicit stack: a customer graph is untrusted input, and recursion depth is
    // one more thing that should not be able to take the process down.
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    colour.set(start, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbours = adjacency.get(frame.id) ?? [];
      if (frame.next >= neighbours.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const target = neighbours[frame.next]!;
      frame.next += 1;
      const seen = colour.get(target) ?? WHITE;
      if (seen === GREY) {
        // Back edge: everything still on the stack from `target` onwards is in the cycle.
        const from = stack.findIndex((f) => f.id === target);
        for (const f of stack.slice(from === -1 ? 0 : from)) offending.add(f.id);
      } else if (seen === WHITE && adjacency.has(target)) {
        colour.set(target, GREY);
        stack.push({ id: target, next: 0 });
      }
    }
  };

  for (const node of nodes) {
    if ((colour.get(node.id) ?? WHITE) === WHITE) visit(node.id);
  }
  return [...offending];
}

/**
 * Validate a raw graph. An empty array means it is publishable.
 *
 * Takes `unknown` on purpose: this is called on JSONB straight out of the database
 * and on a body straight off the wire, and pretending either is already typed is
 * how a "cannot happen" crash reaches production.
 */
export function validateGraph(raw: unknown): GraphIssue[] {
  const issues: GraphIssue[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ code: 'graph_malformed', message: 'The flow must be an object with `entry` and `nodes`' }];
  }
  const graph = raw as { entry?: unknown; nodes?: unknown };
  if (!Array.isArray(graph.nodes)) {
    return [{ code: 'graph_malformed', message: '`nodes` must be an array' }];
  }
  if (graph.nodes.length > 200) {
    return [{ code: 'graph_malformed', message: 'A flow may not exceed 200 nodes' }];
  }

  const nodes: BotNode[] = [];
  const seenIds = new Set<string>();
  for (const [index, candidate] of graph.nodes.entries()) {
    const shape = candidate as { id?: unknown; type?: unknown } | null;
    const id = typeof shape?.id === 'string' ? shape.id : `#${index}`;
    const type = shape?.type;

    if (typeof type !== 'string' || !(BOT_NODE_TYPES as readonly string[]).includes(type)) {
      issues.push({
        code: 'unknown_node_type',
        node_id: id,
        message: `Unknown node type ${JSON.stringify(type)}`,
      });
      continue;
    }

    const parsed = botNodeSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'node_malformed',
          node_id: id,
          handle: issue.path.join('.') || undefined,
          message: issue.message,
        });
      }
      continue;
    }
    if (seenIds.has(parsed.data.id)) {
      issues.push({
        code: 'duplicate_node_id',
        node_id: parsed.data.id,
        message: `Two nodes share the id "${parsed.data.id}"`,
      });
      continue;
    }
    seenIds.add(parsed.data.id);
    nodes.push(parsed.data);
  }

  const entry = typeof graph.entry === 'string' ? graph.entry : null;
  if (!entry) {
    issues.push({ code: 'entry_missing', message: 'The flow has no entry node' });
  } else if (!seenIds.has(entry)) {
    issues.push({
      code: 'entry_missing',
      node_id: entry,
      message: `The entry node "${entry}" is not in the flow`,
    });
  }

  for (const node of nodes) {
    if (node.type === 'choices' && node.options.length === 0) {
      issues.push({
        code: 'choices_empty',
        node_id: node.id,
        message: 'A question with no answers leaves the visitor stuck',
      });
    }
    for (const { handle, target } of edgesOf(node)) {
      if (!seenIds.has(target)) {
        issues.push({
          code: 'dangling_edge',
          node_id: node.id,
          handle,
          message: `${handle} points at "${target}", which is not in the flow`,
        });
      }
    }
  }

  // Reachability and loops are only meaningful once the node set itself is sound;
  // reporting "unreachable" for every node of a graph whose entry is a typo would
  // bury the one issue that matters.
  if (issues.length === 0 && entry) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const reached = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
      const current = byId.get(queue.shift()!);
      if (!current) continue;
      for (const { target } of edgesOf(current)) {
        if (!reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    for (const node of nodes) {
      if (!reached.has(node.id)) {
        issues.push({
          code: 'unreachable_node',
          node_id: node.id,
          message: 'Nothing leads to this node, so it can never run',
        });
      }
    }

    for (const id of findRunawayCycles(nodes.filter((n) => reached.has(n.id)))) {
      issues.push({
        code: 'infinite_loop',
        node_id: id,
        message: 'This node is in a loop with no Wait step, so the flow would never stop',
      });
    }
  }

  return issues;
}

/**
 * Parse a graph the runtime is about to execute.
 *
 * Returns null rather than throwing when a stored version is unexecutable — a
 * published version was valid when it was written, so this only fires if the row
 * was edited outside the application, and a broken bot must not break the chat.
 */
export function parseGraph(raw: unknown): BotGraph | null {
  if (validateGraph(raw).length > 0) return null;
  const graph = raw as { entry: string; nodes: unknown[] };
  const nodes: BotNode[] = [];
  for (const candidate of graph.nodes) {
    const parsed = botNodeSchema.safeParse(candidate);
    if (parsed.success) nodes.push(parsed.data);
  }
  return { entry: graph.entry, nodes };
}
