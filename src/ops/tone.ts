/**
 * The panel's colour vocabulary, in its own module.
 *
 * Split out of ui.tsx so that file exports only components (fast refresh), but the
 * real value is having ONE mapping from a subscription status to a colour. The
 * list, the detail header and the dunning worklist all render the same statuses;
 * three inline ternaries would eventually disagree about whether `trial_expired` is
 * a warning or a failure, and a status that looks different in two places is a
 * status nobody trusts.
 */

export type Tone = 'neutral' | 'ok' | 'warn' | 'fail' | 'accent';

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-gray-700/60 text-gray-200 ring-gray-600',
  ok: 'bg-green-700/25 text-green-200 ring-green-600/50',
  warn: 'bg-amber-500/15 text-amber-200 ring-amber-500/40',
  fail: 'bg-red-500/15 text-red-200 ring-red-500/40',
  accent: 'bg-blue-600/20 text-blue-200 ring-blue-500/40',
};

export function statusTone(status: string): Tone {
  if (status === 'active') return 'ok';
  if (status === 'trialing') return 'accent';
  if (status === 'past_due' || status === 'unpaid' || status === 'trial_expired') return 'warn';
  if (status === 'canceled' || status === 'suspended') return 'fail';
  return 'neutral';
}
