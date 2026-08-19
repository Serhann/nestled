import type { ReactNode } from 'react';
import { Shell } from './Shell';
import { Home } from './Home';
import { Features } from './Features';
import { Pricing } from './Pricing';
import { Compare } from './Compare';

/**
 * The marketing site's page registry.
 *
 * Each page is rendered to static HTML at build time (scripts/prerender.mjs), so
 * a crawler, a link preview and someone on a bad connection all get the words
 * without executing anything. That matters more here than anywhere else in the
 * product, because this is the page people arrive on — and it is what lets these
 * pages be genuinely detailed without costing the visitor a single kilobyte of
 * framework.
 */

export interface PageMeta {
  path: string;
  file: string;
  title: string;
  description: string;
}

export const PAGES: PageMeta[] = [
  {
    path: '/',
    file: 'index.html',
    title: 'Nestled — live chat for your website',
    description:
      'Add live chat to your website in minutes. Nestled answers the questions you get every day from answers you wrote yourself, and hands the rest to you. Free for 14 days, no card.',
  },
  {
    path: '/features',
    file: 'features.html',
    title: 'What Nestled does — live chat, live visitors and an assistant',
    description:
      'A shared inbox, a live list of who is on your site, an assistant that answers from your own words and hands over rather than guessing, and a chat that matches your brand.',
  },
  {
    path: '/compare',
    file: 'compare.html',
    title: 'Nestled vs Crisp, Intercom and Tidio',
    description:
      'How Nestled compares on price, limits and AI billing, checked against each vendor’s own pricing page. Per-seat pricing rather than per conversation, a chat that keeps serving when you go over your plan, and an assistant that refuses rather than guesses. Including when one of the others is the better choice.',
  },
  {
    path: '/pricing',
    file: 'pricing.html',
    title: 'Pricing — Nestled',
    description:
      'Simple per-seat pricing, billed monthly or yearly. Fourteen days free with everything switched on, and no card until you decide.',
  },
  {
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy — Nestled',
    description: 'What Nestled stores, why, who can see it, and for how long.',
  },
  {
    path: '/terms',
    file: 'terms.html',
    title: 'Terms — Nestled',
    description: 'The terms of service for Nestled.',
  },
];

export function renderPage(path: string): ReactNode {
  switch (path) {
    case '/pricing':
      return (
        <Shell current="/pricing">
          <Pricing />
        </Shell>
      );
    case '/compare':
      return (
        <Shell current="/compare">
          <Compare />
        </Shell>
      );
    case '/features':
      return (
        <Shell current="/features">
          <Features />
        </Shell>
      );
    case '/privacy':
      return (
        <Shell current="">
          <Legal title="Privacy" body={PRIVACY} />
        </Shell>
      );
    case '/terms':
      return (
        <Shell current="">
          <Legal title="Terms of service" body={TERMS} />
        </Shell>
      );
    default:
      return (
        <Shell current="/">
          <Home />
        </Shell>
      );
  }
}

/**
 * When the privacy and terms text below last changed. Edit it when you edit them.
 *
 * It was `new Date()`, evaluated during the prerender — so the date advanced on every deploy
 * and the pages claimed to have been revised on days nobody touched them. That is wrong twice
 * over: it is a freshness signal that is not true, which is the kind of signal a search engine
 * learns to discount for a whole site; and on a legal page the "last updated" date is the thing
 * a reader relies on to know whether the terms they agreed to have changed.
 */
const LEGAL_UPDATED = '2026-08-19';

/**
 * A legal page: a heading, a revision date, and a list of headed paragraphs.
 *
 * The body cells are `ReactNode` rather than `string` because one of them has to contain a
 * button — consent has to be as easy to withdraw as it was to give, and the only honest place
 * to put that control is inside the paragraph that explains what was consented to. Keep the
 * nodes INLINE (text, links, buttons); each one is rendered inside a `<p>`.
 */
function Legal({ title, body }: { title: string; body: [string, ReactNode][] }) {
  return (
    <div className="max-w-2xl mx-auto px-5 py-16">
      <h1 className="font-display text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated {LEGAL_UPDATED}.</p>
      <div className="mt-8 space-y-6">
        {body.map(([heading, text]) => (
          <section key={heading}>
            <h2 className="font-semibold text-gray-900">{heading}</h2>
            <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">{text}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The control that brings the cookie banner back.
 *
 * Rendered hidden, and revealed by public/consent.js — which is only present in an
 * environment that actually has a Google tag (see scripts/analytics-runtime.sh). So on
 * staging, where nothing is tracked and no cookie is set, this sentence and its button are
 * simply absent rather than offering to withdraw a consent that was never asked for.
 *
 * It is a real `<button>`, not a link: it changes state on this page and navigates nowhere.
 */
function ConsentControl() {
  return (
    <span hidden data-consent-reopen>
      {' '}
      <button
        type="button"
        className="underline text-blue-700 hover:text-blue-800 font-medium"
      >
        Change your choice
      </button>
      .
    </span>
  );
}

const PRIVACY: [string, ReactNode][] = [
  [
    'This website, as distinct from the product',
    <>
      Everything below describes what Nestled stores on behalf of a customer whose website runs
      the chat widget. This first section is narrower and easier: it is about you, reading this
      page, on nestled.chat.
    </>,
  ],
  [
    'Cookies on this website',
    <>
      One, and only if you say yes. We use Google Analytics to count visits to our own
      marketing pages — which pages people read, roughly where they came from — so we know
      what is worth writing. It sets a cookie, so we ask first: nothing is stored and no
      analytics request identifies you until you accept, and declining leaves the site working
      exactly as it does now. We do not run advertising and the advertising signals in that tag
      are switched off unconditionally. There is no tracking of any kind on the sign-in or
      application screens.
      <ConsentControl />
    </>,
  ],
  [
    'The chat widget carries none of this',
    <>
      The widget our customers embed in their own sites has no analytics in it. It is a
      deliberate line: adding our own third-party tracker to somebody else's website, past
      their visitors, is not a decision that is ours to take.
    </>,
  ],
  [
    'What we store',
    'Conversations and their messages, the pages a visitor viewed while the widget was loaded, their IP address and a coarse location derived from it, and any details you or your own server chose to send us about them.',
  ],
  [
    'Session replay',
    'When live view is enabled on a plan that includes it, we buffer a recording of a visitor’s page only while one of your agents is actively watching. Nothing is buffered otherwise, and nothing is kept afterwards.',
  ],
  [
    'How long',
    'Conversations are deleted after the retention window on your plan. Deleting your workspace marks everything for deletion; it is recoverable for thirty days and then removed.',
  ],
  [
    'Who can see it',
    'Your own team, according to the permissions you set. Nestled staff can enter your workspace only through an impersonation session that requires a written reason, is time-limited, cannot read your integration secrets or touch billing, and appears in your own audit log.',
  ],
  [
    'Sub-processors',
    'We use a payment processor for billing and an AI provider for assistant replies. Message content is sent to the AI provider only when AI replies are enabled for that website.',
  ],
];

const TERMS: [string, ReactNode][] = [
  [
    'The service',
    'Nestled provides live chat software you embed on websites you control. You are responsible for what you and your team say through it and for having the right to install it where you install it.',
  ],
  [
    'Your data',
    'Yours. We process it to run the service, and we do not sell it. You can export or delete it.',
  ],
  [
    'Payment',
    'Plans are billed per seat, monthly or yearly, in advance. Going over a metered allowance does not interrupt your widget; we contact you.',
  ],
  [
    'Ending it',
    'Cancel whenever you like and the service runs to the end of the period you paid for. We keep your data for thirty days after that in case you come back, then delete it.',
  ],
  [
    'Availability',
    'We work hard to keep the service up and make no promise that it will never be down. Nothing here is a guarantee of uninterrupted service.',
  ],
];
