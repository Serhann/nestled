import { lazy, Suspense, useEffect, useState } from 'react';
import { useRealtime } from '../../providers/RealtimeProvider';
import { useSession } from '../../providers/SessionProvider';
import type { PresenceVisitor } from '../../../lib/api/types';

/**
 * rrweb and the replayer are a large dependency and only a fraction of accounts
 * have live view at all, so the viewer is split out of the main bundle and only
 * fetched when an agent actually clicks Watch.
 */
const LiveView = lazy(() => import('./LiveView').then((m) => ({ default: m.LiveView })));

/**
 * Watching a visitor's screen.
 *
 * The server only starts buffering rrweb frames for a visitor once an agent is
 * actually watching — buffering everyone continuously is how a single process runs
 * out of memory — so the `watch` control frame is what turns the recording on, and
 * unwatching turns it off again.
 *
 * Its own file because two places open it: the visitor board, and a conversation in
 * the inbox. The inbox is the one that matters — that is where you are when somebody
 * says "it just doesn't work", which is the entire reason this feature exists.
 */
export function LiveViewer({
  visitor,
  onClose,
}: {
  visitor: PresenceVisitor;
  onClose: () => void;
}) {
  const realtime = useRealtime();
  const { me } = useSession();
  const [feed, setFeed] = useState<{
    visitorId: string;
    events: unknown[];
    reset: boolean;
    nonce: number;
  } | null>(null);

  useEffect(() => {
    let nonce = 0;
    realtime.onReplay((events) => {
      nonce += 1;
      setFeed({ visitorId: visitor.visitor_id, events, reset: nonce === 1, nonce });
    });
    realtime.watch(visitor.website_id, visitor.visitor_id);
    return () => {
      realtime.unwatch();
      realtime.onReplay(null);
    };
  }, [realtime, visitor.website_id, visitor.visitor_id]);

  return (
    <Suspense fallback={null}>
      <LiveView
        feed={feed}
        visitor={visitor}
        agentName={me.user.name}
        onClose={onClose}
        onAssist={(payload) => realtime.assist(visitor.website_id, visitor.visitor_id, payload)}
      />
    </Suspense>
  );
}
