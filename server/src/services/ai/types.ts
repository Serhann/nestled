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

export interface AIReplyInput {
  message: string;
  settings: AISettings;
  knowledge: KnowledgeItem[];
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
