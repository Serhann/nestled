import { settings } from '../platform/settings.js';

/**
 * DeepL adapter.
 *
 * Two details in here are the whole reason this file exists rather than a fetch
 * call inline:
 *
 *   - **The key tells you which host to use.** A DeepL free key ends in `:fx` and
 *     only works against `api-free.deepl.com`; a paid key only works against
 *     `api.deepl.com`. Deriving it from the key means an operator pastes one field
 *     and cannot get this wrong, instead of a "base URL" setting nobody
 *     understands until translation silently 403s.
 *   - **Target codes are not language codes.** DeepL rejects a bare `EN` as a
 *     target and wants a variant, and `PT` and `ZH` have their own rules. A
 *     mapping that quietly sends the wrong thing produces a 400 per message.
 */

const TIMEOUT_MS = 10_000;

/**
 * Language code → DeepL target code.
 *
 * Only the entries that differ from "uppercase it" are listed. English and
 * Portuguese need a variant chosen for them, which is a real product decision
 * rather than a technical one: an agent reading English gets British spelling and
 * a Portuguese-speaking visitor gets European Portuguese unless the browser said
 * Brazil, which `languageCode` has already thrown away. Documented rather than
 * hidden, because somebody will want it configurable one day.
 */
const TARGET_OVERRIDES: Record<string, string> = {
  en: 'EN-GB',
  pt: 'PT-PT',
  zh: 'ZH-HANS',
  nb: 'NB',
  he: 'HE',
};

export function deeplTarget(code: string): string {
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return '';
  return TARGET_OVERRIDES[base] ?? base.toUpperCase();
}

/** `:fx` suffix marks a free key, which is served from a different host. */
export function deeplBaseUrl(key: string): string {
  return key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

/**
 * Translate one string. `null` on any failure, matching the LLM adapter — the
 * route turns that into a reason the agent can read.
 */
export async function translateWithDeepl(text: string, toCode: string): Promise<string | null> {
  const key = settings().translate.deeplApiKey;
  const target = deeplTarget(toCode);
  if (!key || !target) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${deeplBaseUrl(key)}/v2/translate`, {
      method: 'POST',
      headers: {
        authorization: `DeepL-Auth-Key ${key.trim()}`,
        'content-type': 'application/json',
      },
      // `text` is an array in v2 even for one string. No `source_lang`: DeepL's own
      // detection is better than the browser locale hint we would otherwise pass,
      // and getting the source wrong is worse than not stating it.
      body: JSON.stringify({ text: [text], target_lang: target }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 456 is DeepL's "quota exceeded", which is worth naming in the log because
      // it is the one failure an operator can act on.
      // eslint-disable-next-line no-console
      console.error(
        `[translate] deepl ${res.status}${res.status === 456 ? ' — character quota exhausted' : ''}`,
      );
      return null;
    }
    const body = (await res.json()) as { translations?: { text?: string }[] };
    const out = body.translations?.[0]?.text;
    return typeof out === 'string' && out.length > 0 ? out : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[translate] deepl request failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
