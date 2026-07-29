// The bot runtime is driven by the widget plane (a visitor message) and by the
// simulator (an authenticated builder), and in both cases the workspace is already
// resolved. Every query names it explicitly.
// eslint-disable-next-line no-restricted-imports -- runtime acts for a caller-supplied workspace
import { unscopedPrisma } from '../../db/unscoped.js';
import { insertMessage } from '../../lib/messages.js';
import { isWithinBusinessHours } from '../../lib/businessHours.js';
import { incrementUsage, usageState } from '../../lib/limits.js';
import { publishToWorkspace } from '../../realtime/hub.js';
import { generateAIReply } from '../ai/index.js';
import { routeConversation } from '../routing.js';
import { parseGraph } from './validate.js';
import type { BotCondition, BotGraph, BotNode, BotStepHint } from './types.js';
import { botEntrySchema } from './types.js';

/**
 * The bot runtime.
 *
 * EXECUTION IS SERVER-SIDE. That is the load-bearing decision in this phase, and
 * it is worth being explicit about why, because shipping the graph to the widget
 * and interpreting it there is the cheaper build:
 *
 *   - Consistency. One interpreter, versioned with the server. A flow does not
 *     behave differently because a visitor's tab has yesterday's bundle cached.
 *   - Auditability. Every step the bot took is a row in `messages`, in the same
 *     transcript the agent reads. Nothing happened "in the browser" that we cannot
 *     reconstruct after a customer complains.
 *   - Reach. The flow can consult the knowledge base, business hours, verified
 *     attributes and assignment state — none of which the widget may see.
 *   - Channels. The day an email address or a Slack channel becomes an inbox, the
 *     flows work unchanged, because nothing about them assumed a browser.
 *
 * The widget's only job is to RENDER what a bot message says it is: the
 * `bot:step` hint in the message metadata tells it "these are buttons" or "this is
 * a form field". It never decides what comes next.
 */

/**
 * Step budgets — the backstop behind validate.ts.
 *
 * Validation already rejects a loop with no `wait`, and parseGraph refuses to
 * execute a version that fails validation, so in practice neither of these fires.
 * They exist for the graph that got past both: a version published before a
 * validation rule existed, or a row edited outside the application. A bot that
 * spins is worse than one that stops, because it spins while a customer watches.
 *
 * The per-turn number is deliberately ABOVE the 200-node ceiling a graph may have,
 * so it can never truncate a long but legitimate straight-line flow.
 */
const MAX_STEPS_PER_TURN = 250;
/** Across every turn — bounds a `wait` loop that the visitor keeps feeding. */
const MAX_STEPS_PER_RUN = 1000;

export type RunStatus = 'running' | 'completed' | 'handoff' | 'abandoned';

export interface RunState {
  /** Everything `collect` and `choices` have gathered, by field name. */
  collected: Record<string, string>;
  /** Set while the flow is blocked on the visitor. */
  awaiting: { node_id: string; kind: 'choices' | 'collect' | 'wait' } | null;
  steps: number;
}

const emptyState = (): RunState => ({ collected: {}, awaiting: null, steps: 0 });

function readState(raw: unknown): RunState {
  const value = (raw ?? {}) as Partial<RunState>;
  return {
    collected:
      value.collected && typeof value.collected === 'object' ? { ...value.collected } : {},
    awaiting: value.awaiting ?? null,
    steps: typeof value.steps === 'number' ? value.steps : 0,
  };
}

/**
 * Everything the interpreter can DO, behind an interface.
 *
 * This is what lets `POST /bots/:id/simulate` run the real engine against a
 * throwaway in-memory run: the live implementation writes messages and assigns
 * agents, the simulator appends to an array, and the code that decides what
 * happens next is the same code in both. A second simulator would drift from the
 * runtime within a release, and the drift would show up as "it worked in Test".
 */
export interface EngineIO {
  say(text: string, hint: BotStepHint): Promise<void>;
  /** null = the AI could not answer (no quota, no provider, empty output). */
  aiAnswer(question: string): Promise<string | null>;
  tag(tags: string[]): Promise<void>;
  handoff(reason: string): Promise<void>;
  route(): Promise<void>;
  withinHours(): Promise<boolean>;
  /** HMAC-verified attributes only. */
  attributes(): Promise<Record<string, unknown>>;
  lastVisitorMessage(): Promise<string | null>;
}

export interface TurnResult {
  state: RunState;
  status: RunStatus;
  currentNodeId: string | null;
}

// ── Condition evaluation ─────────────────────────────────────────────────────

function compare(left: unknown, op: string, right: unknown): boolean {
  const l = left === null || left === undefined ? '' : String(left);
  const r = right === null || right === undefined ? '' : String(right);
  switch (op) {
    case 'exists':
      return l !== '';
    case 'not_exists':
      return l === '';
    case 'eq':
      return l.toLowerCase() === r.toLowerCase();
    case 'neq':
      return l.toLowerCase() !== r.toLowerCase();
    case 'contains':
      return l.toLowerCase().includes(r.toLowerCase());
    default:
      return false;
  }
}

async function evaluate(when: BotCondition, state: RunState, io: EngineIO): Promise<boolean> {
  if (when.kind === 'hours') return (await io.withinHours()) === when.open;
  const source =
    when.kind === 'state' ? state.collected : await io.attributes();
  return compare(source[when.key], when.op, when.value);
}

// ── Input handling ───────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d][\d\s()./-]{5,}$/;

function accepts(value: string, expect: 'text' | 'email' | 'phone' | 'number'): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (expect === 'email') return EMAIL.test(v);
  if (expect === 'phone') return PHONE.test(v);
  if (expect === 'number') return !Number.isNaN(Number(v));
  return true;
}

function hintFor(node: BotNode, runId: string | null): BotStepHint {
  switch (node.type) {
    case 'choices':
      return {
        run_id: runId,
        node_id: node.id,
        kind: 'choices',
        options: node.options.map((o) => ({ label: o.label, value: o.value ?? o.label })),
      };
    case 'collect':
      return {
        run_id: runId,
        node_id: node.id,
        kind: 'collect',
        field: { name: node.field, expect: node.expect },
      };
    case 'end':
      return { run_id: runId, node_id: node.id, kind: 'end' };
    case 'handoff':
      return { run_id: runId, node_id: node.id, kind: 'handoff' };
    case 'ai_answer':
      return { run_id: runId, node_id: node.id, kind: 'ai_answer' };
    default:
      return { run_id: runId, node_id: node.id, kind: 'message' };
  }
}

/**
 * Run the flow forward until it blocks, ends, or runs out of budget.
 *
 * `input` is the visitor's message when there is one. A turn that begins blocked
 * and receives no input is a no-op — that is the case where an agent, not a
 * visitor, wrote the last message.
 */
export async function runTurn(
  graph: BotGraph,
  previous: RunState,
  io: EngineIO,
  opts: { startNodeId: string | null; input: string | null; runId: string | null },
): Promise<TurnResult> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const state: RunState = { ...previous, collected: { ...previous.collected } };
  let cursor: string | null = opts.startNodeId ?? graph.entry;
  let handedOff = false;
  let budget = MAX_STEPS_PER_TURN;

  if (state.awaiting) {
    if (opts.input === null) {
      return { state, status: 'running', currentNodeId: cursor };
    }
    const blocked = byId.get(state.awaiting.node_id);
    const answer = opts.input.trim();
    if (!blocked) {
      // The stored cursor names a node this version does not have. Only reachable
      // if a run outlived its own graph; stop rather than guess.
      return { state, status: 'abandoned', currentNodeId: null };
    }
    state.awaiting = null;
    if (blocked.type === 'choices') {
      const chosen = blocked.options.find(
        (o) =>
          o.label.toLowerCase() === answer.toLowerCase() ||
          (o.value ?? '').toLowerCase() === answer.toLowerCase(),
      );
      if (!chosen) {
        // Free text where buttons were expected. Re-ask rather than fall through:
        // guessing the visitor's intent here is how a bot books the wrong thing.
        await io.say(blocked.text, hintFor(blocked, opts.runId));
        state.awaiting = { node_id: blocked.id, kind: 'choices' };
        state.steps += 1;
        return { state, status: 'running', currentNodeId: blocked.id };
      }
      if (blocked.save_as) state.collected[blocked.save_as] = chosen.value ?? chosen.label;
      cursor = chosen.next ?? null;
    } else if (blocked.type === 'collect') {
      if (!accepts(answer, blocked.expect)) {
        await io.say(blocked.prompt, hintFor(blocked, opts.runId));
        state.awaiting = { node_id: blocked.id, kind: 'collect' };
        state.steps += 1;
        return { state, status: 'running', currentNodeId: blocked.id };
      }
      state.collected[blocked.field] = answer;
      cursor = blocked.next ?? null;
    } else if (blocked.type === 'wait') {
      cursor = blocked.next ?? null;
    } else {
      // The cursor names a node that cannot block. Only reachable if the stored
      // state was written by a different version of this file; stop rather than
      // re-execute a node whose side effects have already happened.
      return { state, status: 'abandoned', currentNodeId: null };
    }
  }

  while (cursor !== null) {
    if (budget <= 0 || state.steps >= MAX_STEPS_PER_RUN) {
      // The per-run budget is the backstop for a graph that got past validation —
      // an unpublished draft executed by the simulator, or a version published
      // before a validation rule existed. A bot that spins is worse than one that
      // stops, because it spins while a customer is watching.
      return { state, status: 'abandoned', currentNodeId: cursor };
    }
    const node: BotNode | undefined = byId.get(cursor);
    if (!node) return { state, status: 'abandoned', currentNodeId: null };
    budget -= 1;
    state.steps += 1;

    switch (node.type) {
      case 'message':
        await io.say(node.text, hintFor(node, opts.runId));
        cursor = node.next ?? null;
        break;

      case 'choices':
        await io.say(node.text, hintFor(node, opts.runId));
        state.awaiting = { node_id: node.id, kind: 'choices' };
        return { state, status: 'running', currentNodeId: node.id };

      case 'collect':
        await io.say(node.prompt, hintFor(node, opts.runId));
        state.awaiting = { node_id: node.id, kind: 'collect' };
        return { state, status: 'running', currentNodeId: node.id };

      case 'condition': {
        const yes = await evaluate(node.when, state, io);
        cursor = (yes ? node.then : node.otherwise) ?? null;
        break;
      }

      case 'ai_answer': {
        const question = node.prompt ?? (await io.lastVisitorMessage()) ?? '';
        const answer = question ? await io.aiAnswer(question) : null;
        if (answer === null) {
          // No quota, no provider, or nothing worth saying. Silence would leave the
          // visitor mid-sentence, so this becomes a handoff.
          await io.handoff('The assistant could not answer');
          handedOff = true;
          cursor = null;
          break;
        }
        await io.say(answer, hintFor(node, opts.runId));
        cursor = node.next ?? null;
        break;
      }

      case 'handoff':
        if (node.message) await io.say(node.message, hintFor(node, opts.runId));
        await io.handoff('Bot flow handed off');
        handedOff = true;
        cursor = node.next ?? null;
        break;

      case 'route':
        if (node.message) await io.say(node.message, hintFor(node, opts.runId));
        await io.route();
        cursor = node.next ?? null;
        break;

      case 'tag':
        await io.tag(node.tags);
        cursor = node.next ?? null;
        break;

      case 'wait':
        state.awaiting = { node_id: node.id, kind: 'wait' };
        return { state, status: 'running', currentNodeId: node.id };

      case 'end':
        if (node.message) await io.say(node.message, hintFor(node, opts.runId));
        cursor = null;
        break;
    }
  }

  return { state, status: handedOff ? 'handoff' : 'completed', currentNodeId: null };
}

// ── The live implementation ──────────────────────────────────────────────────

interface LiveTarget {
  workspaceId: string;
  websiteId: string;
  conversationId: string;
  runId: string | null;
}

function liveIO(target: LiveTarget): EngineIO {
  return {
    async say(text, hint) {
      // The NORMAL message path, with sender_type 'bot'. There is deliberately no
      // second delivery mechanism: the agent inbox, Web Push, Discord and the
      // visitor's socket all already work off this one call, and a bot transcript
      // that lived somewhere else would be invisible to every one of them.
      await insertMessage({
        workspaceId: target.workspaceId,
        websiteId: target.websiteId,
        conversationId: target.conversationId,
        content: text,
        senderType: 'bot',
        metadata: { 'bot:step': hint },
      });
    },

    async aiAnswer(question) {
      const workspace = await unscopedPrisma.workspaces.findUnique({
        where: { id: target.workspaceId },
        select: { plan: { select: { max_ai_replies_month: true } } },
      });
      if (workspace) {
        // HARD limit — each call costs real money on the margin. See lib/limits.ts.
        const state = await usageState(
          target.workspaceId,
          'ai_replies',
          workspace.plan.max_ai_replies_month,
        );
        if (state.state === 'hard') return null;
      }
      const result = await generateAIReply(
        target.workspaceId,
        target.websiteId,
        question,
        target.conversationId,
      );
      if (!result) return null;
      // Metered here rather than in insertMessage: the bot posts as 'bot', not 'ai',
      // so the transcript reads as one voice — but the call still cost us one reply.
      await incrementUsage(target.workspaceId, 'ai_replies', 1);
      return result.reply;
    },

    async tag(tags) {
      const conv = await unscopedPrisma.conversations.findFirst({
        where: { id: target.conversationId, workspace_id: target.workspaceId },
        select: { tags: true },
      });
      if (!conv) return;
      const merged = [...new Set([...conv.tags, ...tags.map((t) => t.trim().toLowerCase())])];
      await unscopedPrisma.conversations.updateMany({
        where: { id: target.conversationId, workspace_id: target.workspaceId },
        data: { tags: merged },
      });
    },

    async handoff(reason) {
      const existing = await unscopedPrisma.conversations.findFirst({
        where: { id: target.conversationId, workspace_id: target.workspaceId },
        select: { metadata: true },
      });
      const prev = (existing?.metadata as Record<string, unknown> | null) ?? {};
      const updated = await unscopedPrisma.conversations.update({
        where: { id: target.conversationId },
        data: {
          needs_human: true,
          status: 'open',
          metadata: {
            ...prev,
            handoff: { by: 'bot', reason, at: new Date().toISOString() },
          } as object,
        },
        select: { id: true, needs_human: true, status: true },
      });
      publishToWorkspace(
        target.workspaceId,
        { type: 'conversation:updated', conversation: updated },
        { websiteId: target.websiteId },
      );
      await this.route();
    },

    async route() {
      const conv = await unscopedPrisma.conversations.findFirst({
        where: { id: target.conversationId, workspace_id: target.workspaceId },
        select: { custom_attributes: true, metadata: true },
      });
      const metadata = (conv?.metadata ?? {}) as { current_page?: unknown; location?: { country_code?: unknown } };
      await routeConversation({
        workspaceId: target.workspaceId,
        websiteId: target.websiteId,
        conversationId: target.conversationId,
        page: typeof metadata.current_page === 'string' ? metadata.current_page : null,
        countryCode:
          typeof metadata.location?.country_code === 'string' ? metadata.location.country_code : null,
        attributes: (conv?.custom_attributes as Record<string, unknown> | null) ?? {},
      });
    },

    async withinHours() {
      const hours = await unscopedPrisma.website_business_hours.findUnique({
        where: { website_id: target.websiteId },
        select: { enabled: true, timezone: true, rules: true, holidays: true },
      });
      return isWithinBusinessHours(hours);
    },

    async attributes() {
      const conv = await unscopedPrisma.conversations.findFirst({
        where: { id: target.conversationId, workspace_id: target.workspaceId },
        select: { custom_attributes: true },
      });
      return (conv?.custom_attributes as Record<string, unknown> | null) ?? {};
    },

    async lastVisitorMessage() {
      const row = await unscopedPrisma.messages.findFirst({
        where: {
          workspace_id: target.workspaceId,
          conversation_id: target.conversationId,
          sender_type: 'visitor',
        },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      });
      return row?.content ?? null;
    },
  };
}

// ── Entry matching ───────────────────────────────────────────────────────────

/** Glob match with `*`, anchored — same spelling as the routing page patterns. */
function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? ' ' : `\\${ch}`));
  return new RegExp(`^${escaped.split(' ').join('.*')}$`, 'i').test(value);
}

export interface FlowEntryContext {
  workspaceId: string;
  websiteId: string;
  page?: string | null;
  starterKey?: string | null;
  /** Set by a trigger's `start_bot` action; overrides entry matching entirely. */
  flowId?: string | null;
}

interface ResolvedFlow {
  flowId: string;
  version: number;
  graph: BotGraph;
}

/**
 * Which published flow, if any, should greet this conversation.
 *
 * A flow with an EMPTY entry never starts on its own. That is deliberate: the
 * alternative — "no conditions means always" — turns the moment a customer clicks
 * Publish into every visitor on their site meeting a half-built bot.
 */
async function resolveFlow(ctx: FlowEntryContext): Promise<ResolvedFlow | null> {
  const flows = await unscopedPrisma.bot_flows.findMany({
    where: {
      workspace_id: ctx.workspaceId,
      is_active: true,
      published_version: { not: null },
      ...(ctx.flowId
        ? { id: ctx.flowId }
        : { OR: [{ website_id: ctx.websiteId }, { website_id: null }] }),
    },
    orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
    select: { id: true, website_id: true, entry: true, published_version: true },
  });
  if (flows.length === 0) return null;

  let chosen: { id: string; published_version: number } | null = null;
  if (ctx.flowId) {
    const only = flows[0];
    // A trigger may only start a flow scoped to this website (or to the whole
    // workspace) — otherwise a trigger is a way around the website scope.
    if (only && (only.website_id === null || only.website_id === ctx.websiteId)) {
      chosen = { id: only.id, published_version: only.published_version! };
    }
  } else {
    let closed: boolean | null = null;
    for (const flow of flows) {
      const parsed = botEntrySchema.safeParse(flow.entry ?? {});
      if (!parsed.success) continue;
      const entry = parsed.data;
      if (!entry.page && !entry.starter && !entry.out_of_hours) continue;

      if (entry.starter && entry.starter !== ctx.starterKey) continue;
      if (entry.page && !matchesPattern(ctx.page ?? '', entry.page)) continue;
      if (entry.out_of_hours) {
        if (closed === null) {
          const hours = await unscopedPrisma.website_business_hours.findUnique({
            where: { website_id: ctx.websiteId },
            select: { enabled: true, timezone: true, rules: true, holidays: true },
          });
          closed = !isWithinBusinessHours(hours);
        }
        if (!closed) continue;
      }
      chosen = { id: flow.id, published_version: flow.published_version! };
      break;
    }
  }
  if (!chosen) return null;

  // The PUBLISHED version, not the draft. A conversation executes the graph it
  // started on for its whole life — see the publish route.
  const version = await unscopedPrisma.bot_flow_versions.findUnique({
    where: { flow_id_version: { flow_id: chosen.id, version: chosen.published_version } },
    select: { version: true, graph: true },
  });
  if (!version) return null;
  const graph = parseGraph(version.graph);
  if (!graph) return null;
  return { flowId: chosen.id, version: version.version, graph };
}

/** Bots are plan-gated, and a downgrade must stop new runs rather than only new flows. */
async function botAllowed(workspaceId: string): Promise<boolean> {
  const workspace = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { plan: { select: { allow_bot: true } } },
  });
  return Boolean(workspace?.plan.allow_bot);
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Start a flow on a new conversation, if one matches. Returns the run id.
 *
 * Never throws: a broken flow must not stop a visitor from opening a chat.
 */
export async function startBotRun(
  ctx: FlowEntryContext & { conversationId: string },
): Promise<string | null> {
  try {
    if (!(await botAllowed(ctx.workspaceId))) return null;
    const resolved = await resolveFlow(ctx);
    if (!resolved) return null;

    const run = await unscopedPrisma.bot_flow_runs.create({
      data: {
        workspace_id: ctx.workspaceId,
        conversation_id: ctx.conversationId,
        flow_id: resolved.flowId,
        // Pinned. Publishing a new version later must not change what this
        // conversation is in the middle of doing.
        flow_version: resolved.version,
        current_node_id: resolved.graph.entry,
        state: emptyState() as object,
      },
      select: { id: true },
    });

    const io = liveIO({
      workspaceId: ctx.workspaceId,
      websiteId: ctx.websiteId,
      conversationId: ctx.conversationId,
      runId: run.id,
    });
    const result = await runTurn(resolved.graph, emptyState(), io, {
      startNodeId: resolved.graph.entry,
      input: null,
      runId: run.id,
    });
    await persist(run.id, result);
    return run.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bot] failed to start a flow', err);
    return null;
  }
}

/**
 * Feed a visitor message to the conversation's running flow.
 *
 * Returns true when a flow consumed the message, which is the signal the widget
 * route uses to keep the plain AI auto-reply out of the way.
 */
export async function advanceBotRun(params: {
  workspaceId: string;
  websiteId: string;
  conversationId: string;
  input: string;
}): Promise<boolean> {
  try {
    const run = await unscopedPrisma.bot_flow_runs.findFirst({
      where: {
        workspace_id: params.workspaceId,
        conversation_id: params.conversationId,
        status: 'running',
      },
      orderBy: { started_at: 'desc' },
      select: { id: true, flow_id: true, flow_version: true, current_node_id: true, state: true },
    });
    if (!run) return false;

    const version = await unscopedPrisma.bot_flow_versions.findUnique({
      where: { flow_id_version: { flow_id: run.flow_id, version: run.flow_version } },
      select: { graph: true },
    });
    const graph = version ? parseGraph(version.graph) : null;
    if (!graph) {
      await unscopedPrisma.bot_flow_runs.update({
        where: { id: run.id },
        data: { status: 'abandoned' },
      });
      return false;
    }

    const io = liveIO({
      workspaceId: params.workspaceId,
      websiteId: params.websiteId,
      conversationId: params.conversationId,
      runId: run.id,
    });
    const result = await runTurn(graph, readState(run.state), io, {
      startNodeId: run.current_node_id,
      input: params.input,
      runId: run.id,
    });
    await persist(run.id, result);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bot] failed to advance a flow', err);
    return false;
  }
}

/** Is a flow currently driving this conversation? Read by the AI auto-reply path. */
export async function hasActiveBotRun(
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const run = await unscopedPrisma.bot_flow_runs.findFirst({
    where: { workspace_id: workspaceId, conversation_id: conversationId, status: 'running' },
    select: { id: true },
  });
  return run !== null;
}

async function persist(runId: string, result: TurnResult): Promise<void> {
  await unscopedPrisma.bot_flow_runs.update({
    where: { id: runId },
    data: {
      current_node_id: result.currentNodeId,
      state: result.state as object,
      status: result.status,
    },
  });
}

// ── Simulation ───────────────────────────────────────────────────────────────

export interface SimulatedStep {
  kind: 'message' | 'choices' | 'collect' | 'ai_answer' | 'handoff' | 'route' | 'tag' | 'end';
  node_id: string;
  text?: string;
  options?: { label: string; value: string }[];
  field?: { name: string; expect: string };
  tags?: string[];
}

export interface SimulationResult {
  steps: SimulatedStep[];
  status: RunStatus;
  collected: Record<string, string>;
  awaiting: RunState['awaiting'];
}

/**
 * Run a graph against a throwaway in-memory run and report what the visitor would
 * see. Nothing is written and no conversation is touched.
 *
 * One deliberate divergence from the live runtime: `ai_answer` is NOT sent to a
 * provider. A Test button that spends the customer's AI quota — and real money —
 * every time someone clicks it is a button people learn not to press, and the
 * thing being tested here is the SHAPE of the flow, not the model's prose.
 */
export async function simulateGraph(params: {
  graph: BotGraph;
  inputs?: string[];
  withinHours?: boolean;
  attributes?: Record<string, unknown>;
}): Promise<SimulationResult> {
  const steps: SimulatedStep[] = [];
  const io: EngineIO = {
    async say(text, hint) {
      steps.push({
        kind: hint.kind,
        node_id: hint.node_id,
        text,
        ...(hint.options ? { options: hint.options } : {}),
        ...(hint.field ? { field: hint.field } : {}),
      });
    },
    async aiAnswer(question) {
      return `[ai_answer] ${question}`;
    },
    async tag(tags) {
      steps.push({ kind: 'tag', node_id: '', tags });
    },
    async handoff() {
      steps.push({ kind: 'handoff', node_id: '' });
    },
    async route() {
      steps.push({ kind: 'route', node_id: '' });
    },
    async withinHours() {
      return params.withinHours ?? true;
    },
    async attributes() {
      return params.attributes ?? {};
    },
    async lastVisitorMessage() {
      return params.inputs?.[params.inputs.length - 1] ?? null;
    },
  };

  let state = emptyState();
  let cursor: string | null = params.graph.entry;
  let status: RunStatus = 'running';

  // The opening turn plus one per scripted visitor reply, so the builder sees the
  // whole conversation rather than only its first screen.
  for (const input of [null, ...(params.inputs ?? [])]) {
    if (status !== 'running') break;
    const result = await runTurn(params.graph, state, io, {
      startNodeId: cursor,
      input,
      runId: null,
    });
    state = result.state;
    cursor = result.currentNodeId;
    status = result.status;
  }

  return { steps, status, collected: state.collected, awaiting: state.awaiting };
}
