import type { ReactNode } from 'react';
import { TONE_CLASS, type Tone } from './tone';

/**
 * The panel's entire component vocabulary, written locally.
 *
 * `src/ui/` is being rewritten for the customer app and is not imported here — but
 * the better reason is that this surface wants a different visual register. The ops
 * panel is a dark, dense, boring instrument that staff stare at all day; the
 * customer app is a warm, spacious product. Sharing primitives would force one of
 * those two to compromise, and it would be this one.
 */

export function Card({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-700 bg-gray-800/40">
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-gray-700 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'default',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
  const variants = {
    default: 'bg-gray-700 text-gray-100 hover:bg-gray-600',
    primary: 'bg-blue-600 text-white hover:bg-blue-500',
    danger: 'bg-red-600/80 text-white hover:bg-red-500',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500';

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-700 text-xs uppercase tracking-wide text-gray-500">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top text-gray-200 ${className}`}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-gray-500">{children}</p>;
}

export function Spinner() {
  return (
    <div className="flex justify-center py-8" role="status" aria-label="Loading">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
    </div>
  );
}

/**
 * Errors are shown, never swallowed. On a panel whose job is to answer questions
 * about customers, a silently empty table is worse than a red box: it reads as
 * "this customer has nothing" rather than "we failed to ask".
 */
export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{message}</div>
  );
}

/** A label/value pair. The overview tabs are almost entirely made of these. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-gray-100">
        {tone ? <Badge tone={tone}>{value}</Badge> : value}
      </div>
    </div>
  );
}

/**
 * A usage bar. Over 100% is drawn deliberately: a customer at 140% of a soft limit
 * is the most interesting row on the page, and a bar clamped to full hides exactly
 * that.
 */
export function Meter({ used, limit }: { used: number; limit: number }) {
  const unlimited = limit <= 0;
  const ratio = unlimited ? 0 : used / limit;
  const width = Math.min(100, ratio * 100);
  const tone = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-400' : 'bg-blue-500';
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400">
        <span>{used.toLocaleString()}</span>
        <span>{unlimited ? 'unlimited' : limit.toLocaleString()}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-700">
        {!unlimited && <div className={`h-full ${tone}`} style={{ width: `${width}%` }} />}
      </div>
      {ratio > 1 && <div className="mt-1 text-xs text-red-300">{Math.round(ratio * 100)}% of the allowance</div>}
    </div>
  );
}

/** A modal. Used only where an action needs a typed reason before it can proceed. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-gray-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
