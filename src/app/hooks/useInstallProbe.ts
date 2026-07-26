import { useQuery } from '@tanstack/react-query';
import { installStatus } from '../../lib/api/workspace';
import { qk } from '../../lib/queryKeys';
import type { InstallStatus } from '../../lib/api/types';

/**
 * "Did my snippet work?"
 *
 * This is the highest-anxiety moment in signing up for a chat product: the
 * customer has pasted a script into their site and is staring at our page waiting
 * for something to happen. Getting this wrong — showing nothing, or showing a
 * spinner forever — is how a trial ends before the first conversation.
 *
 * Two delivery paths, and both are needed:
 *
 * - **Push.** The server publishes `website:install_progress` the moment it sees
 *   the widget boot, and RealtimeProvider patches this query's cache. That is the
 *   fast path and usually the only one that fires.
 *
 * - **Poll.** The customer is editing their site in another tab, so ours is
 *   backgrounded — and a backgrounded tab's WebSocket can be frozen by the
 *   browser. Polling every 3 seconds for two minutes, then every 10, is the
 *   fallback that makes the fast path safe to rely on.
 *
 * Polling stops once the answer can no longer change.
 */

const FAST_INTERVAL_MS = 3_000;
const SLOW_INTERVAL_MS = 10_000;
const FAST_WINDOW_MS = 120_000;

export function useInstallProbe(
  workspaceId: string,
  websiteId: string | null,
  opts: { enabled?: boolean } = {},
) {
  const startedAt = useStartTime(websiteId);

  return useQuery<InstallStatus>({
    queryKey: qk.installStatus(workspaceId, websiteId ?? 'none'),
    queryFn: () => installStatus(workspaceId, websiteId!),
    enabled: Boolean(websiteId) && opts.enabled !== false,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      // A received message is terminal: there is nothing further to detect.
      if (phase === 'message_received') return false;
      return Date.now() - startedAt < FAST_WINDOW_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    },
    // Keep polling while the tab is in the background — that is precisely when the
    // customer is on their own site pasting the snippet.
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
}

/** When this website's probe started, so the poll can slow down after a while. */
const startTimes = new Map<string, number>();
function useStartTime(websiteId: string | null): number {
  if (!websiteId) return Date.now();
  let value = startTimes.get(websiteId);
  if (!value) {
    value = Date.now();
    startTimes.set(websiteId, value);
  }
  return value;
}

/** How long we have been waiting with nothing at all — drives the help accordion. */
export function stalled(status: InstallStatus | undefined, sinceMs: number): boolean {
  return (!status || status.phase === 'waiting') && sinceMs > 90_000;
}
