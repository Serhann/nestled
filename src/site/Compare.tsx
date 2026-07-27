import { Check, Minus, ThumbsDown, X } from 'lucide-react';
import { Band, PrimaryCta, SectionHeading } from './Shell';
import { COMPETITORS, ROWS, SOURCES, TRADEOFFS, VERIFIED_ON, type Cell } from './comparison';

/**
 * How Nestled compares.
 *
 * A buyer has already typed "Crisp alternative" into a search box, so pretending
 * the alternatives do not exist helps nobody. Three rules make this page worth
 * having rather than embarrassing:
 *
 *   - **Every claim about us is checkable in this repository.** Most of the
 *     numbers in our column come straight out of the `plans` seed. No
 *     aspirational rows.
 *   - **Every claim about anybody else came off their own page,** on the date
 *     printed under the table. Cells nobody could confirm stay as a dash. See the
 *     header of comparison.ts before editing.
 *   - **Anything from a review site is worded as a report and linked** — "buyers
 *     say X" with nowhere to check is just us saying X.
 *
 * Each competitor also gets a paragraph naming what they are genuinely better at,
 * which is not politeness. A page that grants nothing reads as a page that has
 * not looked, and the section on when NOT to choose us is what earns the rest.
 */
export function Compare() {
  return (
    <>
      <section className="bg-canvas">
        <div className="max-w-6xl mx-auto px-5 pt-16 pb-10 sm:pt-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">
            Comparison
          </p>
          <h1 className="font-display text-4xl sm:text-5xl mt-3 text-balance">
            How Nestled compares
          </h1>
          <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto text-pretty">
            Crisp, Intercom and Tidio are all good products, and any of them may suit you
            better than we do. Here is what we chose differently and why, so you can tell
            quickly whether we are the right shape for your business.
          </p>
        </div>
      </section>

      <Choices />
      <Table />
      <Tradeoffs />
      <NotForYou />

      <Band>
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="font-display text-3xl sm:text-4xl text-balance">
            The only comparison that settles it is your own website
          </h2>
          <p className="mt-3 text-lg text-gray-600">
            Fourteen days, everything switched on, no card. Put it on your site next to
            whatever you are using now and see which one your customers actually reach for.
          </p>
          <div className="mt-8">
            <PrimaryCta label="Start free for 14 days" />
          </div>
        </div>
      </Band>
    </>
  );
}

function Choices() {
  const choices: [string, string, string][] = [
    [
      'You pay for people, not popularity',
      'Chat tools attach the price to all sorts of things: conversations you answered, contacts you stored, AI questions that got resolved. Each of those means a good month — a launch, a mention, a busy December — arrives as a bigger invoice.',
      'We charge for the seats of the people answering. However many visitors you get, the price does not move.',
    ],
    [
      'Going over a limit never takes your chat down',
      'When a cap is the thing being sold, hitting it stops the feature. On a live website that is not a nudge to upgrade, it is a broken page and a lost customer, in your busiest week.',
      'Over your conversation allowance we tell you and keep serving. The only hard stop is on AI replies, where each one costs real money — and even then it falls back to your written answers and then to a person.',
    ],
    [
      'An assistant that refuses rather than guesses',
      'The risk with automated replies is not a bad answer. It is one confident wrong answer about somebody’s order, and finding out from the customer.',
      'Ours answers from your own written material and from details your own server signed. Orders, prices, dates, policies it was not given go to a person, and it says so.',
    ],
    [
      'Every word your visitors read is yours',
      'Most chat tools let you change the greeting and hard-code the rest. The apology when nobody is around, the button on a form, the line asking for a rating — all of it is the vendor’s voice on your website.',
      'Every visitor-facing string is a field in your settings, next to a live preview of the real widget. We store only what you changed, so improvements to the defaults still reach you. What you do not get is a stylesheet: colours, radius, font and copy, not arbitrary CSS.',
    ],
    [
      'Our own access to your account is on your record',
      'Vendor support usually reaches your data through a door you cannot see.',
      'Ours needs a written reason, expires in half an hour, cannot touch your billing, your team or your keys — and every action lands in your own audit log, labelled as ours.',
    ],
  ];

  return (
    <Band tone="cream">
      <SectionHeading
        eyebrow="What we chose differently"
        title="Five decisions that shape the whole product"
        lead="Each of these has a cost, and the cost is named. That is what makes them decisions rather than marketing."
      />
      <div className="space-y-4 max-w-4xl mx-auto">
        {choices.map(([title, problem, ours]) => (
          <div key={title} className="bg-white rounded-3xl border border-gray-100 p-6 sm:p-7">
            <h3 className="font-semibold text-lg text-gray-900">{title}</h3>
            <p className="mt-3 text-sm text-gray-500 leading-relaxed">{problem}</p>
            <p className="mt-3 text-sm text-gray-800 leading-relaxed flex gap-2">
              <Check className="w-4 h-4 text-green-600 shrink-0 mt-0.5" aria-hidden />
              <span>{ours}</span>
            </p>
          </div>
        ))}
      </div>
    </Band>
  );
}

function Table() {
  const unverified = COMPETITORS.filter((c) => !c.verifiedOn);

  return (
    <Band>
      <SectionHeading
        eyebrow="Side by side"
        title="The rows a buyer actually asks about"
        lead="Everything in the Nestled column is checkable in the product today."
      />

      {unverified.length > 0 && (
        <div
          role="note"
          className="max-w-4xl mx-auto mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900"
        >
          <p className="font-semibold">
            The other columns have not been checked{unverified.length < COMPETITORS.length ? ' for every product' : ''}.
          </p>
          <p className="mt-1 leading-relaxed">
            We will not put a guess about somebody else&rsquo;s product in a table and call it a
            comparison — their pricing and features change monthly, and one wrong cell is
            enough to make a reader doubt every other one. Check them yourself:{' '}
            {unverified.map((c, i) => (
              <span key={c.name}>
                {i > 0 && ', '}
                <a href={c.url} className="font-semibold underline" rel="nofollow noreferrer">
                  {c.name}
                </a>
              </span>
            ))}
            .
          </p>
        </div>
      )}

      <div className="max-w-5xl mx-auto overflow-x-auto">
        <table className="w-full min-w-[42rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="text-left font-semibold text-gray-500 px-4 py-3 w-[38%]">
                <span className="sr-only">Capability</span>
              </th>
              <th className="px-4 py-3 text-center">
                <span className="inline-flex flex-col items-center gap-1">
                  <span className="font-display text-lg text-gray-900">Nestled</span>
                  <span className="text-[11px] font-normal text-green-700">
                    checkable in the product
                  </span>
                </span>
              </th>
              {COMPETITORS.map((competitor) => (
                <th key={competitor.name} className="px-4 py-3 text-center">
                  <span className="inline-flex flex-col items-center gap-1">
                    <a
                      href={competitor.url}
                      rel="nofollow noreferrer"
                      className="font-semibold text-gray-700 hover:underline"
                    >
                      {competitor.name}
                    </a>
                    <span className="text-[11px] font-normal text-gray-400">
                      {competitor.verifiedOn
                        ? `checked ${competitor.verifiedOn}`
                        : 'not checked yet'}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, index) => (
              <tr key={row.label} className={index % 2 === 0 ? 'bg-white' : ''}>
                <th scope="row" className="text-left align-top px-4 py-4 font-normal">
                  <span className="font-semibold text-gray-800">{row.label}</span>
                  {row.detail && (
                    <span className="block text-xs text-gray-500 mt-1 leading-relaxed">
                      {row.detail}
                    </span>
                  )}
                </th>
                <td className="px-4 py-4 text-center align-top">
                  <CellValue value={row.nestled} highlight />
                </td>
                {COMPETITORS.map((competitor) => (
                  <td key={competitor.name} className="px-4 py-4 text-center align-top">
                    <CellValue value={row.others[competitor.name] ?? 'unknown'} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        Small print, and small on purpose — but present on purpose too. Everything
        in the competitor columns was read off the vendor's own page on one day,
        and those pages change. Printing the date and the links is what separates a
        comparison a reader can check from one they have to take on faith.
      */}
      <p className="max-w-5xl mx-auto mt-6 px-4 text-[11px] leading-relaxed text-gray-400">
        Competitor columns reflect each vendor’s own published pricing and documentation as read
        on {VERIFIED_ON}; their plans and features change, so check the current page before you
        decide. Prices exclude tax and are shown at each vendor’s advertised rate — some are
        annual-billing rates that are higher month to month. Sources:{' '}
        {SOURCES.map((source, i) => (
          <span key={source.url}>
            {i > 0 && ' · '}
            <a href={source.url} className="underline hover:text-gray-600" rel="nofollow noreferrer">
              {source.label}
            </a>
          </span>
        ))}
        . Spotted something out of date?{' '}
        <a href="mailto:hello@nestled.chat" className="underline hover:text-gray-600">
          Tell us
        </a>{' '}
        and we will correct it.
      </p>
    </Band>
  );
}

function Tradeoffs() {
  return (
    <Band tone="cream">
      <SectionHeading
        eyebrow="The other three, fairly"
        title="What each of them is better at, and what their pricing costs you"
        lead="Read this part especially if you are already using one of them. Everything below is from their own pricing and help pages; where we quote review coverage instead, it says so and links out."
      />
      <div className="space-y-4 max-w-4xl mx-auto">
        {TRADEOFFS.map((tradeoff) => (
          <div
            key={tradeoff.competitor}
            className="bg-white rounded-3xl border border-gray-100 p-6 sm:p-7"
          >
            <h3 className="font-display text-2xl text-gray-900">{tradeoff.competitor}</h3>
            <p className="mt-3 text-sm text-gray-700 leading-relaxed">{tradeoff.strength}</p>

            <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-gray-400">
              What it costs you
            </p>
            <ul className="mt-2 space-y-2">
              {tradeoff.costs.map((cost) => (
                <li key={cost} className="flex gap-2 text-sm text-gray-600 leading-relaxed">
                  <span className="text-gray-300 select-none" aria-hidden>
                    —
                  </span>
                  <span>{cost}</span>
                </li>
              ))}
            </ul>

            {tradeoff.reported && (
              <p className="mt-4 text-xs text-gray-500 leading-relaxed border-t border-gray-100 pt-4">
                {tradeoff.reported.text}{' '}
                <a
                  href={tradeoff.reported.url}
                  className="underline hover:text-gray-700"
                  rel="nofollow noreferrer"
                >
                  {tradeoff.reported.source}
                </a>
              </p>
            )}
          </div>
        ))}
      </div>
    </Band>
  );
}

function CellValue({ value, highlight }: { value: Cell; highlight?: boolean }) {
  if (value === true) {
    return (
      <span
        className={`inline-flex w-7 h-7 rounded-full items-center justify-center ${
          highlight ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}
      >
        <Check className="w-4 h-4" aria-hidden />
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex w-7 h-7 rounded-full items-center justify-center bg-gray-100 text-gray-400">
        <X className="w-4 h-4" aria-hidden />
        <span className="sr-only">No</span>
      </span>
    );
  }
  if (value === 'unknown') {
    // A dash means we looked and could not confirm it either way — not that the
    // answer is no. Saying so costs a column cell; implying a "no" we did not
    // verify costs the reader's trust in every other cell.
    return (
      <span
        className="inline-flex w-7 h-7 rounded-full items-center justify-center text-gray-300"
        title="We could not confirm this from the vendor’s own documentation"
      >
        <Minus className="w-4 h-4" aria-hidden />
        <span className="sr-only">Not confirmed</span>
      </span>
    );
  }
  if (value === 'n/a') {
    return <span className="text-xs text-gray-400">not comparable</span>;
  }
  return (
    <span className={`text-xs ${highlight ? 'text-gray-800 font-medium' : 'text-gray-600'}`}>
      {value}
    </span>
  );
}

function NotForYou() {
  const cases: [string, string][] = [
    [
      'You need a full help desk',
      'Ticket queues, SLAs, CSAT reporting, a customer portal, email as a first-class channel. Nestled is a chat product with a shared inbox; if your team lives in a ticketing system, buy a ticketing system.',
    ],
    [
      'You want dozens of integrations',
      'There is no marketplace. You can sign customer details from your own server and send notifications to Discord, and that is the extent of it today.',
    ],
    [
      'You want to bring your own AI key',
      'The assistant runs on our infrastructure and is metered per workspace. That keeps it simple and keeps your keys out of our database, but it does mean you cannot point it at your own account or your own model.',
    ],
    [
      'You need phone, WhatsApp or social channels',
      'Chat on your website, and email for what happens after. Nothing else.',
    ],
    [
      'You want to run it on your own servers',
      'Nestled is hosted by us. There is no self-hosted or on-premise edition, and there is not one planned. If running the software yourself is a requirement, an open-source chat platform is the honest answer.',
    ],
  ];

  return (
    <Band tone="ink">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-blue-200">
            <ThumbsDown className="w-3.5 h-3.5" aria-hidden />
            Be honest
          </span>
          <h2 className="font-display text-3xl sm:text-4xl mt-4 text-white text-balance">
            When Nestled is the wrong choice
          </h2>
          <p className="mt-3 text-gray-300 text-pretty">
            Five situations where one of the others is a better answer. Finding this out now
            is cheaper for both of us than finding it out in month three.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {cases.map(([title, body]) => (
            <div key={title} className="rounded-2xl bg-white/5 border border-white/10 p-5">
              <p className="font-semibold text-white">{title}</p>
              <p className="mt-1.5 text-sm text-gray-300 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </Band>
  );
}
