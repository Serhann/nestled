import type { WebSocket } from 'ws';

/**
 * rrweb session replay ("Live view").
 *
 * Events are recorded in the visitor's HOST PAGE (not the widget iframe) and
 * streamed here over the presence socket. A bounded buffer, trimmed to start at
 * the most recent full snapshot, lets an agent joining mid-session rebuild the DOM
 * instead of seeing a blank screen; new events are then forwarded live.
 *
 * Keyed by (websiteId, visitorId), not visitorId alone. Visitor ids are
 * client-generated, so two customers can collide on one, and a global key would
 * mean serving customer A's recorded page to customer B's agent.
 *
 * The memory ceiling is deliberate. The previous version capped events per visitor
 * but never capped how many visitors were buffered, so a busy site accumulated
 * thousands of buffers nobody was watching — the single largest memory risk in the
 * realtime plane. Now a buffer exists only while an agent is watching (or watched
 * within the grace window), and each workspace has a hard ceiling with LRU
 * eviction of unwatched buffers.
 */

interface RRWebEvent {
  type: number; // 2 = FullSnapshot, 3 = IncrementalSnapshot, 4 = Meta, …
  [k: string]: unknown;
}

interface Buffer {
  key: string;
  workspaceId: string;
  events: RRWebEvent[];
  lastWrite: number;
  watchers: Set<WebSocket>;
  lastWatched: number;
}

const MAX_BUFFER = 6000;
const MAX_BUFFERS_PER_WORKSPACE = 25;
/** Keep buffering briefly after the last watcher leaves so a reload can resume. */
const GRACE_MS = 60_000;

const buffers = new Map<string, Buffer>();
/** socket -> the key it is watching. One watch per agent socket. */
const watching = new Map<WebSocket, string>();

const keyOf = (websiteId: string, visitorId: string) => `${websiteId}:${visitorId}`;

function sendTo(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function evictIfNeeded(workspaceId: string): void {
  const mine = [...buffers.values()].filter((b) => b.workspaceId === workspaceId);
  if (mine.length <= MAX_BUFFERS_PER_WORKSPACE) return;
  mine
    .filter((b) => b.watchers.size === 0)
    .sort((a, b) => a.lastWrite - b.lastWrite)
    .slice(0, mine.length - MAX_BUFFERS_PER_WORKSPACE)
    .forEach((b) => buffers.delete(b.key));
}

/**
 * Ingest a batch from the visitor's page. Drops everything unless someone is (or
 * just was) watching — recording is cheap on the client, but holding a buffer for
 * every visitor on every customer site is not.
 */
export function ingestReplayEvents(
  websiteId: string,
  visitorId: string,
  events: RRWebEvent[],
): void {
  if (!Array.isArray(events) || events.length === 0) return;
  const key = keyOf(websiteId, visitorId);
  const buf = buffers.get(key);
  if (!buf) return; // nobody watching — never start a buffer from ingest
  if (buf.watchers.size === 0 && Date.now() - buf.lastWatched > GRACE_MS) {
    buffers.delete(key);
    return;
  }

  for (const ev of events) {
    buf.events.push(ev);
    // On a full snapshot, drop everything before its preceding Meta so the buffer
    // always begins with a replayable [Meta, FullSnapshot, …] prefix. Trimming
    // past a snapshot would leave an unrenderable stream of mutations.
    if (ev.type === 2) {
      let start = buf.events.length - 1;
      if (buf.events.length >= 2 && buf.events[buf.events.length - 2]!.type === 4) {
        start = buf.events.length - 2;
      }
      buf.events = buf.events.slice(start);
    }
  }
  if (buf.events.length > MAX_BUFFER) {
    buf.events = buf.events.slice(buf.events.length - MAX_BUFFER);
  }
  buf.lastWrite = Date.now();

  for (const ws of buf.watchers) sendTo(ws, { type: 'rrweb:events', visitorId, websiteId, events });
}

/**
 * An agent starts watching. The CALLER must already have verified that this
 * workspace owns the website and that the member is granted it — see hub.ts. The
 * old version's only check was "did this agent ask to watch?", which proves
 * nothing about whether they may.
 */
export function startWatch(
  ws: WebSocket,
  workspaceId: string,
  websiteId: string,
  visitorId: string,
): void {
  stopWatch(ws);
  const key = keyOf(websiteId, visitorId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = {
      key,
      workspaceId,
      events: [],
      lastWrite: Date.now(),
      watchers: new Set(),
      lastWatched: Date.now(),
    };
    buffers.set(key, buf);
    evictIfNeeded(workspaceId);
  }
  // A buffer created for one workspace must never be adopted by another.
  if (buf.workspaceId !== workspaceId) return;

  buf.watchers.add(ws);
  buf.lastWatched = Date.now();
  watching.set(ws, key);
  sendTo(ws, { type: 'rrweb:events', visitorId, websiteId, events: buf.events, reset: true });
}

export function stopWatch(ws: WebSocket): void {
  const key = watching.get(ws);
  if (!key) return;
  watching.delete(ws);
  const buf = buffers.get(key);
  if (!buf) return;
  buf.watchers.delete(ws);
  buf.lastWatched = Date.now();
}

/** Guards Live Assist: an agent may only guide a session they are watching. */
export function isWatching(ws: WebSocket, websiteId: string, visitorId: string): boolean {
  return watching.get(ws) === keyOf(websiteId, visitorId);
}

/** True when this (website, visitor) has a live buffer worth ingesting into. */
export function isBuffering(websiteId: string, visitorId: string): boolean {
  return buffers.has(keyOf(websiteId, visitorId));
}

export function clearReplay(websiteId: string, visitorId: string): void {
  buffers.delete(keyOf(websiteId, visitorId));
}
