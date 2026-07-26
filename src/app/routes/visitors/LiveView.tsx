import { useEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import { X, Eye, Lock, Monitor, Smartphone, MapPin, MousePointer2 } from 'lucide-react';
import 'rrweb/dist/rrweb.min.css';
import type { PresenceVisitor } from '../../../lib/api/types';

export interface ReplayFeed {
  visitorId: string;
  events: unknown[];
  reset: boolean;
  nonce: number;
}

interface MetaEvent {
  type: number;
  data?: { href?: string; width?: number; height?: number };
}

/** Pull the newest viewport + href out of a batch of rrweb Meta events (type 4). */
function readMeta(events: MetaEvent[]): { w?: number; h?: number; href?: string } {
  const out: { w?: number; h?: number; href?: string } = {};
  for (const e of events) {
    if (e.type === 4 && e.data) {
      if (e.data.width) out.w = e.data.width;
      if (e.data.height) out.h = e.data.height;
      if (e.data.href) out.href = e.data.href;
    }
  }
  return out;
}

function shortUrl(href: string): string {
  try {
    const u = new URL(href);
    return u.host + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return href;
  }
}

/**
 * Live session view. The visitor's host page is
 * recorded by rrweb and streamed to the server; this replays it live via
 * rrweb.Replayer in liveMode, scaled to fit inside a browser-chrome frame so
 * the agent sees the visitor's whole screen at a glance (no scrolling), with a
 * live URL bar and their current location/device.
 */
export function LiveView({
  feed,
  onClose,
  visitor,
  agentName,
  onAssist,
}: {
  feed: ReplayFeed | null;
  onClose: () => void;
  visitor?: PresenceVisitor | null;
  agentName?: string;
  onAssist?: (payload: Record<string, unknown>) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const accRef = useRef<{ type: number }[]>([]);
  const lastSent = useRef(0);
  const [ready, setReady] = useState(false);
  const [assist, setAssist] = useState(false);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 1280, h: 800 });
  const [href, setHref] = useState<string>('');
  const [holder, setHolder] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Feed rrweb + track the visitor's live viewport/URL from Meta events.
  useEffect(() => {
    if (!feed || !rootRef.current) return;
    const events = feed.events as MetaEvent[];

    const meta = readMeta(events);
    if (meta.w && meta.h) setViewport({ w: meta.w, h: meta.h });
    if (meta.href) setHref(meta.href);

    if (feed.reset) {
      accRef.current = [];
      replayerRef.current = null;
      rootRef.current.innerHTML = '';
      setReady(false);
    }
    accRef.current.push(...(events as { type: number }[]));

    if (!replayerRef.current) {
      if (accRef.current.some((e) => e.type === 2)) {
        const r = new Replayer(accRef.current as never[], {
          root: rootRef.current,
          liveMode: true,
          mouseTail: false,
          insertStyleRules: ['* { cursor: default !important; }'],
        });
        r.startLive();
        replayerRef.current = r;
        setReady(true);
      }
    } else if (!feed.reset) {
      for (const ev of events) replayerRef.current.addEvent(ev as never);
    }
  }, [feed]);

  // Track the viewing area so we can scale the recorded screen to fit.
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const measure = () => setHolder({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      try {
        replayerRef.current?.pause();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Contain-fit: fit the whole viewport into the holder (never upscale past 1×).
  const scale =
    holder.w > 0 && holder.h > 0 ? Math.min(holder.w / viewport.w, holder.h / viewport.h, 1) : 0;

  // ── Live Assist: relay the agent's guiding pointer/click to the visitor ──────
  // Send NORMALISED coordinates (0..1) relative to the stage — which is exactly
  // the visitor's viewport, contain-scaled. The host de-normalises against its
  // own live innerWidth/innerHeight, so the pointer lands on the same spot even
  // if the recorded viewport size differs from the visitor's current window
  // (this is what caused the vertical drift).
  const toNorm = (clientX: number, clientY: number): { nx: number; ny: number } | null => {
    const rect = captureRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { nx, ny };
  };
  const onAssistMove = (e: React.MouseEvent) => {
    if (!onAssist) return;
    const now = Date.now();
    if (now - lastSent.current < 40) return; // ~25fps throttle
    lastSent.current = now;
    const p = toNorm(e.clientX, e.clientY);
    if (p) onAssist({ kind: 'pointer', nx: p.nx, ny: p.ny });
  };
  const onAssistClick = (e: React.MouseEvent) => {
    if (!onAssist) return;
    const p = toNorm(e.clientX, e.clientY);
    if (p) onAssist({ kind: 'click', nx: p.nx, ny: p.ny });
  };
  const toggleAssist = () => {
    setAssist((on) => {
      const next = !on;
      onAssist?.(next ? { kind: 'start', agent: agentName ?? 'An agent' } : { kind: 'stop' });
      return next;
    });
  };
  // Always clear the visitor's overlay when the viewer closes.
  const onAssistRef = useRef(onAssist);
  onAssistRef.current = onAssist;
  useEffect(() => () => onAssistRef.current?.({ kind: 'stop' }), []);

  const currentUrl = href || visitor?.current_url || '';
  const geoText = [visitor?.city, visitor?.country].filter(Boolean).join(', ');
  const Device = visitor?.device === 'mobile' ? Smartphone : Monitor;

  return (
    <div className="fixed inset-0 bg-gray-900/85 backdrop-blur-sm z-50 flex flex-col p-0 sm:p-4">
      <div className="flex flex-col flex-1 min-h-0 bg-gray-100 sm:rounded-3xl overflow-hidden shadow-2xl">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 h-14 bg-white border-b border-gray-100 shrink-0">
          <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
            <Eye className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-800 truncate">Live view</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-600 px-2 py-0.5 text-[10px] font-bold tracking-wide shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
              </span>
            </div>
            <p className="text-xs text-gray-400 truncate flex items-center gap-1.5">
              <Device className="w-3 h-3 shrink-0" />
              {viewport.w}×{viewport.h}
              {geoText && (
                <>
                  <MapPin className="w-3 h-3 shrink-0 ml-1" /> {geoText}
                </>
              )}
            </p>
          </div>
          {onAssist && (
            <button
              onClick={toggleAssist}
              className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition shrink-0 ${
                assist ? 'bg-blue-600 text-white shadow-sm' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              title="Guide the visitor with your pointer on their screen"
            >
              <MousePointer2 className="w-4 h-4" />
              {assist ? 'Assisting' : 'Live Assist'}
            </button>
          )}
          <button
            onClick={onClose}
            className={`inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3.5 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition shrink-0 ${onAssist ? '' : 'ml-auto'}`}
            aria-label="Stop watching"
          >
            <X className="w-4 h-4" /> Stop
          </button>
        </div>

        {/* Browser chrome */}
        <div className="flex items-center gap-3 px-4 h-11 bg-gray-50 border-b border-gray-200 shrink-0">
          <div className="flex gap-1.5 shrink-0">
            <span className="w-3 h-3 rounded-full bg-red-400" />
            <span className="w-3 h-3 rounded-full bg-amber-400" />
            <span className="w-3 h-3 rounded-full bg-green-400" />
          </div>
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-white border border-gray-200 rounded-full px-3.5 py-1.5">
            <Lock className="w-3 h-3 text-gray-400 shrink-0" />
            <span className="text-xs text-gray-600 truncate">{currentUrl ? shortUrl(currentUrl) : 'about:blank'}</span>
          </div>
        </div>

        {/* Stage — the recorded screen, scaled to fit. The rrweb root stays
            mounted at all times (rrweb renders into it); the sized wrapper is
            hidden until the first snapshot arrives. */}
        <div ref={holderRef} className="relative flex-1 overflow-hidden bg-gray-300/60 grid place-items-center p-3 sm:p-6">
          <div
            className={`relative rounded-lg overflow-hidden shadow-2xl bg-white ${assist ? 'ring-2 ring-blue-500' : 'ring-1 ring-black/10'}`}
            style={{
              width: ready ? viewport.w * scale : 0,
              height: ready ? viewport.h * scale : 0,
              visibility: ready && scale > 0 ? 'visible' : 'hidden',
            }}
          >
            <div
              ref={rootRef}
              className="nestled-live"
              style={{ width: viewport.w, height: viewport.h, transform: `scale(${scale})`, transformOrigin: 'top left' }}
            />
            {/* Assist capture layer — swallows the agent's mouse (so the replay
                iframe doesn't) and relays pointer/click to the visitor. */}
            {assist && (
              <div
                ref={captureRef}
                className="absolute inset-0 cursor-crosshair"
                onMouseMove={onAssistMove}
                onMouseDown={onAssistClick}
                onMouseLeave={() => onAssist?.({ kind: 'hide' })}
              />
            )}
          </div>
          {assist && ready && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-2 rounded-full bg-blue-600 text-white px-3.5 py-1.5 text-xs font-semibold shadow-lg pointer-events-none">
              <MousePointer2 className="w-3.5 h-3.5" />
              Your pointer is visible to the visitor — move to guide, click to highlight
            </div>
          )}
          {!ready && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-600">
              <span className="w-10 h-10 rounded-full border-2 border-gray-400/60 border-t-blue-600 animate-spin" />
              <p className="text-sm font-medium">Waiting for the visitor's screen…</p>
              <p className="text-xs text-gray-500 max-w-xs text-center">
                They'll appear here the moment they move or scroll. Live view needs session capture enabled in Settings.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
