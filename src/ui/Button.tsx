import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Buttons.
 *
 * `busy` is a first-class prop rather than something each caller reimplements: a
 * save button that stays clickable while the request is in flight is how you get
 * duplicate invites and double-charged upgrades.
 */

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition ' +
  'active:scale-[.98] disabled:opacity-60 disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';

const variants: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white shadow-sm hover:bg-blue-700',
  ghost: 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50',
  danger: 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
  subtle: 'text-gray-600 hover:bg-gray-100',
};

const sizes = {
  sm: 'px-3.5 py-1.5 text-[13px]',
  md: 'px-5 py-2.5',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof sizes;
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** A round icon-only button. `label` is required — it becomes the accessible name. */
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${className}`}
    >
      {children}
    </button>
  );
}
