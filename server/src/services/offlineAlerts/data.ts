/**
 * Assembling and wording an offline-data alert. NO database, NO providers.
 *
 * Split out from `index.ts` for one concrete reason: that file imports prisma, and importing
 * prisma runs the environment validation — so a test of "does the alert name the right
 * person" could not run without a DATABASE_URL, a JWT secret and a socket hub. This text IS
 * the product for whoever reads it at 3am, and it is merged from four differently-shaped
 * JSON blobs, which is exactly the code that has to be cheap to test.
 *
 * The same split exists for the same reason in `services/triggers.ts`.
 */

/** What the team is told about. Assembled from every place a detail can end up. */
export interface CollectedData {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Bot-flow `collect`/`choices` answers, pre-chat form values, verified host attributes. */
  fields: Array<{ label: string; value: string }>;
  /** The AI's handoff summary, when there is one. */
  summary: string | null;
  /** The visitor's most recent message, for context the fields cannot carry. */
  lastMessage: string | null;
}

/** Field names that are identity rather than answers — surfaced separately, not twice. */
const IDENTITY_KEYS = new Set(['name', 'full_name', 'fullname', 'email', 'e_mail', 'phone', 'tel', 'telephone', 'mobile']);

/**
 * Human-readable label for a machine field name: `order_number` → `Order number`.
 *
 * Lowercased after splitting, then sentence-cased. Without the lowercase step `orderNumber`
 * rendered as "Order Number" while `order_number` rendered as "Order number" — the same
 * field labelled two ways in two customers' alerts depending on how whoever built the bot
 * flow happened to name it. The cost is an acronym losing its capitals ("vatId" → "Vat id"),
 * which is a smaller inconsistency than the one it replaces.
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/**
 * Merge every source of visitor detail into one block, newest source winning.
 *
 * Order matters: the pre-chat form and the bot flow are things the VISITOR typed, while
 * `custom_attributes` is what the host site signed about them. Both belong in the alert —
 * the signed facts are often the useful half (an order number, a plan) — but a field the
 * visitor typed is the one they are waiting to be contacted about, so it is listed first.
 *
 * Exported and pure so the assembly can be tested without a database. That matters here:
 * this text is the entire product for whoever reads it at 3am, and it is assembled from
 * four differently-shaped JSON blobs.
 */
export function assembleData(input: {
  visitorName: string | null;
  visitorEmail: string | null;
  collected: Record<string, unknown>;
  prechat: Record<string, unknown>;
  attributes: Record<string, unknown>;
  summary: string | null;
  lastMessage: string | null;
}): CollectedData {
  const fields: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();

  const add = (source: Record<string, unknown>, prefix?: string): void => {
    for (const [key, raw] of Object.entries(source)) {
      if (raw === null || raw === undefined || raw === '') continue;
      // `customer` inside custom_attributes is the reserved identity object, handled below.
      if (key === 'customer' && typeof raw === 'object') continue;
      const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      const norm = key.toLowerCase();
      if (IDENTITY_KEYS.has(norm) || seen.has(norm)) continue;
      seen.add(norm);
      fields.push({ label: prefix ? `${prefix}${humanizeKey(key)}` : humanizeKey(key), value: value.slice(0, 300) });
    }
  };

  add(input.collected);
  add(input.prechat);
  // Marked, because the reader needs to know these were asserted by the website rather than
  // typed by the visitor — an "Order" the site signed is trustworthy in a way a typed one
  // is not, and the alert is where somebody decides whether to act on it.
  add(input.attributes, 'Verified · ');

  const identity = (key: string): string | null => {
    for (const source of [input.collected, input.prechat, input.attributes]) {
      for (const [k, v] of Object.entries(source)) {
        if (k.toLowerCase() === key && v !== null && v !== '') return String(v).slice(0, 200);
      }
    }
    return null;
  };
  const customer = (input.attributes.customer ?? {}) as Record<string, unknown>;
  const fromCustomer = (key: string): string | null => {
    const value = customer[key];
    return value === null || value === undefined || value === '' ? null : String(value).slice(0, 200);
  };

  return {
    name: input.visitorName || identity('name') || fromCustomer('name'),
    email: input.visitorEmail || identity('email') || fromCustomer('email'),
    phone: identity('phone') || fromCustomer('phone'),
    fields,
    summary: input.summary,
    lastMessage: input.lastMessage,
  };
}

/** True when the alert has anything worth sending. A bare conversation is not news. */
export function hasSomethingToReport(data: CollectedData): boolean {
  return Boolean(data.name || data.email || data.phone || data.fields.length > 0);
}

/**
 * The SMS body.
 *
 * Ruthlessly short, and that is a cost decision as much as a taste one: an SMS is 160 GSM-7
 * characters, or 70 the moment a Turkish "ş" or an emoji appears (see channels/sms.ts), so a
 * chatty alert is three messages every time. What somebody woken up by one needs is who, how
 * to reach them, and a link — the detail is in the email and the inbox.
 */
export function smsBody(data: CollectedData, websiteName: string, url: string): string {
  const who = data.name ?? data.email ?? data.phone ?? 'A visitor';
  const reach = [data.email, data.phone].filter(Boolean).join(' ');
  const parts = [`${websiteName}: ${who} left details while nobody was online.`];
  if (reach) parts.push(reach);
  parts.push(url);
  return parts.join('\n');
}

/** The email body, as plain text. The HTML version is rendered by the email template. */
export function emailBody(data: CollectedData): string {
  const lines: string[] = [];
  if (data.name) lines.push(`Name: ${data.name}`);
  if (data.email) lines.push(`Email: ${data.email}`);
  if (data.phone) lines.push(`Phone: ${data.phone}`);
  for (const field of data.fields) lines.push(`${field.label}: ${field.value}`);
  if (data.summary) lines.push('', `Summary: ${data.summary}`);
  if (data.lastMessage) lines.push('', `Last message: ${data.lastMessage}`);
  return lines.join('\n');
}

/**
 * Is nobody there?
 *
 * Exported for the tests, which is the only way to pin "either" without standing up a
 * socket hub and a business-hours schedule.
 */
export function isOffline(agentOnline: boolean, withinHours: boolean): boolean {
  return !agentOnline || !withinHours;
}

