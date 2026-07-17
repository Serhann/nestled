import { useEffect, useRef } from 'react';
import { Replayer } from 'rrweb';
import { X, Eye } from 'lucide-react';
import 'rrweb/dist/rrweb.min.css';

export interface ReplayFeed {
  visitorId: string;
  events: unknown[];
  reset: boolean;
  nonce: number;
}

/**
 * Live session replay (MagicBrowse). The visitor's host page is recorded by
 * rrweb and streamed to the server; this modal replays it live via
 * rrweb.Replayer in liveMode. Events arrive as `feed` batches from the agent WS
 * (a `reset` batch is the buffered snapshot when watching starts).
 */
export function MagicBrowse({ feed, onClose }: { feed: ReplayFeed | null; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const accRef = useRef<{ type: number }[]>([]);

  useEffect(() => {
    if (!feed || !rootRef.current) return;
    const events = feed.events as { type: number }[];

    if (feed.reset) {
      accRef.current = [];
      replayerRef.current = null;
      rootRef.current.innerHTML = '';
    }
    accRef.current.push(...events);

    if (!replayerRef.current) {
      // Can only start once we have a full snapshot (type 2) to build the DOM.
      if (accRef.current.some((e) => e.type === 2)) {
        const r = new Replayer(accRef.current as never[], {
          root: rootRef.current,
          liveMode: true,
          mouseTail: false,
          // Recorded page is read-only here.
          insertStyleRules: ['* { cursor: default !important; }'],
        });
        r.startLive();
        replayerRef.current = r;
      }
    } else if (!feed.reset) {
      for (const ev of events) replayerRef.current.addEvent(ev as never);
    }
  }, [feed]);

  useEffect(() => {
    return () => {
      try {
        replayerRef.current?.pause();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex flex-col">
      <div className="flex items-center gap-2 px-4 h-12 bg-white shrink-0">
        <Eye className="w-5 h-5 text-blue-600" />
        <span className="font-semibold text-gray-800">Live view</span>
        <span className="text-xs text-gray-400">watching {feed?.visitorId?.slice(0, 12)}…</span>
        <button onClick={onClose} className="ml-auto p-1.5 text-gray-600" aria-label="Stop watching">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-gray-200 flex items-start justify-center p-4">
        {/* rrweb renders the recorded page into an iframe inside this root. */}
        <div ref={rootRef} className="bg-white shadow-lg" />
      </div>
      {!replayerRef.current && (
        <div className="absolute inset-0 flex items-center justify-center text-white pointer-events-none">
          Waiting for the visitor's screen…
        </div>
      )}
    </div>
  );
}
