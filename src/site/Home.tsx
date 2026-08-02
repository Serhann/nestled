import {
  BellRing,
  Brush,
  CheckCircle2,
  Clock,
  Eye,
  MessageSquare,
  Smartphone,
  Sparkles,
  Users,
} from 'lucide-react';
import { Band, PrimaryCta, SectionHeading } from './Shell';
import { WidgetMock } from './WidgetMock';
import { FAQS } from './faqs';
import { ORIGINS } from '../lib/origins';

/**
 * The landing page.
 *
 * Written for the person who runs the business, not the person who will paste
 * the snippet. Two rules held throughout:
 *
 *   - Say the outcome, not the mechanism. "You'll know the moment somebody is
 *     stuck on your checkout" beats "WebSocket-based presence tracking", and the
 *     second one makes a shop owner think this is not for them.
 *   - Claim nothing we cannot do. There are no invented customer quotes, no
 *     "trusted by 5,000 teams", no integrations that do not exist. A landing page
 *     that oversells is a support queue three weeks later.
 */
export function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <HowItWorks />
      <Benefits />
      <AboutTheAI />
      <WhoItsFor />
      <Faq />
      <Closing />
    </>
  );
}

function Hero() {
  return (
    <section className="bg-canvas">
      <div className="max-w-6xl mx-auto px-5 pt-12 pb-14 sm:pt-16 sm:pb-20 grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">
            Live chat for your website
          </p>
          {/* text-balance rather than a manual <br />: a hard break is right at
              exactly one viewport width and leaves a lonely orphan word at every
              other one. */}
          <h1 className="font-display text-4xl sm:text-5xl lg:text-[3.4rem] leading-[1.05] tracking-tight mt-3 text-balance">
            Someone is on your site with a question right now
          </h1>
          <p className="mt-5 text-lg text-gray-600 max-w-xl">
            Nestled adds a chat bubble to your website in a few minutes. It answers the
            questions you get every day from answers you wrote yourself, and passes anything
            else to you — with everything you need to reply already on the screen.
          </p>

          <ul className="mt-6 space-y-2">
            {[
              'No developer needed — we show you exactly where it goes',
              'Answers delivery, returns and opening-hours questions on its own',
              'Reply from your laptop or your phone, wherever you are',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm text-gray-700">
                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-0.5" aria-hidden />
                {line}
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={`${ORIGINS.app}/signup`}
              className="bg-blue-600 text-white rounded-full px-7 py-3.5 font-semibold hover:bg-blue-700 transition shadow-sm"
            >
              Start free for 14 days
            </a>
            <a
              href="/features"
              className="bg-white border border-gray-200 rounded-full px-7 py-3.5 font-semibold hover:bg-gray-50 transition"
            >
              See everything it does
            </a>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            No card. Everything switched on. Cancel by closing the tab.
          </p>
        </div>

        <WidgetMock />
      </div>
    </section>
  );
}

function Problem() {
  const points: [string, string][] = [
    [
      'They had a question and left',
      'Most people will not fill in a contact form for a question they expect to take ten seconds. They open a competitor instead, and you never learn it happened.',
    ],
    [
      'Your inbox answers the same thing daily',
      'Where is my order. Do you deliver here. Can I return this. Every one of them takes a person away from the work only a person can do.',
    ],
    [
      'The good questions arrive at 11pm',
      'Somebody ready to buy, at an hour nobody is working. By the morning the moment is gone and so are they.',
    ],
  ];

  return (
    <Band tone="cream">
      <SectionHeading
        eyebrow="Why bother"
        title="Three things quietly cost you customers"
        lead="None of them look like a problem, because nobody complains. They just go somewhere else."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {points.map(([title, body]) => (
          <div key={title} className="bg-white rounded-3xl border border-gray-100 p-6">
            <h3 className="font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </Band>
  );
}

function HowItWorks() {
  const steps: [string, string, string][] = [
    [
      'Add it to your site',
      'Copy one small piece of code and paste it into your site. We give you the exact instructions for Shopify, WordPress, Webflow, Squarespace, Google Tag Manager or plain HTML — and we tell you the moment we can see it working, so you are never left wondering.',
      'Usually a few minutes.',
    ],
    [
      'Write down your usual answers',
      'Delivery times, returns, opening hours, the thing everyone asks about sizing. Paste them in as plain sentences. That is what the assistant answers from — nothing else.',
      'Start with five. You can add more any time.',
    ],
    [
      'Step in whenever you like',
      'Every conversation lands in one shared inbox for you and your team, on your computer and on your phone. Join mid-conversation and carry on; the visitor sees one continuous chat.',
      'You are never locked out of your own conversation.',
    ],
  ];

  return (
    <Band>
      <SectionHeading
        eyebrow="Getting started"
        title="Three steps, and none of them are technical"
        lead="You do not need a developer, and you do not need to change anything about your website."
      />
      <ol className="grid gap-5 md:grid-cols-3">
        {steps.map(([title, body, note], index) => (
          <li key={title} className="bg-white rounded-3xl border border-gray-100 p-6">
            <span className="w-9 h-9 rounded-2xl bg-blue-600 text-white font-display text-lg flex items-center justify-center">
              {index + 1}
            </span>
            <h3 className="mt-4 font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>
            <p className="mt-3 text-xs text-gray-400">{note}</p>
          </li>
        ))}
      </ol>
    </Band>
  );
}

function Benefits() {
  const items: [typeof MessageSquare, string, string][] = [
    [
      BellRing,
      'Nothing gets missed',
      'Away from your desk? Your phone buzzes. Closed for the night? The chat takes a message and an email address, and it is waiting for you in the morning instead of gone.',
    ],
    [
      Eye,
      'See who is on your site',
      'Who is reading right now, which page they are on, where they came from. If somebody has been staring at your checkout for two minutes, you can say hello first.',
    ],
    [
      Users,
      'Your whole team, one inbox',
      'Assign a conversation, leave a note only your team can see, save the replies you type constantly. Nobody answers the same person twice.',
    ],
    [
      Brush,
      'It looks like you, not like us',
      'Your colour, your wording, your rounded corners, your name at the top. You see the real thing change as you edit it — no guessing and republishing.',
    ],
    [
      Smartphone,
      'Answer from your phone',
      'Install it like an app and get a notification when somebody writes. Reply from a queue, a train, or the sofa.',
    ],
    [
      Clock,
      'Say what is true when you are closed',
      'Set your hours once. Outside them the chat is honest about it and offers to take a message, rather than showing a hopeful green dot nobody is behind.',
    ],
  ];

  return (
    <Band tone="cream">
      <SectionHeading
        eyebrow="What you get"
        title="The things that actually make chat work"
        lead="Not a feature list for its own sake — these are the parts that decide whether chat is useful or just another thing to check."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([Icon, title, body]) => (
          <div key={title} className="bg-white rounded-3xl border border-gray-100 p-6">
            <span className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-700 flex items-center justify-center">
              <Icon className="w-5 h-5" aria-hidden />
            </span>
            <h3 className="mt-4 font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </Band>
  );
}

function AboutTheAI() {
  const rules: [string, string][] = [
    [
      'It only uses your answers',
      'The assistant replies from the notes you wrote and the details your own system tells us about the customer. It has no opinion about your refund policy that you did not give it.',
    ],
    [
      'It hands over rather than guesses',
      'Order status, prices, dates, refunds, anything about someone’s account — if it is not sure, it says a person will pick this up, and one of you gets a notification. It does not invent a delivery date to be helpful.',
    ],
    [
      'You decide when it speaks',
      'Only the first message, only when nobody is online, always, or never. Change your mind on a Tuesday and it changes on that Tuesday.',
    ],
    [
      'You see every word it said',
      'Its replies sit in the same conversation as yours, clearly marked. Nothing happens in a place you cannot read.',
    ],
  ];

  return (
    <Band tone="ink">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-blue-200">
            <Sparkles className="w-3.5 h-3.5" aria-hidden />
            The assistant
          </span>
          <h2 className="font-display text-3xl sm:text-4xl mt-4 text-white text-balance">
            An assistant you can leave alone with your customers
          </h2>
          <p className="mt-4 text-gray-300 leading-relaxed">
            The worry with automated replies is not that they are unhelpful. It is that one
            day one of them will confidently tell a customer something untrue, and you will
            find out from the customer.
          </p>
          <p className="mt-3 text-gray-300 leading-relaxed">
            So ours is built to stop. It answers what you taught it and refuses the rest —
            which is less impressive in a demo and considerably better on a Tuesday.
          </p>
        </div>

        <ul className="space-y-3">
          {rules.map(([title, body]) => (
            <li key={title} className="rounded-2xl bg-white/5 border border-white/10 p-5">
              <p className="font-semibold text-white flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-300 shrink-0" aria-hidden />
                {title}
              </p>
              <p className="mt-1.5 text-sm text-gray-300 leading-relaxed pl-6">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

function WhoItsFor() {
  const cases: [string, string, string[]][] = [
    [
      'Online shops',
      'Most questions before a purchase are about delivery, sizing and returns — and every one you answer quickly is a basket that gets finished.',
      ['Answer delivery questions instantly', 'Catch people hesitating at checkout', 'Take orders out of your email'],
    ],
    [
      'Software and services',
      'Someone evaluating you at 9pm has a question your pricing page did not answer. Being there is most of the sale.',
      ['Help during a trial, in the product', 'See which page the question came from', 'Route billing questions to the right person'],
    ],
    [
      'Clinics, studios and local businesses',
      'Bookings, hours, directions, what to bring. The same handful of questions, all day, from people who will phone if you make them.',
      ['Answer the repeat questions automatically', 'Take a message when you are closed', 'Reply from your phone between clients'],
    ],
  ];

  return (
    <Band>
      <SectionHeading
        eyebrow="Who uses it"
        title="Built for businesses without a support department"
        lead="If answering customers is something you fit around your actual job, this is aimed squarely at you."
      />
      <div className="grid gap-4 md:grid-cols-3">
        {cases.map(([title, body, bullets]) => (
          <div key={title} className="bg-white rounded-3xl border border-gray-100 p-6 flex flex-col">
            <h3 className="font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed flex-1">{body}</p>
            <ul className="mt-4 space-y-1.5">
              {bullets.map((bullet) => (
                <li key={bullet} className="flex items-start gap-2 text-xs text-gray-600">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" aria-hidden />
                  {bullet}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Band>
  );
}

function Faq() {
  // Shared with the FAQPage structured data in seo.ts — see faqs.ts for why one array.
  const faqs = FAQS;

  return (
    <Band tone="cream">
      <SectionHeading
        eyebrow="Questions"
        title="The things people ask before signing up"
        lead="If yours is not here, open the chat in the corner — that is us, using our own product."
      />
      <div className="max-w-3xl mx-auto space-y-3">
        {faqs.map(([question, answer]) => (
          <details
            key={question}
            className="group bg-white rounded-2xl border border-gray-100 px-5 py-4"
          >
            <summary className="flex items-center justify-between gap-4 cursor-pointer list-none font-semibold text-gray-800">
              {question}
              <span className="text-gray-400 group-open:rotate-45 transition-transform text-xl leading-none">
                +
              </span>
            </summary>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">{answer}</p>
          </details>
        ))}
      </div>
    </Band>
  );
}

function Closing() {
  return (
    <Band>
      <div className="text-center max-w-2xl mx-auto">
        <span className="inline-flex w-12 h-12 rounded-2xl bg-blue-600 text-white items-center justify-center mb-5">
          <MessageSquare className="w-6 h-6" aria-hidden />
        </span>
        <h2 className="font-display text-3xl sm:text-4xl text-balance">
          Be there for the next person with a question
        </h2>
        <p className="mt-3 text-lg text-gray-600">
          Fourteen days, everything switched on, no card. If it is not for you, close the tab
          and nothing happens.
        </p>
        <div className="mt-8">
          <PrimaryCta
            label="Start free for 14 days"
            sub="Set up in a few minutes · Works with the website you already have"
          />
        </div>
      </div>
    </Band>
  );
}
