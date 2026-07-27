/**
 * Turning a BCP 47 tag into something an agent can read.
 *
 * The widget already sends `navigator.language` with every conversation, so we
 * usually know the visitor's language without asking or spending an LLM call to
 * detect it. What we get is `tr-TR` or `pt-BR`, which is not what you want on a
 * button — `Intl.DisplayNames` turns those into "Turkish" and "Brazilian
 * Portuguese" in one line, with no dependency and no table for us to keep
 * up to date.
 */

/** The language an agent reads. English-only product, so this is the constant. */
export const AGENT_LANGUAGE = 'English';

/**
 * A human name for a language tag, or null when there is nothing usable.
 *
 * Null rather than the raw tag: the caller decides whether to show "Translate to
 * Turkish" or hide the control entirely, and a button reading "Translate to
 * tr-TR" is worse than no button.
 */
export function languageName(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  try {
    // The REGION IS DROPPED FIRST, and this is the important line.
    //
    // `DisplayNames.of('en-US')` is "American English" and `of('tr-TR')` is
    // "Turkish (Türkiye)". Both break something. The label reads badly, but far
    // worse: "American English" is not the string `AGENT_LANGUAGE`, so the caller's
    // "are they already reading my language?" check would say no for every visitor
    // in the United States, and offer a metered translation of English into
    // English. Narrowing to the base subtag makes en-US, en-GB and en all "English".
    const base = new Intl.Locale(trimmed).language;
    if (!base || base === 'und') return null;

    // 'en' is the display locale, not the target: an English-only panel should say
    // "Turkish", not "Türkçe", or the agent cannot read the label either.
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = names.of(base);
    // `of()` echoes its input back for a well-formed but unknown code ('xx' → 'xx'),
    // which would put a raw tag on a button by another route.
    return name && name.toLowerCase() !== base.toLowerCase() ? name : null;
  } catch {
    // `new Intl.Locale` throws RangeError on a structurally invalid tag — which is
    // what we want it to do, because `DisplayNames` would instead have silently
    // turned 'not-a-lang' into "not".
    return null;
  }
}

/**
 * The visitor's language, read off the metadata the widget sent.
 *
 * Unverified by design: it is `navigator.language` from the visitor's browser, so
 * it is a good guess and not a fact. It only ever picks a default for a control
 * the agent can override, which is the right amount of trust to place in it.
 */
export function visitorLanguage(metadata: Record<string, unknown> | null): string | null {
  return languageName(metadata?.language);
}
