import { query, queryOne } from '../../db/pool.js';
import type { AIProvider, AISettings, KnowledgeItem } from './types.js';
import {
  anthropicProvider,
  knowledgeBaseProvider,
  ollamaProvider,
  openaiProvider,
} from './providers.js';

const providers: Record<AISettings['ai_provider'], AIProvider> = {
  knowledge_base: knowledgeBaseProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
};

const HANDOFF = '<<HANDOFF>>';

export interface AIReplyResult {
  reply: string;
  needsHuman: boolean;
}

async function loadSettings(): Promise<AISettings | null> {
  return queryOne<AISettings>(
    `SELECT ai_provider, ai_model, system_prompt, anthropic_api_key,
            openai_api_key, openai_model, ollama_url, ollama_model
       FROM private_settings WHERE id = 1`,
  );
}

async function loadKnowledge(): Promise<KnowledgeItem[]> {
  const res = await query<KnowledgeItem>(
    `SELECT question, answer, category, keywords, priority
       FROM knowledge_base WHERE is_active = true`,
  );
  return res.rows;
}

/**
 * Generate an AI reply for a visitor message. Returns the cleaned reply text
 * plus whether the model requested a human handoff. Logs token usage. On a
 * provider error/timeout it returns null (the caller posts nothing — the
 * visitor never sees a raw error). The knowledge_base provider never errors.
 */
export async function generateAIReply(
  message: string,
  conversationId: string,
): Promise<AIReplyResult | null> {
  const settings = await loadSettings();
  if (!settings) return null;

  const knowledge = await loadKnowledge();
  const provider = providers[settings.ai_provider] ?? knowledgeBaseProvider;

  let result;
  try {
    result = await provider.generateReply({ message, settings, knowledge });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ai] provider error — posting nothing', err);
    return null;
  }

  if (result.usage) {
    void query(
      `INSERT INTO ai_usage (conversation_id, provider, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, settings.ai_provider, settings.ai_model, result.usage.input, result.usage.output],
    ).catch(() => undefined);
  }

  const needsHuman = result.text.includes(HANDOFF);
  let reply = result.text.split(HANDOFF).join('').trim();
  if (needsHuman && !reply) {
    reply = "Let me connect you with a team member who can help with that.";
  }
  if (!reply) return null; // empty model output → post nothing
  return { reply, needsHuman };
}
