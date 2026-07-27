import { settings } from '../platform/settings.js';
import { translateWithLlm } from '../ai/index.js';
import { translateWithDeepl } from './deepl.js';

/**
 * Translation, one call, whichever engine the install is pointed at.
 *
 * The seam exists because the two engines fail and cost differently and the
 * calling code should not care. A dedicated MT service is the better default —
 * faster, and with no instruction channel a visitor's message could hijack — but
 * an install with an LLM key and no DeepL account should still be able to
 * translate, so `llm` stays a first-class option rather than a fallback nobody
 * tested.
 *
 * The contract, held by both adapters:
 *
 *   - The target is a **language code** (`en`, `tr`), never a display name. DeepL
 *     needs a code; the LLM prompt needs a name. Converting in one place means the
 *     wire format cannot drift with whatever `Intl.DisplayNames` decides to call a
 *     language this year.
 *   - `null` on failure, never the input text. An agent handed back their own
 *     untranslated words with no signal cannot tell that from a translation of
 *     something already in their language, and would send the wrong thing.
 */

/** Which engine will actually run, for logs and the ops health view. */
export function translationEngine(): 'llm' | 'deepl' {
  return settings().translate.provider;
}

export async function translateText(text: string, toCode: string): Promise<string | null> {
  const trimmed = text.trim();
  const code = toCode.trim().toLowerCase();
  if (!trimmed || !code) return null;

  if (translationEngine() === 'deepl') {
    const out = await translateWithDeepl(trimmed, code);
    // Deliberately NOT falling through to the LLM. An operator who chose DeepL did
    // so for reasons — cost, data processing, injection surface — and quietly
    // sending the same text to an LLM instead would undo that choice at the moment
    // they are least likely to notice.
    return out;
  }
  return translateWithLlm(trimmed, code);
}
