import Anthropic from '@anthropic-ai/sdk';
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

/**
 * Low-level LLM completion (no KB, no JetFood/handoff PROTOCOL) for utility
 * tasks like summarising a handoff and live translation. Returns null when no
 * LLM is configured (knowledge_base provider / missing key) or on any error, so
 * callers degrade gracefully. Never throws.
 */
async function complete(system: string, user: string, maxTokens = 500): Promise<string | null> {
  const settings = await loadSettings();
  if (!settings) return null;
  const TIMEOUT = 20_000;
  try {
    if (settings.ai_provider === 'anthropic') {
      const apiKey = settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      const client = new Anthropic({ apiKey, timeout: TIMEOUT });
      const res = await client.messages.create({
        model: settings.ai_model || 'claude-opus-4-8',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      return (
        res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim() || null
      );
    }
    if (settings.ai_provider === 'openai') {
      const apiKey = settings.openai_api_key || process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: settings.openai_model || 'gpt-4o-mini',
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() || null;
    }
    if (settings.ai_provider === 'ollama') {
      const url = settings.ollama_url || process.env.OLLAMA_URL;
      if (!url) return null;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT);
      const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.ollama_model || 'llama2',
          prompt: `${system}\n\n${user}`,
          stream: false,
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      return data.response?.trim() || null;
    }
    return null; // knowledge_base — no LLM available
  } catch {
    return null;
  }
}

/**
 * Summarise a conversation for the agent picking it up at handoff: 1-2 sentences
 * on what the customer wants + key details. Falls back to the last visitor
 * message when no LLM is available.
 */
export async function summarizeConversation(conversationId: string): Promise<string | null> {
  const msgs = await prisma.messages.findMany({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'asc' },
    take: 40,
    select: { sender_type: true, content: true },
  });
  if (msgs.length === 0) return null;
  const transcript = msgs
    .map((m) => `${m.sender_type === 'visitor' ? 'Customer' : m.sender_type === 'agent' ? 'Agent' : 'Assistant'}: ${m.content}`)
    .join('\n');
  const system =
    'You brief a human support agent who is taking over a live chat. In 1-2 short sentences, summarise what the customer wants and any key details (order id, issue, what was already tried). Be concise and neutral. Output only the summary, no preamble.';
  const out = await complete(system, transcript, 200);
  if (out) return out;
  // Fallback: the most recent customer message.
  const lastVisitor = [...msgs].reverse().find((m) => m.sender_type === 'visitor');
  return lastVisitor ? lastVisitor.content.slice(0, 280) : null;
}

/**
 * Translate text into `to` (a language name or code). Returns the original text
 * when no LLM is configured or on error, so the chat never breaks.
 */
export async function translateText(text: string, to: string): Promise<string> {
  const t = text.trim();
  if (!t || !to.trim()) return text;
  const system =
    `You are a translation engine. Translate the user's message into ${to}. ` +
    'Preserve meaning, tone, emojis, names, order numbers, URLs and formatting. ' +
    'If it is already in the target language, return it unchanged. Output ONLY the translation — no notes, no quotes.';
  const out = await complete(system, t, 800);
  return out ?? text;
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
