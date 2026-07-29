import { AlertTriangle, Clock } from 'lucide-react';

/**
 * How long is left, and what that should look like.
 *
 * One module because the countdown appears on a conversation row, in the thread header
 * and in the escalation banner, and those three disagreeing about whether something is
 * late would be worse than not showing it at all.
 *
 * The tone thresholds are the design decision. "Overdue" in red is obvious; the useful
 * part is the amber band BEFORE the deadline, because a queue that only turns red once
 * you have already failed is a queue of failures rather than a warning.
 */

/** Amber from here on: close enough to act, far enough that acting still helps. */
const AT_RISK_MS = 15 * 60_000;

export type DueTone = 'overdue' | 'at_risk' | 'ok';

export function dueTone(dueAt: string | null, now = Date.now()): DueTone | null {
  if (!dueAt) return null;
  const remaining = new Date(dueAt).getTime() - now;
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return 'overdue';
  if (remaining <= AT_RISK_MS) return 'at_risk';
  return 'ok';
}

/**
 * "4m left", "2h 10m left", "12m overdue".
 *
 * Minutes, never seconds. A deadline ticking down by the second turns a work queue into
 * a slot machine, and nothing an agent can do resolves in under a minute anyway.
 */
export function dueLabel(dueAt: string | null, now = Date.now()): string | null {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - now;
  if (Number.isNaN(ms)) return null;
  const overdue = ms < 0;
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const text =
    minutes < 60
      ? `${minutes}m`
      : minutes < 60 * 24
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / (60 * 24))}d`;
  return overdue ? `${text} overdue` : `${text} left`;
}

const TONES: Record<DueTone, string> = {
  overdue: 'bg-red-50 text-red-700',
  at_risk: 'bg-amber-50 text-amber-800',
  ok: 'bg-gray-100 text-gray-500',
};

export function DueBadge({
  dueAt,
  breachedAt,
  now = Date.now(),
  size = 'sm',
}: {
  dueAt: string | null;
  /** A past breach still shows once the deadline itself is gone — see below. */
  breachedAt?: string | null;
  now?: number;
  size?: 'xs' | 'sm';
}) {
  const tone = dueTone(dueAt, now);

  // Answered late: the deadline has been cleared but the failure has not. Showing it
  // is the point — a breach that disappears the moment somebody replies is a breach
  // nobody learns from, which is the complaint this whole feature answers.
  if (!tone) {
    if (!breachedAt) return null;
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full font-medium bg-red-50 text-red-700 ${
          size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
        }`}
        title={`Response time was missed on ${new Date(breachedAt).toLocaleString()}`}
      >
        <AlertTriangle className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden />
        missed
      </span>
    );
  }

  // 'ok' is not badged. A countdown on every waiting conversation is noise, and noise
  // is exactly what stops an agent noticing the two that matter.
  if (tone === 'ok') return null;

  const Icon = tone === 'overdue' ? AlertTriangle : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${TONES[tone]} ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      }`}
      title={`Due ${new Date(dueAt!).toLocaleString()}`}
    >
      <Icon className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden />
      {dueLabel(dueAt, now)}
    </span>
  );
}
