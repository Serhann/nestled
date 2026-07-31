import { del, get, post, put } from '../http';

/**
 * Triggers, routing rules and bot flows.
 *
 * Bot flows execute on the SERVER. The builder here edits a graph and publishes a
 * version; it never interprets one. That is what keeps a flow auditable, able to
 * consult the knowledge base and assignment state, and unchanged if an email or
 * Slack channel is added later.
 */

const w = (workspaceId: string, path: string): string => `/api/v1/w/${workspaceId}${path}`;

// ── Triggers (campaigns) ────────────────────────────────────────────────────

/**
 * The four JSONB columns, spelled out.
 *
 * These were `Record<string, unknown>` for all four, and that is precisely how the
 * campaigns screen came to send `{ type: 'message', message }` where the server's strict
 * schema wanted `{ show_message, message_content }` — four blobs of mismatched field
 * names that no type ever checked, so the screen could never save anything and the
 * compiler had nothing to say about it. The server rejects unknown keys; the client now
 * names the same keys, so a rename on either side is a build failure rather than a 400
 * somebody finds in the network tab.
 *
 * `src/types/chat.ts` declares a narrower version of the same columns for the widget —
 * only the members the trigger engine reads. This is the full wire shape, matching
 * `triggerBody` in server/src/routes/v1/automation.ts.
 */
export interface TriggerActions {
  show_message?: boolean;
  message_content?: string | null;
  localized_messages?: Record<string, string>;
  open_chatbox?: boolean;
  play_sound?: boolean;
  /** Start a bot flow instead of a canned message. Resolved server-side from the id. */
  start_bot?: string | null;
}

export interface TriggerEvents {
  on_leave_intent?: boolean;
  on_click_link?: boolean;
  click_selectors?: string[];
  on_pages?: boolean;
  page_urls?: string[];
  on_url_parameters?: boolean;
  url_parameters?: Record<string, string>;
  after_delay?: boolean;
  delay_seconds?: number;
}

export interface TriggerBehaviors {
  show_as_website?: boolean;
  execute_if_online?: boolean;
  execute_on_first_visit?: boolean;
  execute_if_no_other_trigger?: boolean;
  /** Two-letter codes. The ENGINE fails closed on a non-empty list — see triggerEngine.ts. */
  country_restriction?: string[];
}

export interface TriggerPlatforms {
  desktop_enabled?: boolean;
  mobile_enabled?: boolean;
}

export interface Trigger {
  id: string;
  website_id: string | null;
  name: string;
  identifier: string;
  is_active: boolean;
  priority: number;
  fire_count: number;
  conversation_count: number;
  actions: TriggerActions;
  events: TriggerEvents;
  behaviors: TriggerBehaviors;
  platforms: TriggerPlatforms;
}

export const listTriggers = (id: string): Promise<{ items: Trigger[] }> => get(w(id, '/triggers'));
export const createTrigger = (id: string, input: Partial<Trigger>): Promise<{ item: Trigger }> =>
  post(w(id, '/triggers'), input);
export const updateTrigger = (
  id: string,
  triggerId: string,
  input: Partial<Trigger>,
): Promise<{ item: Trigger }> => put(w(id, `/triggers/${triggerId}`), input);
export const deleteTrigger = (id: string, triggerId: string): Promise<{ ok: true }> =>
  del(w(id, `/triggers/${triggerId}`));

// ── Routing ─────────────────────────────────────────────────────────────────
export interface RoutingRule {
  id: string;
  website_id: string | null;
  name: string;
  priority: number;
  is_active: boolean;
  conditions: Record<string, unknown>;
  strategy: 'round_robin' | 'least_active' | 'specific';
  member_pool: string[];
}

export const listRouting = (id: string): Promise<{ items: RoutingRule[] }> => get(w(id, '/routing'));
export const createRouting = (id: string, input: Partial<RoutingRule>): Promise<{ item: RoutingRule }> =>
  post(w(id, '/routing'), input);
export const updateRouting = (
  id: string,
  ruleId: string,
  input: Partial<RoutingRule>,
): Promise<{ item: RoutingRule }> => put(w(id, `/routing/${ruleId}`), input);
export const deleteRouting = (id: string, ruleId: string): Promise<{ ok: true }> =>
  del(w(id, `/routing/${ruleId}`));

// ── Bot flows ───────────────────────────────────────────────────────────────
export interface BotNode {
  id: string;
  type: 'message' | 'choices' | 'collect' | 'condition' | 'ai_answer' | 'handoff' | 'route' | 'tag' | 'wait' | 'end';
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface BotEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  label?: string;
}

export interface BotGraph {
  nodes: BotNode[];
  edges: BotEdge[];
  entry?: string;
}

export interface BotFlow {
  id: string;
  website_id: string | null;
  name: string;
  is_active: boolean;
  priority: number;
  entry: Record<string, unknown>;
  draft_graph: BotGraph;
  published_version: number | null;
  updated_at: string;
}

export interface GraphProblem {
  node_id?: string;
  message: string;
}

export const listBots = (id: string): Promise<{ items: BotFlow[] }> => get(w(id, '/bots'));
export const getBot = (id: string, flowId: string): Promise<{ item: BotFlow }> =>
  get(w(id, `/bots/${flowId}`));
export const createBot = (id: string, input: Partial<BotFlow>): Promise<{ item: BotFlow }> =>
  post(w(id, '/bots'), input);
export const updateBot = (
  id: string,
  flowId: string,
  input: Partial<BotFlow>,
): Promise<{ item: BotFlow }> => put(w(id, `/bots/${flowId}`), input);
export const deleteBot = (id: string, flowId: string): Promise<{ ok: true }> =>
  del(w(id, `/bots/${flowId}`));

export const publishBot = (
  id: string,
  flowId: string,
): Promise<{ version: number } | { problems: GraphProblem[] }> => post(w(id, `/bots/${flowId}/publish`));

export const botVersions = (
  id: string,
  flowId: string,
): Promise<{ versions: { version: number; published_at: string }[] }> =>
  get(w(id, `/bots/${flowId}/versions`));

export const rollbackBot = (id: string, flowId: string, version: number): Promise<{ ok: true }> =>
  post(w(id, `/bots/${flowId}/rollback`), { version });

export interface SimulatedStep {
  node_id: string;
  type: string;
  message?: string;
  choices?: { label: string; value: string }[];
  fields?: { name: string; label: string; required: boolean }[];
}

export const simulateBot = (
  id: string,
  flowId: string,
  input: { answers?: Record<string, unknown> } = {},
): Promise<{ steps: SimulatedStep[] }> => post(w(id, `/bots/${flowId}/simulate`), input);
