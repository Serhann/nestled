import { z } from 'zod';

/**
 * The bot flow graph.
 *
 * One shape, declared once, used by the validator, the runtime and the CRUD
 * routes. The zod schema below is the single definition and the TypeScript types
 * are inferred from it — two hand-maintained descriptions of the same JSONB is how
 * a validator ends up accepting a graph the engine cannot execute.
 *
 * A node's outgoing edges are always named `next` / `then` / `otherwise` /
 * `options[].next`, and `null` means "stop here". Keeping the vocabulary that small
 * is what lets validate.ts walk an arbitrary graph without a per-type edge table.
 */

export const BOT_NODE_TYPES = [
  'message',
  'choices',
  'collect',
  'condition',
  'ai_answer',
  'handoff',
  'route',
  'tag',
  'wait',
  'end',
] as const;
export type BotNodeType = (typeof BOT_NODE_TYPES)[number];

const nodeId = z.string().min(1).max(64);
const edge = nodeId.nullable().optional();

/**
 * A condition's left-hand side is either something the flow COLLECTED, an
 * HMAC-verified conversation attribute, or the business-hours state.
 *
 * `metadata` is deliberately not addressable: it holds unverified client hints, and
 * a flow that branched on it would be branching on something the visitor's browser
 * can set. See the column comment on conversations.custom_attributes.
 */
export const botConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('state'),
    key: z.string().min(1).max(64),
    op: z.enum(['eq', 'neq', 'contains', 'exists', 'not_exists']),
    value: z.union([z.string().max(500), z.number(), z.boolean()]).nullable().optional(),
  }),
  z.object({
    kind: z.literal('attribute'),
    key: z.string().min(1).max(64),
    op: z.enum(['eq', 'neq', 'contains', 'exists', 'not_exists']),
    value: z.union([z.string().max(500), z.number(), z.boolean()]).nullable().optional(),
  }),
  z.object({ kind: z.literal('hours'), open: z.boolean() }),
]);
export type BotCondition = z.infer<typeof botConditionSchema>;

const base = { id: nodeId };

export const botNodeSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message'), text: z.string().min(1).max(4000), next: edge }),
  z.object({
    ...base,
    type: z.literal('choices'),
    text: z.string().min(1).max(4000),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(120),
          /** What lands in state; falls back to the label. */
          value: z.string().max(120).optional(),
          next: edge,
        }),
      )
      .max(10),
    /** State key the chosen option is stored under. */
    save_as: z.string().min(1).max(64).nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('collect'),
    field: z.string().min(1).max(64),
    prompt: z.string().min(1).max(4000),
    expect: z.enum(['text', 'email', 'phone', 'number']).default('text'),
    next: edge,
  }),
  z.object({
    ...base,
    type: z.literal('condition'),
    when: botConditionSchema,
    then: edge,
    otherwise: edge,
  }),
  z.object({
    ...base,
    type: z.literal('ai_answer'),
    /** Overrides "answer the visitor's last message" when the step is a fixed question. */
    prompt: z.string().max(2000).nullable().optional(),
    next: edge,
  }),
  z.object({ ...base, type: z.literal('handoff'), message: z.string().max(2000).nullable().optional(), next: edge }),
  z.object({ ...base, type: z.literal('route'), message: z.string().max(2000).nullable().optional(), next: edge }),
  z.object({ ...base, type: z.literal('tag'), tags: z.array(z.string().min(1).max(40)).min(1).max(20), next: edge }),
  z.object({ ...base, type: z.literal('wait'), next: edge }),
  z.object({ ...base, type: z.literal('end'), message: z.string().max(2000).nullable().optional() }),
]);
export type BotNode = z.infer<typeof botNodeSchema>;

/**
 * The graph as stored. `nodes` is a LIST, not a map keyed by id: a builder that
 * reorders or renames a node should produce a diff a human can read, and a map
 * makes "the entry moved" indistinguishable from "the entry was replaced".
 */
export const botGraphSchema = z.object({
  entry: nodeId,
  nodes: z.array(z.unknown()).max(200),
});

export interface BotGraph {
  entry: string;
  nodes: BotNode[];
}

/** How a flow is chosen for a new conversation. Every field is optional; see engine.ts. */
export const botEntrySchema = z.object({
  /** Matched against the page the conversation started on. `*` wildcards allowed. */
  page: z.string().max(500).nullable().optional(),
  /** A `starters.key`. The flow runs when the visitor picks that starter. */
  starter: z.string().max(40).nullable().optional(),
  /** Only outside business hours. Pairs with website_business_hours.offline_behavior. */
  out_of_hours: z.boolean().optional(),
});
export type BotEntry = z.infer<typeof botEntrySchema>;

/** What a bot message tells the widget to render. Carried in metadata['bot:step']. */
export interface BotStepHint {
  run_id: string | null;
  node_id: string;
  kind: 'message' | 'choices' | 'collect' | 'ai_answer' | 'handoff' | 'end';
  options?: { label: string; value: string }[];
  field?: { name: string; expect: 'text' | 'email' | 'phone' | 'number' };
}
