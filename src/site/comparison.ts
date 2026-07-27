/**
 * The comparison table's data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE EDITING
 *
 * Every claim in the `nestled` column is checkable against this repository —
 * mostly against the `plans` seed in prisma/migrations/0001_init.
 *
 * Every claim about somebody else came off THEIR OWN page on the date in
 * `verifiedOn`, and the page shows that date to the reader. Three reasons that
 * rule exists, in ascending order of what breaking it costs:
 *
 *   1. Competitor pricing and feature sets change monthly. A cell written from
 *      memory is stale before it is deployed.
 *   2. A prospect who spots one wrong cell stops believing the other twenty, and
 *      the page you built to win the comparison loses it instead.
 *   3. A false statement of fact about a named competitor's product is a legal
 *      matter in most of the places you will sell, not a marketing quibble.
 *
 * So when you refresh this file: open their pricing page, read the row, write
 * what it says, move `verifiedOn`. If a row is genuinely not comparable use
 * `'n/a'`; if you could not find it, leave `'unknown'` — a dash is honest and a
 * guess is not.
 *
 * Anything sourced from a review site rather than the vendor lives in
 * `TRADEOFFS` and is worded as a report, not as a fact about the product.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The date every competitor column was last read off the vendor's own page. */
export const VERIFIED_ON = '27 July 2026';

/** `true`/`false` where it is a clear yes or no; a string where it needs nuance. */
export type Cell = true | false | 'unknown' | 'n/a' | string;

export interface Competitor {
  /** Shown as the column header. */
  name: string;
  /** Where a reader — or you — goes to check. */
  url: string;
  /**
   * ISO-ish date you last checked this column against that page. Empty means
   * never, and the page says so rather than implying otherwise.
   */
  verifiedOn: string;
}

export interface Row {
  /** The question a buyer is actually asking. */
  label: string;
  /** Why it matters, in one sentence. Optional. */
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
  { name: 'Crisp', url: 'https://crisp.chat/en/pricing/', verifiedOn: VERIFIED_ON },
  { name: 'Intercom', url: 'https://www.intercom.com/pricing', verifiedOn: VERIFIED_ON },
  { name: 'Tidio', url: 'https://www.tidio.com/pricing/', verifiedOn: VERIFIED_ON },
];

export const ROWS: Row[] = [
  {
    label: 'Free trial without a card',
    detail: 'Whether you can see the whole product before handing over payment details.',
    nestled: '14 days, everything on',
    others: {
      Crisp: '14 days, no card',
      Intercom: '14 days, no card',
      Tidio: '7 days, no card',
    },
  },
  {
    label: 'What the price is attached to',
    detail:
      'The single most important line on any pricing page: which number has to grow before your invoice does.',
    nestled: 'Seats',
    others: {
      Crisp: 'Workspace, plus $10 per extra seat',
      Intercom: 'Seats, plus $0.99 per AI outcome',
      Tidio: 'Billable conversations',
    },
  },
  {
    label: 'Cheapest plan a two-person team can actually use',
    detail: 'Comparing the entry paid tier, at the vendor’s own advertised rate.',
    nestled: '$19/mo — 2 seats, 1,000 conversations',
    others: {
      Crisp: '$45/mo — 4 seats, conversations uncapped',
      Intercom: 'From $29/seat/mo annually — $58 for two',
      Tidio: '$24.17/mo — 10 seats, 100 conversations',
    },
  },
  {
    label: 'Your bill does not move when you have a busy month',
    detail:
      'A launch, a mention, a busy December. On usage-priced plans a good month arrives as a bigger invoice.',
    nestled: true,
    others: {
      Crisp: 'Conversations yes; AI credits are consumed',
      Intercom: false,
      Tidio: false,
    },
  },
  {
    label: 'No cap on how many customer records you keep',
    detail:
      'Being charged more for remembering people you already talked to is a strange thing to pay for.',
    nestled: true,
    others: {
      Crisp: '5,000 / 50,000 / 200,000 by plan',
      Intercom: 'unknown',
      Tidio: 'unknown',
    },
  },
  {
    label: 'Going over your plan does not switch the chat off',
    detail:
      'Over your conversation allowance we warn you and keep serving; the only hard stop is on AI replies, and that falls back to your written answers and then to a person.',
    nestled: true,
    others: {
      Crisp: 'Conversations are uncapped',
      Intercom: 'No conversation cap; AI billed per outcome',
      Tidio: false,
    },
  },
  {
    label: 'AI replies are included in the plan, not billed per use',
    detail:
      'Ours are metered against a monthly allowance you already paid for. When it runs out the chat keeps working.',
    nestled: '500–10,000/mo by plan',
    others: {
      Crisp: '$5 / $25 / $75 of AI credits by plan',
      Intercom: '$0.99 per resolved outcome',
      Tidio: '50 Lyro conversations, one-off',
    },
  },
  {
    label: 'Several websites in one inbox, without the top plan',
    nestled: '1 / 1 / 5 / 25 by plan',
    others: {
      Crisp: '0 sub-inboxes on $45; 2 on $95; 5 on $295',
      Intercom: 'Multiple inboxes from Advanced',
      Tidio: 'Multiproject on Plus and Premium',
    },
  },
  {
    label: 'Per-website permissions for teammates',
    detail: 'Scope somebody to one site, or to answering chats without touching settings.',
    nestled: true,
    others: {
      Crisp: 'unknown',
      Intercom: 'unknown',
      Tidio: 'Permissions from Growth',
    },
  },
  {
    label: 'Watch a visitor’s screen while you help',
    detail: 'Recorded only while an agent is actually watching, and only if you switch it on.',
    nestled: 'Yes, from $49/mo',
    others: {
      Crisp: 'Yes — MagicBrowse, from $95/mo',
      Intercom: 'unknown',
      Tidio: 'unknown',
    },
  },
  {
    label: 'Remove the vendor’s badge from your widget',
    nestled: 'Yes, from $49/mo',
    others: {
      Crisp: 'Plus plan only — $295/mo',
      Intercom: 'Higher plans only',
      Tidio: 'Paid plans or add-on',
    },
  },
  {
    label: 'Every visitor-facing word is editable, next to a live preview',
    detail:
      'All of it — greeting, buttons, offline notice, rating prompt — with the real widget rendering beside the form as you type.',
    nestled: true,
    others: {
      Crisp: 'unknown',
      Intercom: 'unknown',
      Tidio: 'unknown',
    },
  },
  {
    label: 'Bot flows that run on the server',
    detail:
      'Server-side execution means a flow behaves identically for every visitor and can consult your knowledge base and your assignment rules.',
    nestled: 'Yes, from $19/mo',
    others: {
      Crisp: 'Chatbot builder from $95/mo',
      Intercom: 'Workflows from Advanced',
      Tidio: 'Flows on every plan, visitor-capped',
    },
  },
  {
    label: 'Vendor staff access to your account lands in YOUR audit trail',
    detail:
      'Our support can only enter through a session with a written reason that expires in half an hour, cannot touch billing or your keys, and shows up in your own activity log labelled as ours.',
    nestled: true,
    others: {
      Crisp: 'Not documented',
      Intercom: 'Not documented',
      Tidio: 'Not documented',
    },
  },
  {
    label: 'Installable phone app with push notifications',
    nestled: true,
    others: { Crisp: true, Intercom: true, Tidio: true },
  },
];

export interface Tradeoff {
  competitor: string;
  /** Said plainly, because a comparison page that grants nothing is not read. */
  strength: string;
  /** What the pricing model does to you. Vendor-sourced facts only. */
  costs: string[];
  /** Third-party reports. Worded as reports, with somewhere to check. */
  reported?: { text: string; source: string; url: string };
}

/**
 * Where each of them is genuinely strong, and what their model costs you.
 *
 * The `costs` entries are consequences of facts on the vendor's own pricing or
 * help pages — no characterisation of quality. `reported` is where third-party
 * review coverage goes, and it is attributed and linked, because "buyers say X"
 * without a link is just us saying X.
 */
export const TRADEOFFS: Tradeoff[] = [
  {
    competitor: 'Crisp',
    strength:
      'The closest of the three to how we price, and the only one of them that does not cap conversations at all. If you answer a very high volume of chats and never need more than a few inboxes, Crisp is a strong buy and we will not pretend otherwise.',
    costs: [
      'The cap moved rather than disappeared: each plan limits stored customer profiles — 5,000 on Mini, 50,000 on Essentials, 200,000 on Plus — so you can be pushed up a tier by how many people you have talked to, not by how much support you are doing.',
      'AI arrives as prepaid credits ($5 / $25 / $75 a month by plan, which Crisp puts at roughly 90 / 450 / 1,350 automated conversations). A busy month spends them.',
      'The $45 Mini plan has no sub-inboxes at all — a second website means $95/mo.',
      'Removing “We run on Crisp” from the chatbox needs the $295/mo Plus plan.',
    ],
    reported: {
      text:
        'Reviewers note there is no published overage price for the profile ceilings, so what happens when you cross one is not obvious in advance.',
      source: 'Featurebase',
      url: 'https://www.featurebase.app/blog/crisp-pricing',
    },
  },
  {
    competitor: 'Intercom',
    strength:
      'By far the deepest product here, and genuinely more than a chat tool: ticketing, a help centre, reporting, and an AI agent with real engineering behind it. If you are staffing a support department rather than answering your own customers, this is the serious option.',
    costs: [
      'Seats are $29, $85 and $132 per person per month on annual billing, and roughly $39 / $99 / $139 month-to-month. A team of five on Advanced is $425 a month before any AI.',
      'Fin is $0.99 per outcome on top of seats — so the better the AI performs, the larger the invoice. That is a coherent way to price it, and it is the opposite of a fixed monthly cost.',
      'More capability sits behind add-ons: Copilot at $29 per agent, and further monthly charges for proactive messaging and conversation analysis.',
    ],
    reported: {
      text:
        'The recurring complaint in review coverage is not quality but forecasting — bills that moved sharply as AI usage grew, and a model reviewers describe as harder to predict than the pricing page suggests.',
      source: 'Macha',
      url: 'https://www.getmacha.com/blog/is-intercom-worth-it',
    },
  },
  {
    competitor: 'Tidio',
    strength:
      'Ten seats on every tier including the free one, which is more generous on team size than anybody else here, plus a mature set of ecommerce integrations. If you have a large team and a modest chat volume, that maths can work well.',
    costs: [
      'The price is attached to billable conversations — 50/mo free, 100 on the $24.17 Starter, from 250 on Growth — where a billable conversation is any thread a human agent replies to.',
      'Tidio’s own help centre says that when the monthly limit is reached you are notified and “you won’t be able to see more incoming communication nor respond to it”. That is the failure mode we designed against: the cap arrives during your busiest week.',
      'Lyro’s 50 free AI conversations are a one-off allowance that does not reset, and unused Flows visitor quota expires each month rather than rolling over.',
    ],
    reported: {
      text:
        'Reaching the cap mid-month means either upgrading or buying extra conversation blocks, which review coverage describes as one of the harder pricing models in this category to forecast.',
      source: 'eesel AI',
      url: 'https://www.eesel.ai/blog/tidio-pricing',
    },
  },
];

/** Shown in the small print under the table so a reader can check us. */
export const SOURCES: { label: string; url: string }[] = [
  { label: 'Crisp pricing', url: 'https://crisp.chat/en/pricing/' },
  {
    label: 'Crisp — removing branding',
    url: 'https://help.crisp.chat/en/article/how-to-remove-the-we-run-on-crisp-branding-links-dkrg1d/',
  },
  { label: 'Intercom pricing', url: 'https://www.intercom.com/pricing' },
  { label: 'Tidio pricing', url: 'https://www.tidio.com/pricing/' },
  {
    label: 'Tidio — the monthly conversations limit',
    url: 'https://help.tidio.com/hc/en-us/articles/11874534946460-The-monthly-conversations-limit',
  },
];
