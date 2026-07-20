import type { WebSocket } from 'ws';

/**
 * MagicBrowse live session replay relay (Phase 9). rrweb events are recorded in
 * the visitor's HOST PAGE (not the widget iframe — that was the old bug) and
 * streamed here over the presence WS. We keep a small per-visitor buffer,
 * trimmed to start at the most recent full snapshot so an agent who starts
 * watching mid-session can rebuild the DOM, then live-forward new events to any
 * agent sockets watching that visitor.
 */

interface RRWebEvent {
  type: number; // 2 = FullSnapshot, 3 = IncrementalSnapshot, 4 = Meta, ...
  [k: string]: unknown;
}

const MAX_BUFFER = 6000; // hard cap on retained events per visitor
const buffers = new Map<string, RRWebEvent[]>();
const watchers = new Map<WebSocket, string>(); // agent socket → visitorId watched

function sendTo(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Ingest a batch of rrweb events from a visitor; buffer + live-forward. */
export function ingestReplayEvents(visitorId: string, events: RRWebEvent[]): void {
  if (!Array.isArray(events) || events.length === 0) return;
  let buf = buffers.get(visitorId) ?? [];
  for (const ev of events) {
    buf.push(ev);
    // On a full snapshot, drop everything before its preceding Meta so the
    // buffer always begins with a replayable [Meta, FullSnapshot, …] prefix.
    if (ev.type === 2) {
      let start = buf.length - 1;
      if (buf.length >= 2 && buf[buf.length - 2]!.type === 4) start = buf.length - 2;
      buf = buf.slice(start);
    }
  }
  if (buf.length > MAX_BUFFER) buf = buf.slice(buf.length - MAX_BUFFER);
  buffers.set(visitorId, buf);

  for (const [ws, watched] of watchers) {
    if (watched === visitorId) sendTo(ws, { type: 'rrweb:events', visitorId, events });
  }
}

/** An agent starts watching a visitor: send the current buffer, then live. */
export function startWatch(ws: WebSocket, visitorId: string): void {
  watchers.set(ws, visitorId);
  const buf = buffers.get(visitorId) ?? [];
  sendTo(ws, { type: 'rrweb:events', visitorId, events: buf, reset: true });
}

export function stopWatch(ws: WebSocket): void {
  watchers.delete(ws);
}

/** True if this agent socket is currently watching the given visitor. Guards
 *  Live Assist so an agent can only guide a session they're actually viewing. */
export function isWatching(ws: WebSocket, visitorId: string): boolean {
  return watchers.get(ws) === visitorId;
}

export function clearReplay(visitorId: string): void {
  buffers.delete(visitorId);
}
