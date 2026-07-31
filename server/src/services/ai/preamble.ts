import { renderPreamble, type RenderedPreamble } from './actions.js';

/**
 * Our instructions to the assistant — the part that used to be uneditable.
 *
 * A customer writes the website's `system_prompt`: who the business is, what it sells,
 * how it likes to sound. What they never got to write is the layer underneath — that this
 * is first-line support in a chat window, and when to stop trying and fetch a person. That
 * layer was three constants in prompt.ts, so "hand off sooner for this customer" was a
 * code change and a deploy.
 *
 * Now it is a value, resolved in three tiers:
 *
 *   1. `DEFAULT_PREAMBLE` below — in code, so an improvement to the wording reaches every
 *      install and every website that has not overridden it. This is the same reasoning as
 *      the visitor-facing copy defaults: store only what somebody deliberately changed.
 *   2. The install's own, from ops → Settings → AI. One wording for every customer on
 *      this install — the natural home for "this install answers in Turkish".
 *   3. One website's, from ops → the customer → Websites. The escape hatch for the
 *      customer whose assistant needs to behave differently, set by us, for them.
 *
 * Blank counts as absent at every tier, which is what makes "clear this field" the same
 * gesture as "use the tier above" rather than "send the model nothing".
 *
 * ── Why the customer cannot edit this ──────────────────────────────────────────
 *
 * It carries the action protocol, and the actions have consequences on our side of the
 * line: `{{tag}}` writes to the labels their reports group by, `{{resolve}}` closes threads.
 * A customer already has two prompt fields that cannot break anything. This one is set by
 * the person who will get the support ticket if it goes wrong.
 */
export const DEFAULT_PREAMBLE = `You are the first-line support assistant for this business, replying inside a live chat window on its website. Keep replies short — this is a chat, not an email.

Hand off to a person ({{handoff}}) when you cannot fully help: a request outside the knowledge base below, a complaint, or the visitor asking for a human. Do not guess to avoid it — a wrong answer costs more than a short wait.

Reply in English, concisely.`;

export type PreambleSource = 'website' | 'install' | 'default';

export interface ResolvedPreamble extends RenderedPreamble {
  /** Which tier the text came from. The panel shows this; nothing else branches on it. */
  source: PreambleSource;
  /** The authored text, placeholders intact — what an editor should be seeded with. */
  template: string;
}

/**
 * The preamble for one website: its own, else the install's, else ours.
 *
 * Takes both stored values as arguments rather than reading the install's from the
 * settings snapshot itself. Two reasons, and the second is the one that matters: it keeps
 * this function pure — so the tier logic can be tested without a database or a snapshot —
 * and it avoids an import cycle, because the settings module wants `DEFAULT_PREAMBLE` from
 * here to show the panel what the fallback is. This codebase has already been bitten once
 * by a load-order bug of exactly that shape (see the `str` note in platform/settings.ts).
 *
 * `renderPreamble` is deliberately inside this function rather than at the call site, so
 * there is no path that reads a stored template and forgets to expand its placeholders —
 * which would send the model literal `{{handoff}}` and quietly never hand off.
 */
export function resolvePreamble(
  websiteValue?: string | null,
  installValue?: string | null,
): ResolvedPreamble {
  const website = blankToNull(websiteValue);
  const install = blankToNull(installValue);

  const source: PreambleSource = website ? 'website' : install ? 'install' : 'default';
  const template = website ?? install ?? DEFAULT_PREAMBLE;

  return { source, template, ...renderPreamble(template) };
}

function blankToNull(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
