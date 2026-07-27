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

function Legal({ title, body }: { title: string; body: [string, string][] }) {
  return (
    <div className="max-w-2xl mx-auto px-5 py-16">
      <h1 className="font-display text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">
        Last updated {new Date().toISOString().slice(0, 10)}.
      </p>
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

const PRIVACY: [string, string][] = [
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

const TERMS: [string, string][] = [
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
