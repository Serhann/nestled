import type { ReactNode } from 'react';
import { ORIGINS } from '../lib/origins';
import { PricingIsland } from './PricingIsland';

/**
 * The marketing site.
 *
 * These components are rendered to static HTML at build time (see
 * scripts/prerender.mjs) and shipped as real documents. A crawler, a link
 * preview and a customer on a slow connection all get the words immediately —
 * which an SPA shell cannot do, and which matters more here than anywhere else
 * in the product because this is the page people arrive on.
 *
 * The only JavaScript that ships is for the islands: the pricing table, which
 * fetches the live plan catalog so the marketing page and the in-app picker can
 * never disagree about what a plan costs.
 */

const APP = ORIGINS.app;

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
      'Live chat, live visitors and an AI assistant that answers from your own knowledge base. One snippet, and you are talking to your customers.',
  },
  {
    path: '/pricing',
    file: 'pricing.html',
    title: 'Pricing — Nestled',
    description: 'Simple per-seat pricing. Fourteen days free, no card.',
  },
  {
    path: '/features',
    file: 'features.html',
    title: 'Features — Nestled',
    description:
      'Shared inbox, live visitor board, AI replies, bot flows, routing and session replay.',
  },
  {
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy — Nestled',
    description: 'What Nestled stores, why, and for how long.',
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
      return <Shell current="/pricing"><Pricing /></Shell>;
    case '/features':
      return <Shell current="/features"><Features /></Shell>;
    case '/privacy':
      return <Shell current=""><Legal title="Privacy" body={PRIVACY} /></Shell>;
    case '/terms':
      return <Shell current=""><Legal title="Terms of service" body={TERMS} /></Shell>;
    default:
      return <Shell current="/"><Home /></Shell>;
  }
}

function Shell({ current, children }: { current: string; children: ReactNode }) {
  const links = [
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
  ];
  return (
    <div className="min-h-dvh flex flex-col bg-canvas text-gray-800">
      <header className="border-b border-gray-200/60">
        <nav className="max-w-5xl mx-auto flex items-center gap-6 px-5 h-16" aria-label="Main">
          <a href="/" className="flex items-center gap-2 font-display text-xl">
            <span className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center">
              n
            </span>
            Nestled
          </a>
          <div className="flex items-center gap-5 text-sm font-medium ml-4">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={current === link.href ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'}
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm font-semibold">
            <a href={`${APP}/login`} className="text-gray-600 hover:text-gray-900">
              Sign in
            </a>
            <a
              href={`${APP}/signup`}
              className="bg-blue-600 text-white rounded-full px-4 py-2 hover:bg-blue-700 transition"
            >
              Start free
            </a>
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-200/60 mt-16">
        <div className="max-w-5xl mx-auto px-5 py-8 flex flex-wrap gap-4 items-center text-sm text-gray-500">
          <span>© {new Date().getFullYear()} Nestled</span>
          <a href="/privacy" className="hover:text-gray-800">Privacy</a>
          <a href="/terms" className="hover:text-gray-800">Terms</a>
          <a href={`${APP}/login`} className="ml-auto hover:text-gray-800">Sign in</a>
        </div>
      </footer>
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="max-w-5xl mx-auto px-5 pt-20 pb-16 text-center">
        <h1 className="font-display text-4xl sm:text-6xl leading-[1.05] tracking-tight">
          Talk to the people
          <br />
          already on your site
        </h1>
        <p className="mt-5 text-lg text-gray-600 max-w-xl mx-auto">
          Live chat, a live visitor board and an AI that answers from your own knowledge base —
          and hands over to a person the moment it should.
        </p>
        <div className="mt-8 flex flex-wrap gap-3 justify-center">
          <a
            href={`${APP}/signup`}
            className="bg-blue-600 text-white rounded-full px-6 py-3 font-semibold hover:bg-blue-700 transition"
          >
            Start free — no card
          </a>
          <a
            href="/features"
            className="bg-white border border-gray-200 rounded-full px-6 py-3 font-semibold hover:bg-gray-50 transition"
          >
            See what it does
          </a>
        </div>
        <p className="mt-4 text-xs text-gray-400">Fourteen days of everything. Then pick a plan, or don’t.</p>
      </section>

      <section className="max-w-5xl mx-auto px-5 pb-16">
        <div className="grid gap-4 sm:grid-cols-3">
          <Feature
            title="One snippet"
            body="Paste it before </body>. We tell you the moment we can see your site, and if the widget is on a domain you have not allowed yet, we say so and offer to fix it."
          />
          <Feature
            title="An AI that knows when to stop"
            body="It answers from your knowledge base and your verified customer data. When it does not know, it hands over instead of inventing an answer about someone's account."
          />
          <Feature
            title="You see who is here"
            body="Every visitor, the page they are on, where they came from. Start the conversation before they leave."
          />
        </div>
      </section>
    </>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white rounded-3xl border border-gray-100 p-6">
      <h2 className="font-semibold text-gray-900">{title}</h2>
      <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>
    </div>
  );
}

function Features() {
  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: 'The inbox',
      items: [
        ['Shared and assignable', 'Filter by status, website, assignee or tag. Every filtered view is a link you can send a colleague.'],
        ['Canned replies', 'Type / and pick. The ones you send twenty times a day stop costing you anything.'],
        ['Internal notes', 'Context for the next person, invisible to the visitor.'],
        ['Verified customer details', 'Sign details on your own server and agents see them marked as trusted, separately from whatever the page claimed.'],
      ],
    },
    {
      title: 'Visitors',
      items: [
        ['A live board', 'Who is on the site, what page, from where, on what.'],
        ['Reach out first', 'Open a chat on their screen when it is worth interrupting for.'],
        ['Session replay', 'Watch what they are seeing while you help. Recording only happens while someone is actually watching.'],
      ],
    },
    {
      title: 'Automation',
      items: [
        ['AI replies', 'Grounded in your knowledge base, with a hard rule against inventing account details, prices or policies.'],
        ['Bot flows', 'Greet, ask, branch, hand over. Flows run on our servers, so every visitor gets the same behaviour.'],
        ['Routing', 'An ordered list of rules. Take turns, or send to whoever has the fewest open chats — skipping anyone who is offline.'],
        ['Campaigns', 'Say something after thirty seconds on the pricing page, or when someone looks like they are leaving.'],
      ],
    },
    {
      title: 'Making it yours',
      items: [
        ['Colours, corners, fonts', 'With a live preview of the real widget, not a mockup.'],
        ['Every word', 'Change any visitor-facing string. Leave the rest to us, and they keep improving.'],
        ['Business hours', 'And a considered answer for what happens when you are closed.'],
        ['Several websites', 'Each with its own widget, settings and inbox filter, under one account.'],
      ],
    },
  ];

  return (
    <div className="max-w-5xl mx-auto px-5 py-16">
      <h1 className="font-display text-4xl">Everything in Nestled</h1>
      <div className="mt-10 grid gap-10 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title}>
            <h2 className="font-semibold text-lg">{group.title}</h2>
            <dl className="mt-3 space-y-4">
              {group.items.map(([term, body]) => (
                <div key={term}>
                  <dt className="text-sm font-semibold text-gray-800">{term}</dt>
                  <dd className="text-sm text-gray-600 mt-0.5 leading-relaxed">{body}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The pricing page.
 *
 * The table is an island: it renders a static skeleton at build time so the page
 * is never blank, then hydrates and fetches `/api/v1/plans` — the same rows the
 * in-app picker reads. A hardcoded price list here is a price list that is wrong
 * the first time someone edits a plan.
 */
function Pricing() {
  return (
    <div className="max-w-5xl mx-auto px-5 py-16">
      <h1 className="font-display text-4xl text-center">Pricing</h1>
      <p className="mt-3 text-center text-gray-600">
        Fourteen days of everything, no card. Then whichever plan fits.
      </p>
      {/* Rendered here at build time in its pre-fetch state, which is exactly what
          the island renders on its first client pass — so hydration matches
          instead of warning and throwing the server markup away. */}
      <div data-island="pricing" className="mt-10">
        <PricingIsland />
      </div>
      <p className="mt-8 text-center text-sm text-gray-500">
        Going over your conversation allowance does not switch your widget off. We will tell you,
        and your visitors keep being able to reach you.
      </p>
    </div>
  );
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
