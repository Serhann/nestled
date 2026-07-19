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
    <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-sm z-50 flex flex-col p-0 sm:p-4">
      <div className="flex flex-col flex-1 min-h-0 bg-canvas sm:rounded-3xl overflow-hidden shadow-2xl border border-white/10">
        <div className="flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-100 shrink-0">
          <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center">
            <Eye className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-800">Live view</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-600 px-2 py-0.5 text-[10px] font-bold tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
              </span>
            </div>
            <p className="text-xs text-gray-400 truncate">Watching visitor {feed?.visitorId?.slice(0, 14)}…</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3.5 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
            aria-label="Stop watching"
          >
            <X className="w-4 h-4" /> Stop
          </button>
        </div>
        <div className="relative flex-1 overflow-auto bg-gray-200/70 flex items-start justify-center p-4">
          {/* rrweb renders the recorded page into an iframe inside this root. */}
          <div ref={rootRef} className="bg-white shadow-lg rounded-lg overflow-hidden" />
          {!replayerRef.current && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500 pointer-events-none">
              <span className="w-10 h-10 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin" />
              <p className="text-sm font-medium">Waiting for the visitor's screen…</p>
              <p className="text-xs text-gray-400 max-w-xs text-center">
                They'll appear here the moment they move or scroll. Live view needs session capture enabled in Settings.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
