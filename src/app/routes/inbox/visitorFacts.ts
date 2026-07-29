/**
 * Turning what we know about a visitor into something an agent can read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The details panel used to be `Object.entries(...)` and `String(value)`, which is
 * the shape of the data rather than the shape of the question. It produced, on a
 * real conversation, all of these at once:
 *
 *   customer            [object Object]
 *   can_manage_billing  true
 *   location            null
 *   user_agent          Mozilla/5.0 (Windows NT 10.0; W…
 *   current_page        https://staging.nestled.chat/ap…
 *
 * Every one of those is a different failure of the same assumption — that a value
 * is a string and a key is a label. A nested object stringifies to nothing, a
 * boolean reads as source code, a null becomes the word "null", and the two things
 * an agent most wants (which page, which browser) are precisely the two that get
 * cut off, because they are the longest.
 *
 * So: keys are humanised, values are formatted by what they ARE, and anything with
 * nothing to say is dropped rather than rendered as an empty row. This lives apart
 * from the component because it is ordinary data transformation with real edge
 * cases, and it is worth being able to test without a DOM.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Words that look wrong in sentence case. */
const ACRONYMS: Record<string, string> = {
  ip: 'IP',
  url: 'URL',
  id: 'ID',
  os: 'OS',
  ua: 'UA',
  sms: 'SMS',
  api: 'API',
  utm: 'UTM',
};

/** `can_manage_billing` → `Can manage billing`; `ip_address` → `IP address`. */
export function humanKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  if (words.length === 0) return key;
  const [first, ...rest] = words;
  const head = ACRONYMS[first!.toLowerCase()] ?? first!.charAt(0).toUpperCase() + first!.slice(1);
  return [head, ...rest].join(' ');
}

export interface Fact {
  key: string;
  label: string;
  value: string;
  /** Set when the value is a link worth following. */
  href?: string;
  /** The untruncated original, for a tooltip. */
  title?: string;
}

/**
 * Flatten to leaf values, one dotted path per leaf.
 *
 * `{ customer: { id: 7, name: 'Ada' } }` becomes two rows rather than one that says
 * `[object Object]`. Depth is capped because these come off the wire: a customer's
 * own server signs this payload, and a deeply nested or self-referential one must
 * not be able to hang the panel that renders it.
 */
function leaves(value: unknown, path: string, out: [string, unknown][], depth = 0): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    // Arrays of scalars read better joined than as `tags.0`, `tags.1`, `tags.2`.
    if (value.every((v) => typeof v !== 'object' || v === null)) {
      out.push([path, value.join(', ')]);
      return;
    }
    if (depth >= 2) return;
    value.forEach((v, i) => leaves(v, `${path}.${i + 1}`, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    if (depth >= 2) return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      leaves(v, path ? `${path}.${k}` : k, out, depth + 1);
    }
    return;
  }
  out.push([path, value]);
}

function shortenUrl(raw: string): { value: string; href: string; title: string } | null {
  try {
    const url = new URL(raw);
    const tail = `${url.pathname}${url.search}`;
    return {
      // The host is usually the customer's own site and the same on every row, so
      // the path is the part that distinguishes one page from another.
      value: tail === '/' || tail === '' ? url.hostname : tail,
      href: url.href,
      title: url.href,
    };
  } catch {
    return null;
  }
}

/**
 * "Chrome 126 on Windows", from a user-agent string.
 *
 * Deliberately crude, and it degrades to the raw string rather than to nothing. A
 * raw UA is 120 characters of which about six matter to an agent, and truncating it
 * cuts off at "Mozilla/5.0 (Windows NT 10.0; W…" — a prefix that is the same for
 * every Windows visitor and therefore tells them nothing at all.
 */
export function describeUserAgent(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua) ??
    /OPR\/(\d+)/.exec(ua) ??
    /Firefox\/(\d+)/.exec(ua) ??
    // Chrome must be tested after Edge and Opera: both put "Chrome" in their UA too.
    /Chrome\/(\d+)/.exec(ua) ??
    /Version\/(\d+).*Safari/.exec(ua);
  const name = browser
    ? browser[0].startsWith('Edg')
      ? 'Edge'
      : browser[0].startsWith('OPR')
        ? 'Opera'
        : browser[0].startsWith('Firefox')
          ? 'Firefox'
          : browser[0].startsWith('Chrome')
            ? 'Chrome'
            : 'Safari'
    : null;

  const os = /Windows NT 10/.test(ua)
    ? 'Windows'
    : /Windows/.test(ua)
      ? 'Windows'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;

  if (!name && !os) return ua;
  const version = browser?.[1];
  return [name && version ? `${name} ${version}` : name, os && `on ${os}`].filter(Boolean).join(' ');
}

/**
 * One record of loose values into rows worth rendering.
 *
 * `skip` names keys the caller renders itself — the browser hints get a purpose-built
 * block, and repeating them underneath as raw pairs is the dump this replaces.
 */
export function toFacts(source: Record<string, unknown> | null | undefined, skip: string[] = []): Fact[] {
  if (!source) return [];
  const flat: [string, unknown][] = [];
  leaves(source, '', flat);

  const skipped = new Set(skip);
  const facts: Fact[] = [];
  for (const [key, raw] of flat) {
    if (skipped.has(key) || key.startsWith('_')) continue;
    // Nothing to say is not the same as "say nothing": an empty row costs a line of
    // an agent's attention and answers no question.
    if (raw === null || raw === undefined || raw === '') continue;

    if (typeof raw === 'boolean') {
      facts.push({ key, label: humanKey(key), value: raw ? 'Yes' : 'No' });
      continue;
    }
    const text = String(raw);
    if (!text.trim() || text === 'null' || text === 'undefined') continue;

    if (/^https?:\/\//i.test(text)) {
      const url = shortenUrl(text);
      if (url) {
        facts.push({ key, label: humanKey(key), value: url.value, href: url.href, title: url.title });
        continue;
      }
    }
    if (/user[_-]?agent/i.test(key)) {
      facts.push({ key, label: humanKey(key), value: describeUserAgent(text), title: text });
      continue;
    }
    facts.push({ key, label: humanKey(key), value: text, title: text.length > 28 ? text : undefined });
  }
  return facts;
}

/** The browser hints that get a purpose-built block rather than a generic row. */
export const HANDLED_HINTS = [
  'current_page',
  'referrer',
  'user_agent',
  'screen_resolution',
  'language',
  'timezone',
  'ip_address',
  'location',
];

export interface VisitorContext {
  page: Fact | null;
  referrer: Fact | null;
  device: string | null;
  locale: string | null;
  ip: string | null;
}

/** Pull the well-known hints out of `metadata` into something with a shape. */
export function visitorContext(metadata: Record<string, unknown> | null | undefined): VisitorContext {
  const get = (key: string): string | null => {
    const value = metadata?.[key];
    if (value === null || value === undefined || value === '') return null;
    const text = String(value);
    return text && text !== 'null' && text !== 'undefined' ? text : null;
  };

  const pageUrl = get('current_page');
  const referrerUrl = get('referrer');
  const ua = get('user_agent');
  const screen = get('screen_resolution');
  const language = get('language');
  const timezone = get('timezone');

  const asFact = (key: string, raw: string | null): Fact | null => {
    if (!raw) return null;
    const url = shortenUrl(raw);
    return url
      ? { key, label: humanKey(key), value: url.value, href: url.href, title: url.title }
      : { key, label: humanKey(key), value: raw, title: raw };
  };

  return {
    page: asFact('current_page', pageUrl),
    referrer: asFact('referrer', referrerUrl),
    device: [ua ? describeUserAgent(ua) : null, screen].filter(Boolean).join(' · ') || null,
    locale: [language, timezone].filter(Boolean).join(' · ') || null,
    ip: get('ip_address'),
  };
}
