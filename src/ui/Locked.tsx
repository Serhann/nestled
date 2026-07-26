import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from './Card';

/**
 * A feature the current plan does not include.
 *
 * It is rendered, visibly, with the control disabled — not hidden. Hiding a
 * feature sells nothing and teaches the customer the product cannot do it; a
 * locked control tells them exactly what upgrading buys.
 *
 * This is presentation only. Every gated feature is also enforced on the server,
 * which ignores a value it does not allow rather than trusting the client to have
 * rendered the lock.
 */
export function Locked({
  feature,
  children,
  onUpgrade,
}: {
  feature: string;
  children?: ReactNode;
  onUpgrade?: () => void;
}) {
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none opacity-50">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-2 rounded-full bg-white/95 border border-gray-200 shadow-sm px-3.5 py-1.5">
          <Lock className="w-3.5 h-3.5 text-gray-400" aria-hidden />
          <span className="text-xs font-semibold text-gray-600">{feature} is on a higher plan</span>
          {onUpgrade && (
            <button onClick={onUpgrade} className="text-xs font-semibold text-blue-700 hover:underline">
              Upgrade
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a route guard renders when someone types a URL they may not open. */
export function NoAccess({ what = 'this page' }: { what?: string }) {
  return (
    <Card className="p-10 text-center max-w-md mx-auto mt-16">
      <span className="w-14 h-14 rounded-3xl bg-gray-100 text-gray-400 flex items-center justify-center mx-auto mb-4">
        <Lock className="w-7 h-7" aria-hidden />
      </span>
      <p className="font-semibold text-gray-800">You don’t have access to {what}</p>
      <p className="text-sm text-gray-500 mt-1">
        Ask a workspace admin if you think you should. A blank screen would have been the
        alternative, and this is more useful.
      </p>
    </Card>
  );
}
