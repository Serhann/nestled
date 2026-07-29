import type { ReactNode } from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { Card } from './Card';

/** Scrollable page shell on the warm canvas, centred to a comfortable width. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex-1 overflow-y-auto bg-canvas">
      <div className={`${wide ? 'max-w-6xl' : 'max-w-4xl'} mx-auto p-4 sm:p-6 lg:p-8 space-y-6`}>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5" />
            </span>
          )}
          <h1 className="font-display text-3xl sm:text-[2rem] leading-none text-gray-800 truncate">
            {title}
          </h1>
        </div>
        {subtitle && <p className="text-sm text-gray-500 mt-1.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="p-10 flex flex-col items-center text-center">
      <span className="w-14 h-14 rounded-3xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7" />
      </span>
      <p className="font-semibold text-gray-800">{title}</p>
      {hint && <p className="text-sm text-gray-500 mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-gray-400" role="status">
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * What a screen shows when the API said no.
 *
 * A failed request has to look different from an empty list. Rendering "no
 * conversations yet" over a 500 is how a customer concludes the product lost
 * their data.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <Card className="p-8 text-center">
      <p className="font-semibold text-gray-800">That didn’t load</p>
      <p className="text-sm text-gray-500 mt-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 text-sm font-semibold text-blue-700 hover:underline"
        >
          Try again
        </button>
      )}
    </Card>
  );
}
