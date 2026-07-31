import type { AIReplyInput } from './types.js';
import { buildContext, topRelevant } from './knowledge.js';
import { HANDOFF_ONLY, actionContract, type EnabledActions } from './actions.js';

/**
 * System-prompt assembly.
 *
 * The prompt has two ends, and which end a sentence belongs at is the whole design:
 *
 *   **The front is policy, and it is editable.** Who the assistant is, how long its
 *   replies run, and — the reason this exists — WHEN it should reach for an action. That
 *   is the preamble (`preamble.ts`), our text, resolved per install and per website from
 *   the ops panel. Then the customer's own prompt, their knowledge base, the verified
 *   facts about this visitor, and their house rules.
 *
 *   **The tail is safety and syntax, and it is not editable.** Stay on topic; do not
 *   invent account state; here is exactly how to spell an action. Nothing above it can
 *   remove it, because it is appended after every authored string in the prompt — so
 *   neither a customer's "ignore all previous instructions" nor an operator's rewritten
 *   preamble can talk the model out of the protocol.
 *
 * This used to be one `PROTOCOL` blob mixing a food-delivery guardrail with the machine
 * contract. Splitting it once let the domain rules be generalized; splitting it again,
 * along the editable/fixed line, is what let the handoff POLICY move out of code without
 * putting the handoff CONTRACT at risk.
 */

/**
 * Scope. Fixed rather than editable: an assistant that will answer anything is a
 * general-purpose LLM on a customer's website with our logo on it, and the failure is
 * theirs to explain and ours to have allowed.
 */
export const SCOPE_RULES = `- Only answer questions about this business and its products or services (see the instructions above for who you work for).`;

/**
 * Anti-hallucination rules. Generalized from the original order-specific wording:
 * the failure mode is inventing *any* account state, not orders specifically.
 */
export const GROUNDING_RULES = `- Answer only from the knowledge base entries and the verified visitor facts above. Never invent or guess account state, order status, prices, dates, availability, refunds, cancellations or policies. If a fact is not stated above, say you'll check with the team rather than describing it.`;

/**
 * Assemble the full system prompt.
 *
 * `input.preamble` is already rendered — placeholders expanded, actions collected — by
 * `resolvePreamble`. Providers only ever see the finished string, which keeps the three
 * adapters in providers.ts from each needing to know about tiers or tokens.
 *
 * Absent `actions` means handoff only: the default for any caller that has not thought
 * about actions, and the behaviour every install had before they existed.
 */
export function systemWithContext(input: AIReplyInput): string {
  const relevant = topRelevant(input.message, input.knowledge, 5);
  const knowledge = buildContext(relevant);

  return assemble({
    preamble: input.preamble,
    systemPrompt: input.settings.system_prompt,
    knowledge: knowledge ? `Relevant knowledge base entries:\n${knowledge}` : '',
    visitorContext: input.visitorContext,
    extraRules: input.extraRules,
    actions: input.actions,
  });
}

/**
 * The prompt an operator is about to change, without a conversation to build it from.
 *
 * Goes through the same `assemble` as a live reply, with the two per-conversation blocks
 * replaced by a line saying what lands there. A preview that reproduced the ORDER
 * independently would eventually be a lie, and a lie in a preview is worse than no
 * preview: it is the screen somebody checks before deciding their edit is fine.
 */
export function previewSystemPrompt(input: {
  preamble: string;
  systemPrompt: string;
  extraRules?: string | null;
  actions: EnabledActions;
}): string {
  return assemble({
    preamble: input.preamble,
    systemPrompt: input.systemPrompt,
    knowledge: '[The knowledge base entries matching the visitor’s message are inserted here.]',
    visitorContext: '[The facts the website signed about this visitor are inserted here.]',
    extraRules: input.extraRules ?? undefined,
    actions: input.actions,
  });
}

/**
 * The one place the order lives.
 *
 * Front to back: ours (editable) → the customer's (editable) → their knowledge and this
 * visitor's verified facts → their house rules (editable) → ours (fixed). Everything a
 * human wrote is above the last two entries, which is what makes those two hold.
 */
function assemble(parts: {
  preamble?: string;
  systemPrompt: string;
  knowledge: string;
  visitorContext?: string;
  extraRules?: string;
  actions?: EnabledActions;
}): string {
  return [
    parts.preamble ?? '',
    parts.systemPrompt,
    parts.knowledge,
    parts.visitorContext ?? '',
    parts.extraRules ?? '',
    ['Rules:', SCOPE_RULES, GROUNDING_RULES].join('\n'),
    actionContract(parts.actions ?? HANDOFF_ONLY),
  ]
    .filter((p) => p && p.trim().length > 0)
    .join('\n\n');
}
