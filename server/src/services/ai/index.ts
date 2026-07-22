import { prisma } from '../../db/prisma.js';
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
  const row = await prisma.private_settings.findUnique({
    where: { id: 1 },
    select: {
      ai_provider: true,
      ai_model: true,
      system_prompt: true,
      anthropic_api_key: true,
      openai_api_key: true,
      openai_model: true,
      ollama_url: true,
      ollama_model: true,
    },
  });
  return (row as AISettings | null) ?? null;
}

async function loadKnowledge(mode?: string): Promise<KnowledgeItem[]> {
  // Site scoping: an entry with an empty `sites` applies everywhere; otherwise
  // only when it lists the conversation's site/mode.
  const where = mode
    ? { is_active: true, OR: [{ sites: { isEmpty: true } }, { sites: { has: mode } }] }
    : { is_active: true };
  return prisma.knowledge_base.findMany({
    where,
    select: { question: true, answer: true, category: true, keywords: true, priority: true },
  });
}

/** The site/scenario ('food' | 'saas') a conversation belongs to, from metadata. */
async function conversationMode(conversationId: string): Promise<string | undefined> {
  const conv = await prisma.conversations.findUnique({
    where: { id: conversationId },
    select: { metadata: true },
  });
  const m = (conv?.metadata as Record<string, unknown> | null)?.widget_mode;
  return typeof m === 'string' ? m : undefined;
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

  const mode = await conversationMode(conversationId);
  // Per-site system prompt override (Site manager) — falls back to the global one.
  if (mode) {
    const site = await prisma.sites.findUnique({
      where: { key: mode },
      select: { is_active: true, system_prompt: true },
    });
    if (site?.is_active && site.system_prompt && site.system_prompt.trim()) {
      settings.system_prompt = site.system_prompt;
    }
  }

  const knowledge = await loadKnowledge(mode);
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
    void prisma.ai_usage
      .create({
        data: {
          conversation_id: conversationId,
          provider: settings.ai_provider,
          model: settings.ai_model,
          input_tokens: result.usage.input,
          output_tokens: result.usage.output,
        },
      })
      .catch(() => undefined);
  }

  const needsHuman = result.text.includes(HANDOFF);
  let reply = result.text.split(HANDOFF).join('').trim();
  if (needsHuman && !reply) {
    reply = "Let me connect you with a team member who can help with that.";
  }
  if (!reply) return null; // empty model output → post nothing
  return { reply, needsHuman };
}
