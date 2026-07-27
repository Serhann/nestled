/**
 * The comparison table's data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE EDITING
 *
 * Every claim in the `nestled` column is checkable against this repository, and
 * that is the standard the other columns are held to as well.
 *
 * Competitor cells therefore start as `'unknown'`, which renders as a dash and a
 * footnote pointing at their own site. They are NOT filled in with a guess, and
 * they must not be. Three reasons, in ascending order of how much they will cost
 * you:
 *
 *   1. Competitor pricing and feature sets change monthly. A table written from
 *      memory is stale before it is deployed.
 *   2. A prospect who spots one wrong cell stops believing the other twenty, and
 *      the page you built to win the comparison loses it instead.
 *   3. A false statement of fact about a named competitor's product is a legal
 *      matter in most of the places you will sell, not a marketing quibble.
 *
 * So: open their pricing page, check the row, write down what it says, and set
 * `verifiedOn` to the date you did it. The page shows that date to the reader —
 * which is a claim of diligence, so keep it true. If a row is genuinely not
 * comparable, use `'n/a'` rather than forcing it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** `true`/`false` where it is a clear yes or no; a string where it needs nuance. */
export type Cell = true | false | 'unknown' | 'n/a' | string;

export interface Competitor {
  /** Shown as the column header. */
  name: string;
  /** Where a reader — or you — goes to check. */
  url: string;
  /**
   * ISO date you last checked this column against that page. Empty means never,
   * and the page says so rather than implying otherwise.
   */
  verifiedOn: string;
}

export interface Row {
  /** The question a buyer is actually asking. */
  label: string;
  /** Why it matters, in one sentence. Optional; used as a tooltip-free subtitle. */
  detail?: string;
  /** Our answer. Every one of these is checkable in this repository. */
  nestled: Cell;
  /** Keyed by competitor name. Anything missing renders as unverified. */
  others: Record<string, Cell>;
}

/**
 * The competitors worth a column.
 *
 * Named because a buyer has already typed them into a search box — pretending
 * they do not exist does not help anybody. Add or remove freely; the table adapts.
 */
export const COMPETITORS: Competitor[] = [
  { name: 'Crisp', url: 'https://crisp.chat/en/pricing/', verifiedOn: '' },
  { name: 'Intercom', url: 'https://www.intercom.com/pricing', verifiedOn: '' },
  { name: 'Tidio', url: 'https://www.tidio.com/pricing/', verifiedOn: '' },
];

export const ROWS: Row[] = [
  {
    label: 'Free trial without a card',
    detail: 'Whether you can see the whole product before handing over payment details.',
    nestled: '14 days, everything on',
    others: {},
  },
  {
    label: 'Priced per seat, not per contact',
    detail:
      'Contact-based pricing means a good month raises your bill. Seat-based means it does not.',
    nestled: true,
    others: {},
  },
  {
    label: 'Going over your plan does not switch the chat off',
    detail:
      'Over the conversation allowance we warn you and keep serving. A live website is never taken down over a limit.',
    nestled: true,
    others: {},
  },
  {
    label: 'The assistant answers only from your own material',
    detail:
      'Ours replies from the answers you wrote and from customer details your own server signed. It refuses rather than guessing about orders, prices or policies.',
    nestled: true,
    others: {},
  },
  {
    label: 'You see and can edit every visitor-facing word',
    detail: 'All of it, next to a live preview of the real widget.',
    nestled: true,
    others: {},
  },
  {
    label: 'Several websites on one account, one inbox',
    nestled: 'Yes, plan-dependent',
    others: {},
  },
  {
    label: 'Per-website permissions for teammates',
    detail: 'Scope somebody to one site, or to answering chats without touching settings.',
    nestled: true,
    others: {},
  },
  {
    label: 'Watch a visitor’s screen while you help',
    detail: 'Recorded only while an agent is actually watching, and only if you switch it on.',
    nestled: 'Yes, on higher plans',
    others: {},
  },
  {
    label: 'Bot flows that run on the server',
    detail:
      'Server-side execution means a flow behaves identically for every visitor and can consult your knowledge base and your assignment rules.',
    nestled: true,
    others: {},
  },
  {
    label: 'Self-host it yourself',
    detail: 'One Docker Compose file, your own database, no phone-home.',
    nestled: true,
    others: {},
  },
  {
    label: 'Staff access to your account is logged in YOUR audit trail',
    detail:
      'Our support can only enter through a time-limited session with a written reason, which appears in your own activity log and cannot touch billing or your keys.',
    nestled: true,
    others: {},
  },
  {
    label: 'Installable phone app with push notifications',
    nestled: true,
    others: {},
  },
];
