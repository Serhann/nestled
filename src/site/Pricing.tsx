import { CheckCircle2 } from 'lucide-react';
import { Band, SectionHeading } from './Shell';
import { PricingIsland } from './PricingIsland';

/**
 * Pricing.
 *
 * The table itself is the one interactive part of the marketing site: it is
 * rendered here in its pre-fetch state and hydrates to read the live plan
 * catalog, so what this page says a plan costs and what checkout charges cannot
 * drift apart.
 *
 * Everything around it is here to answer the questions that stop somebody
 * choosing — what a seat is, what happens if they go over, what happens when the
 * trial ends — because those are the reasons a pricing page fails.
 */
export function Pricing() {
  return (
    <>
      <section className="bg-canvas">
        <div className="max-w-6xl mx-auto px-5 pt-16 pb-8 sm:pt-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Pricing</p>
          <h1 className="font-display text-4xl sm:text-5xl mt-3 text-balance">Pay for the seats you use</h1>
          <p className="mt-4 text-lg text-gray-600 max-w-xl mx-auto">
            Fourteen days free with everything switched on, and no card until you decide.
          </p>
        </div>
      </section>

      <section className="bg-canvas">
        <div className="max-w-6xl mx-auto px-5 pb-16">
          <div data-island="pricing">
            <PricingIsland />
          </div>
        </div>
      </section>

      <Band tone="cream">
        <SectionHeading
          eyebrow="The small print, in plain words"
          title="What these numbers actually mean"
        />
        <div className="grid gap-4 sm:grid-cols-2 max-w-4xl mx-auto">
          {(
            [
              [
                'A seat is a person who answers',
                'Anyone who replies to customers needs one. Your visitors are never counted or charged for, however many there are.',
              ],
              [
                'A conversation is one customer, once',
                'Not a message. A person writing four times over an afternoon is one conversation, and it stays one if they come back tomorrow to the same thread.',
              ],
              [
                'Going over does not switch you off',
                'We will tell you and ask you to move up a plan. We will not take a live chat off a working website in the middle of a busy month — that would punish you for the thing you are paying us for.',
              ],
              [
                'The trial ends gently',
                'When the fourteen days are up your chat keeps running for another week while you decide. Nothing is deleted, and picking a plan puts everything back exactly as it was.',
              ],
              [
                'Change or cancel yourself',
                'Move up, move down or stop from the billing page. No email to anyone, no retention call. Downgrading tells you first if something will not fit.',
              ],
              [
                'Yearly is cheaper',
                'Same product, one invoice. Switch between monthly and yearly whenever it suits you.',
              ],
            ] as [string, string][]
          ).map(([title, body]) => (
            <div key={title} className="bg-white rounded-2xl border border-gray-100 p-5">
              <p className="font-semibold text-gray-900 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-1" aria-hidden />
                {title}
              </p>
              <p className="mt-1.5 text-sm text-gray-600 leading-relaxed pl-6">{body}</p>
            </div>
          ))}
        </div>
      </Band>
    </>
  );
}
