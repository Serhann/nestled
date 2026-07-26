import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './types.js';
import { keywordAnswer } from './knowledge.js';
// Prompt assembly (website prompt → KB → verified facts → customer rules →
// style/grounding/handoff) lives in prompt.ts so the <<HANDOFF>> contract stays
// last and independent of the domain guardrails. See that file.
import { systemWithContext } from './prompt.js';

const MAX_TOKENS = 1024; // support replies are short; keep latency/cost low
const TIMEOUT_MS = 20_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  if (signal) return signal;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return ctrl.signal;
}

/** No-LLM fallback: answer straight from the knowledge base by keyword score. */
export const knowledgeBaseProvider: AIProvider = {
  async generateReply(input) {
    return { text: keywordAnswer(input.message, input.knowledge) };
  },
};

/**
 * Anthropic Claude — the default. Per the API guidance for Claude 4.6+ models:
 * do not send temperature/top_p (rejected), keep max_tokens small for chat,
 * leave thinking off for fast support replies. Throws on API error/timeout.
 */
export const anthropicProvider: AIProvider = {
  async generateReply(input) {
    const apiKey = input.settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { text: keywordAnswer(input.message, input.knowledge) };

    const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
    const res = await client.messages.create({
      model: input.settings.ai_model || 'claude-opus-4-8',
      max_tokens: MAX_TOKENS,
      system: systemWithContext(input),
      messages: [{ role: 'user', content: input.message }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return {
      text,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  },
};

/** OpenAI adapter, kept behind the same interface. */
export const openaiProvider: AIProvider = {
  async generateReply(input) {
    const apiKey = input.settings.openai_api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) return { text: keywordAnswer(input.message, input.knowledge) };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: input.settings.openai_model || 'gpt-4o-mini',
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemWithContext(input) },
          { role: 'user', content: input.message },
        ],
      }),
      signal: withTimeout(),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content?.trim() ?? '',
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    };
  },
};

/** Self-hosted Ollama adapter. */
export const ollamaProvider: AIProvider = {
  async generateReply(input) {
    const url = input.settings.ollama_url || process.env.OLLAMA_URL;
    if (!url) return { text: keywordAnswer(input.message, input.knowledge) };

    const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.settings.ollama_model || 'llama2',
        prompt: `${systemWithContext(input)}\n\nUser: ${input.message}\n\nAnswer:`,
        stream: false,
      }),
      signal: withTimeout(),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      text: data.response?.trim() ?? '',
      usage: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 },
    };
  },
};
