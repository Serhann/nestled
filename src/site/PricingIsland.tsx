import { useEffect, useState } from 'react';
import { ORIGINS } from '../lib/origins';
import type { Plan } from '../lib/api/billing';

/**
 * The only interactive part of the marketing site.
 *
 * It reads `/api/v1/plans` — the same rows the in-app picker reads — so the price
 * on the marketing page and the price at checkout cannot drift apart. A hardcoded
 * table here is a table that is wrong the first time someone edits a plan.
 */
export function PricingIsland() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/v1/plans')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { plans: Plan[] }) => setPlans(data.plans))
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <p className="text-center text-sm text-gray-500">
        We could not load current pricing.{' '}
        <a href={`${ORIGINS.app}/signup`} className="font-semibold text-blue-700 hover:underline">
          Start a free trial
        </a>{' '}
        and you will see it in the app.
      </p>
    );
  }

  if (!plans) {
    // Prerendered, and therefore the state a crawler and a slow connection see.
    // Three empty pulsing boxes would waste the whole point of rendering this page
    // ahead of time, so the shape and the tiers are here in words. Only the prices
    // are held back, because those must come from the same rows checkout charges
    // from — a number hardcoded here is a number that is wrong the first time
    // somebody edits a plan.
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {[
          ['Starter', 'For one person answering their own customers.'],
          ['Pro', 'For a small team sharing an inbox.'],
          ['Business', 'For several websites and a bigger team.'],
        ].map(([name, who]) => (
          <div key={name} className="rounded-3xl border border-gray-200 bg-white p-6">
            <p className="font-semibold text-gray-800">{name}</p>
            <p className="mt-2 text-sm text-gray-500">{who}</p>
            <p className="mt-6 text-sm text-gray-400">Loading today’s prices…</p>
            <a
              href={`${ORIGINS.app}/signup`}
              className="mt-6 block text-center bg-blue-600 text-white rounded-full px-4 py-2.5 text-sm font-semibold hover:bg-blue-700 transition"
            >
              Start free
            </a>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-center mb-6">
        <div className="flex rounded-full bg-gray-100 p-0.5 text-sm font-semibold">
          <button
            onClick={() => setInterval('month')}
            className={`rounded-full px-4 py-1.5 ${interval === 'month' ? 'bg-white shadow-sm' : 'text-gray-500'}`}
          >
            Monthly
          </button>
          <button
            onClick={() => setInterval('year')}
            className={`rounded-full px-4 py-1.5 ${interval === 'year' ? 'bg-white shadow-sm' : 'text-gray-500'}`}
          >
            Yearly
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const price = interval === 'year' ? plan.price_yearly_cents : plan.price_monthly_cents;
          return (
            <div key={plan.code} className="rounded-3xl border border-gray-200 bg-white p-6 flex flex-col">
              <p className="font-semibold text-gray-800">{plan.name}</p>
              <p className="mt-2">
                <span className="font-display text-3xl">
                  {price === 0 ? 'Free' : `$${(price / 100).toFixed(0)}`}
                </span>
                {price > 0 && (
                  <span className="text-xs text-gray-500"> /{interval === 'year' ? 'yr' : 'mo'}</span>
                )}
              </p>
              <ul className="mt-4 space-y-1.5 text-xs text-gray-600 flex-1">
                <li>{plan.limits.seats} seat{plan.limits.seats === 1 ? '' : 's'}</li>
                <li>{plan.limits.websites} website{plan.limits.websites === 1 ? '' : 's'}</li>
                <li>{plan.limits.conversations_month.toLocaleString()} conversations a month</li>
                <li>{plan.limits.ai_replies_month.toLocaleString()} AI replies a month</li>
                {plan.features.bot && <li>Bot flows</li>}
                {plan.features.live_view && <li>Live view</li>}
                {plan.features.remove_branding && <li>No Nestled branding</li>}
              </ul>
              <a
                href={`${ORIGINS.app}/signup`}
                className="mt-5 text-center bg-blue-600 text-white rounded-full px-4 py-2.5 text-sm font-semibold hover:bg-blue-700 transition"
              >
                Start free
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
