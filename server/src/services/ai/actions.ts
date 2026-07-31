/**
 * The assistant's action vocabulary.
 *
 * An LLM answering a support chat can only do one thing on its own: write text. Every
 * other outcome — handing the conversation to a person, labelling it for the team,
 * closing it — has to be something it can ASK for in the text, and something we then
 * parse and execute. That request is what an "action" is here: a literal token the model
 * emits, stripped before the visitor ever sees it.
 *
 * There was already exactly one of these, `<<HANDOFF>>`, hard-coded in two places: the
 * sentence describing when to use it and the `includes()` that detected it. That worked,
 * and it was also the whole problem — the *when* was welded to the *how*. An operator who
 * wanted a customer's assistant to hand off sooner (or much later) had nowhere to say so,
 * because the sentence lived in a compiled constant.
 *
 * So this file owns the part that must never be edited — the token spelling and the
 * contract sentence teaching its syntax — and `preamble.ts` owns the part that should be:
 * when to reach for it. See prompt.ts for how the two ends of the prompt are assembled.
 *
 * ── Why enabling is by REFERENCE ───────────────────────────────────────────────
 *
 * An action other than handoff is contracted only if the effective preamble mentions its
 * placeholder. Not a checkbox column: a checkbox that says "the AI may close
 * conversations" without any accompanying instruction about when produces a model guessing
 * at a policy nobody wrote down. Writing `{{resolve}}` into a sentence forces the author
 * to say, in the same breath, what it is for.
 *
 * `handoff` is exempt. It is the safety valve — the thing that happens when the assistant
 * is out of its depth — and no amount of editing prose should be able to remove it.
 */

export const ACTION_NAMES = ['handoff', 'tag', 'resolve'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

/** Which actions this reply may use, and the allowed values for the ones that take them. */
export type EnabledActions = ReadonlyMap<ActionName, readonly string[]>;

/** Handoff only — what every reply gets when nothing has been configured. */
export const HANDOFF_ONLY: EnabledActions = new Map([['handoff', []]]);

/** Tags: lowercase, no punctuation beyond spaces, hyphens and underscores. */
const TAG_NAME = /^[a-z0-9][a-z0-9 _-]{0,23}$/;
/** How many labels one reply may apply. Three is a categorisation; ten is noise. */
const MAX_TAGS_PER_REPLY = 3;
/** How many names a `{{tag:…}}` list may offer. */
const MAX_TAG_NAMES = 12;

interface ActionSpec {
  /** True when the placeholder must carry a value list: `{{tag:billing,shipping}}`. */
  takesValues: boolean;
  /** Contracted whether or not the preamble mentions it. */
  always: boolean;
  /** What the operator's placeholder becomes in the rendered prose. */
  render(values: readonly string[]): string;
  /** The syntax line appended AFTER all editable text. See prompt.ts. */
  contract(values: readonly string[]): string;
}

const SPECS: Record<ActionName, ActionSpec> = {
  handoff: {
    takesValues: false,
    always: true,
    render: () => '<<HANDOFF>>',
    contract: () =>
      '- To hand the conversation to a person: write one short sentence telling the visitor ' +
      'you are connecting them to a team member, then end your reply with <<HANDOFF>> on its ' +
      'own line. Never invent an answer in order to avoid handing off.',
  },
  tag: {
    takesValues: true,
    always: false,
    render: (values) => values.map((v) => `<<TAG:${v}>>`).join(' '),
    contract: (values) =>
      `- To label this conversation for the team: include <<TAG:name>> in your reply, using ` +
      `only these names: ${values.join(', ')}. Use at most ${MAX_TAGS_PER_REPLY}, and only when ` +
      `the topic is clear. Anything else is ignored.`,
  },
  resolve: {
    takesValues: false,
    always: false,
    render: () => '<<RESOLVE>>',
    contract: () =>
      '- To close the conversation: end your reply with <<RESOLVE>> on its own line, and only ' +
      'after the visitor has confirmed they need nothing else. Never in the same reply as ' +
      '<<HANDOFF>>.',
  },
};

/**
 * Every token, for stripping.
 *
 * Deliberately wider than what is enabled: a model that emits `<<RESOLVE>>` on an install
 * where resolve is off must have it IGNORED, not shown. A visitor reading `<<RESOLVE>>` at
 * the end of an answer is a worse failure than the action not firing.
 */
const ANY_TOKEN = /<<(?:HANDOFF|RESOLVE|TAG:[^>\n]{0,40})>>/g;
const TAG_TOKEN = /<<TAG:([^>\n]{1,40})>>/g;

/** `{{name}}` or `{{name:a,b,c}}`. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*(?::([^}]*))?\}\}/g;

export interface RenderedPreamble {
  /** The operator's prose with every placeholder replaced by the literal token(s). */
  text: string;
  /** What the model may use in this reply. */
  actions: EnabledActions;
}

/**
 * Turn an authored preamble into what the model sees.
 *
 * Lenient on purpose. `validatePreamble` is the gate, and it runs where a human is
 * looking at the field — but a value can also arrive from a database written by an older
 * release, or by hand. At that point refusing to render would mean no AI reply at all,
 * so an unknown placeholder is dropped and everything else still works.
 */
export function renderPreamble(template: string): RenderedPreamble {
  const enabled = new Map<ActionName, readonly string[]>();
  for (const name of ACTION_NAMES) if (SPECS[name].always) enabled.set(name, []);

  const text = template.replace(PLACEHOLDER, (_match, rawName: string, rawValues?: string) => {
    const name = rawName.toLowerCase() as ActionName;
    const spec = SPECS[name];
    if (!spec) return '';

    const values = parseValues(rawValues);
    if (spec.takesValues && values.length === 0) return '';

    // A second `{{tag:…}}` in the same preamble widens the list rather than replacing it,
    // which is the reading that cannot silently drop a name somebody wrote.
    const merged = spec.takesValues
      ? [...new Set([...(enabled.get(name) ?? []), ...values])].slice(0, MAX_TAG_NAMES)
      : [];
    enabled.set(name, merged);
    return spec.render(merged);
  });

  return { text: tidy(text), actions: enabled };
}

/**
 * The block of syntax appended after every editable part of the prompt.
 *
 * Last on purpose, and this is the reason the split in this file exists: the preamble,
 * the customer's own prompt and their house rules all come earlier, so none of them can
 * end with a sentence that talks the model out of the protocol. Policy is editable;
 * the contract is not.
 */
export function actionContract(actions: EnabledActions): string {
  const lines: string[] = [];
  for (const name of ACTION_NAMES) {
    const values = actions.get(name);
    if (!values) continue;
    if (SPECS[name].takesValues && values.length === 0) continue;
    lines.push(SPECS[name].contract(values));
  }
  if (lines.length === 0) return '';
  return [
    'Actions (these tokens are removed before the visitor sees your reply — never explain them):',
    ...lines,
  ].join('\n');
}

export interface ParsedActions {
  /** The reply with every action token removed. */
  text: string;
  handoff: boolean;
  resolve: boolean;
  /** Normalized, deduped, capped, and filtered to the names the preamble offered. */
  tags: string[];
}

/**
 * Read the actions out of a model reply and clean the text.
 *
 * A token for an action that is not enabled is stripped and ignored — it costs the model
 * a few characters and costs us nothing, which is the right trade against a visitor
 * seeing protocol in their chat window.
 */
export function parseActions(raw: string, actions: EnabledActions): ParsedActions {
  const allowed = new Set((actions.get('tag') ?? []).map(normalizeTag));

  const tags: string[] = [];
  for (const match of raw.matchAll(TAG_TOKEN)) {
    if (!actions.has('tag')) break;
    const tag = normalizeTag(match[1]!);
    if (!TAG_NAME.test(tag) || !allowed.has(tag) || tags.includes(tag)) continue;
    if (tags.length >= MAX_TAGS_PER_REPLY) break;
    tags.push(tag);
  }

  const handoff = actions.has('handoff') && raw.includes('<<HANDOFF>>');
  // Never both. A reply that asks for a person AND closes the conversation would leave the
  // agent an inbox row that is already resolved, and the visitor a thread that reset while
  // they were waiting for the human they were just promised.
  const resolve = !handoff && actions.has('resolve') && raw.includes('<<RESOLVE>>');

  return { text: tidy(raw.replace(ANY_TOKEN, '')), handoff, resolve, tags };
}

export interface PreambleProblem {
  message: string;
}

/**
 * Reject an authored preamble that would not do what its author thinks.
 *
 * Only placeholder mistakes are errors. The prose itself is the operator's business —
 * this is not a linter for prompt quality, and pretending otherwise would mean a
 * settings page that argues with the person tuning it.
 *
 * A typo IS an error, though: `{{handof}}` left in place would ship literal braces to the
 * model, and silently never hand off. That is a bug an operator would spend an afternoon
 * on, so it is caught at the one moment they are looking at the text.
 */
export function validatePreamble(template: string): PreambleProblem | null {
  const seen = new Set<string>();
  const stripped = template.replace(PLACEHOLDER, (_m, rawName: string, rawValues?: string) => {
    const name = rawName.toLowerCase();
    seen.add(name);
    if (!(ACTION_NAMES as readonly string[]).includes(name)) {
      seen.add(`!unknown:${rawName}`);
      return '';
    }
    const spec = SPECS[name as ActionName];
    const values = parseValues(rawValues);
    if (spec.takesValues && values.length === 0) seen.add(`!empty:${name}`);
    for (const value of values) if (!TAG_NAME.test(value)) seen.add(`!value:${value}`);
    if (!spec.takesValues && values.length > 0) seen.add(`!args:${name}`);
    return '';
  });

  const unknown = [...seen].find((s) => s.startsWith('!unknown:'));
  if (unknown) {
    return {
      message:
        `{{${unknown.slice('!unknown:'.length)}}} is not an action. ` +
        `Available: ${ACTION_NAMES.map((n) => (SPECS[n].takesValues ? `{{${n}:a,b}}` : `{{${n}}}`)).join(', ')}.`,
    };
  }
  const empty = [...seen].find((s) => s.startsWith('!empty:'));
  if (empty) {
    const name = empty.slice('!empty:'.length);
    return {
      message:
        `{{${name}}} needs the list of names it may use, as {{${name}:billing,shipping}}. ` +
        `Without one the assistant would invent labels, and the reports that group by them ` +
        `would be worthless.`,
    };
  }
  const args = [...seen].find((s) => s.startsWith('!args:'));
  if (args) {
    const name = args.slice('!args:'.length);
    return { message: `{{${name}}} takes no values — write it as {{${name}}}.` };
  }
  const bad = [...seen].find((s) => s.startsWith('!value:'));
  if (bad) {
    return {
      message:
        `"${bad.slice('!value:'.length)}" is not a usable label: lowercase letters, numbers, ` +
        `spaces, hyphens and underscores, up to 24 characters.`,
    };
  }
  // Braces that survived the placeholder pass are a typo in the syntax itself — a missing
  // colon, a stray space inside the name, one closing brace.
  if (stripped.includes('{{') || stripped.includes('}}')) {
    return {
      message:
        'There is a `{{` or `}}` that is not a complete action. Write them exactly as ' +
        `${ACTION_NAMES.map((n) => (SPECS[n].takesValues ? `{{${n}:a,b}}` : `{{${n}}}`)).join(', ')}.`,
    };
  }
  return null;
}

/** The placeholder forms, for the panel to show without duplicating this file's rules. */
export function actionCatalog(): Array<{ name: ActionName; placeholder: string; always: boolean }> {
  return ACTION_NAMES.map((name) => ({
    name,
    placeholder: SPECS[name].takesValues ? `{{${name}:billing,shipping}}` : `{{${name}}}`,
    always: SPECS[name].always,
  }));
}

function parseValues(raw?: string): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((v) => normalizeTag(v))
        .filter((v) => v.length > 0),
    ),
  ].slice(0, MAX_TAG_NAMES);
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24).trim();
}

/** Collapse the gaps a removed token leaves behind, without touching real paragraphs. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
