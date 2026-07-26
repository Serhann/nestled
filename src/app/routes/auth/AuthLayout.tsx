import type { ReactNode } from 'react';

/**
 * The frame every unauthenticated screen shares.
 *
 * Deliberately plain. This is the first thing a prospect sees after clicking
 * "start free", and the fastest way to lose them is a sign-up page that takes a
 * beat to paint.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <span className="inline-flex w-11 h-11 rounded-2xl bg-blue-600 text-white font-display text-2xl items-center justify-center mb-3">
            n
          </span>
          <h1 className="font-display text-3xl text-gray-800">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1.5">{subtitle}</p>}
        </div>
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100/80 p-6">{children}</div>
        {footer && <div className="text-center text-sm text-gray-500 mt-5">{footer}</div>}
      </div>
    </div>
  );
}

/** A form-level error. Field-level errors belong on the field. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 mb-4">
      {message}
    </p>
  );
}
