import type { EnabledActions } from './actions.js';

export interface KnowledgeItem {
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  priority: number;
}

export interface AISettings {
  ai_provider: 'knowledge_base' | 'anthropic' | 'openai' | 'ollama';
  ai_model: string;
  system_prompt: string;
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  openai_model: string;
  ollama_url: string | null;
  ollama_model: string;
}

/** One side of the conversation, in the shape every provider's chat API expects. */
export interface AITurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIReplyInput {
  message: string;
  settings: AISettings;
  knowledge: KnowledgeItem[];
  /**
   * The whole conversation to send, oldest first, ALWAYS ending with the user turn that
   * carries `message`. Built once by `buildTurns` so the invariants every chat API needs
   * (starts with a user turn, roles alternate) hold for all three adapters.
   *
   * Absent means "no transcript available" — the adapters then send `message` alone, which
   * is what every reply used to do and the reason the assistant kept losing the thread.
   */
  turns?: AITurn[];
  /** OUR instructions, resolved per install/website and already rendered — the front of
   *  the prompt. See services/ai/preamble.ts. */
  preamble?: string;
  /** Which action tokens this reply may use. Absent = handoff only. */
  actions?: EnabledActions;
  /** Pre-rendered block of HMAC-verified facts about this visitor from the host
   *  site, or an explicit "no verified facts available" line. Trusted: the model
   *  may quote it; without it the model must not describe any account state. */
  visitorContext?: string;
  /** Customer-authored extra instructions. Injected BEFORE the fixed style,
   *  grounding and handoff rules so it can never override the contract. */
  extraRules?: string;
}

export interface AIUsage {
  input: number;
  output: number;
}

export interface AIResult {
  text: string;
  usage?: AIUsage;
}

/**
 * A provider adapter turns a visitor message + KB context into a reply.
 * LLM adapters THROW on an API error/timeout (the caller then posts nothing —
 * never a raw error to the visitor). A missing key/URL is not an error: the
 * adapter degrades gracefully to the keyword answer.
 */
export interface AIProvider {
  generateReply(input: AIReplyInput): Promise<AIResult>;
}
