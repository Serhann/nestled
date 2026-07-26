import type { AIReplyInput } from './types.js';
import { buildContext, topRelevant } from './knowledge.js';

/**
 * System-prompt assembly, split into three independent concerns.
 *
 * These used to be one `PROTOCOL` blob that mixed a food-delivery guardrail
 * ("never guess order statuses, delivery times…") with the machine contract the
 * rest of the pipeline parses. Splitting them means the domain rules can be
 * generalized — or a customer's own rules added — without ever putting the
 * handoff contract at risk.
 */

/**
 * The machine contract. `<<HANDOFF>>` is a literal parsed downstream
 * (services/ai/index.ts detects it and strips it from the visible reply), so this
 * token must never be reworded, translated or reformatted.
 */
export const HANDOFF_CONTRACT = `- When you cannot fully help — a request outside the knowledge base above, a complaint, or the visitor asking for a person — do NOT guess. Write one short sentence telling the visitor you're connecting them to a team member, then end your reply with the token <<HANDOFF>> on its own line.`;

/**
 * Anti-hallucination rules. Generalized from the original order-specific wording:
 * the failure mode is inventing *any* account state, not orders specifically.
 */
export const GROUNDING_RULES = `- Answer only from the knowledge base entries and the verified visitor facts above. Never invent or guess account state, order status, prices, dates, availability, refunds, cancellations or policies. If a fact is not stated above, say you'll check with the team rather than describing it.`;

/** Tone and scope. */
export const STYLE_RULES = `- Only answer questions about this business and its products or services (see the instructions above for who you work for). Reply in English, concisely.`;

/**
 * Assemble the full system prompt.
 *
 * Order matters: the website's own prompt and the customer's extra rules come
 * FIRST, and the fixed contract comes LAST, so customer-supplied text can never
 * override or talk the model out of the handoff protocol.
 */
export function systemWithContext(input: AIReplyInput): string {
  const relevant = topRelevant(input.message, input.knowledge, 5);
  const knowledge = buildContext(relevant);

  const parts = [
    input.settings.system_prompt,
    knowledge ? `Relevant knowledge base entries:\n${knowledge}` : '',
    input.visitorContext ?? '',
    input.extraRules ?? '',
    ['Rules:', STYLE_RULES, GROUNDING_RULES, HANDOFF_CONTRACT].join('\n'),
  ].filter((p) => p && p.trim().length > 0);

  return parts.join('\n\n');
}
