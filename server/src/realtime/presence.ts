import type { WebSocket } from 'ws';
import { broadcastToAgents } from './hub.js';
import type { GeoLocation } from '../services/geo.js';

/**
 * Live visitor presence — everyone currently on the site, including anonymous
 * visitors who never opened the chat (Crisp's "see everyone right now"). This
 * is the anonymous, pre-conversation layer; the conversation realtime lives in
 * hub.ts. Kept in-memory with a TTL sweep; Phase 10 can add Postgres-backed
 * persistence if horizontal scaling is needed.
 */

export interface PageVisit {
  url: string;
  at: number; // epoch ms
}

export interface PresenceEntry {
  visitorId: string;
  url: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  device: 'mobile' | 'desktop';
  screen: { w: number; h: number } | null;
  returning: boolean;
  sessionStart: number; // epoch ms, from the client
  pagesViewed: number;
  pages: PageVisit[]; // recent page-visit history (bounded)
  ip: string;
  geo: GeoLocation | null;
  conversationId: string | null; // set if this visitor has an open conversation
  mode: string; // which site / scenario pack this visitor is on (site key)
  name: string | null; // identified customer name (from verified host context)
  email: string | null; // identified customer email (from verified host context)
  lastSeen: number;
}

const MAX_PAGES = 30; // keep the last N visited pages per visitor

interface Tracked {
  entry: PresenceEntry;
  sockets: Set<WebSocket>;
}

const visitors = new Map<string, Tracked>();
const STALE_MS = 60_000; // no heartbeat for 60s with no socket → drop

// Coalesce rapid changes into one broadcast per tick.
let broadcastQueued = false;
function scheduleBroadcast(): void {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    broadcastToAgents({ type: 'presence:list', visitors: snapshot() });
  }, 250);
}

interface HelloData {
  url?: string;
  referrer?: string;
  utm?: Record<string, string>;
  device?: 'mobile' | 'desktop';
  screen?: { w: number; h: number };
  returning?: boolean;
  sessionStart?: number;
  mode?: string;
}

export function registerPresenceSocket(
  ws: WebSocket,
  visitorId: string,
  ip: string,
  geo: GeoLocation | null,
  hello: HelloData,
): void {
  const now = Date.now();
  let tracked = visitors.get(visitorId);
  if (!tracked) {
    tracked = {
      sockets: new Set(),
      entry: {
        visitorId,
        url: hello.url ?? null,
        referrer: hello.referrer ?? null,
        utm: hello.utm ?? {},
        device: hello.device === 'mobile' ? 'mobile' : 'desktop',
        screen: hello.screen ?? null,
        returning: Boolean(hello.returning),
        sessionStart: hello.sessionStart ?? now,
        pagesViewed: 1,
        pages: hello.url ? [{ url: hello.url, at: now }] : [],
        ip,
        geo,
        conversationId: null,
        mode: hello.mode || 'food',
        name: null,
        email: null,
        lastSeen: now,
      },
    };
    visitors.set(visitorId, tracked);
  } else {
    // Reconnect / second tab: refresh but keep counters.
    tracked.entry.ip = ip;
    if (geo) tracked.entry.geo = geo;
    if (hello.mode) tracked.entry.mode = hello.mode;
    tracked.entry.lastSeen = now;
  }
  tracked.sockets.add(ws);

  ws.on('close', () => {
    const t = visitors.get(visitorId);
    if (!t) return;
    t.sockets.delete(ws);
    t.entry.lastSeen = Date.now();
    scheduleBroadcast();
  });

  scheduleBroadcast();
}

/** Apply a client update (navigation / heartbeat). */
export function updatePresence(visitorId: string, patch: Partial<HelloData>): void {
  const t = visitors.get(visitorId);
  if (!t) return;
  t.entry.lastSeen = Date.now();
  if (patch.url !== undefined && patch.url !== t.entry.url) {
    t.entry.url = patch.url;
    t.entry.pagesViewed += 1; // count each distinct navigation
    if (patch.url) {
      t.entry.pages.push({ url: patch.url, at: Date.now() });
      if (t.entry.pages.length > MAX_PAGES) t.entry.pages = t.entry.pages.slice(-MAX_PAGES);
    }
  }
  if (patch.utm) t.entry.utm = patch.utm;
  scheduleBroadcast();
}

/** Set the identified customer name/email on a present visitor (from verified
 *  host context) so the Live Visitors board shows who they are, not "anonymous". */
export function setPresenceIdentity(
  visitorId: string,
  identity: { name?: string | null; email?: string | null },
): void {
  const t = visitors.get(visitorId);
  if (!t) return;
  let changed = false;
  if (identity.name && identity.name !== t.entry.name) {
    t.entry.name = identity.name;
    changed = true;
  }
  if (identity.email && identity.email !== t.entry.email) {
    t.entry.email = identity.email;
    changed = true;
  }
  if (changed) scheduleBroadcast();
}

/** Link a conversation to a present visitor (shows the green dot in the list). */
export function attachConversationToVisitor(visitorId: string, conversationId: string): void {
  const t = visitors.get(visitorId);
  if (!t) return;
  t.entry.conversationId = conversationId;
  scheduleBroadcast();
}

/** Push a proactive "open the chat" event to a visitor's presence socket(s). */
export function sendProactiveToVisitor(
  visitorId: string,
  payload: { conversation_id: string; visitor_token: string; message: string; agent_name: string },
): boolean {
  const t = visitors.get(visitorId);
  if (!t || t.sockets.size === 0) return false;
  const frame = JSON.stringify({ type: 'proactive', ...payload });
  for (const ws of t.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
  return true;
}

/**
 * Relay a Live Assist frame (the agent's guiding pointer / click / banner) to a
 * visitor's presence socket(s), where presence.js renders it as an overlay on
 * the real page. Low-risk, view-only guidance — never executes host-page code.
 */
export function sendAssistToVisitor(visitorId: string, assist: Record<string, unknown>): boolean {
  const t = visitors.get(visitorId);
  if (!t || t.sockets.size === 0) return false;
  const frame = JSON.stringify({ type: 'assist', ...assist });
  for (const ws of t.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
  return true;
}

export function isVisitorOnline(visitorId: string): boolean {
  const t = visitors.get(visitorId);
  return Boolean(t && t.sockets.size > 0);
}

export function getVisitor(visitorId: string): PresenceEntry | null {
  return visitors.get(visitorId)?.entry ?? null;
}

/** Current live list for the admin board (online first, with derived fields). */
export function snapshot(): Array<PresenceEntry & { online: boolean; timeOnSite: number }> {
  const now = Date.now();
  return [...visitors.values()].map((t) => ({
    ...t.entry,
    online: t.sockets.size > 0,
    timeOnSite: Math.max(0, now - t.entry.sessionStart),
  }));
}

// Sweep stale entries (client vanished without a clean close).
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of visitors) {
    if (t.sockets.size === 0 && now - t.entry.lastSeen > STALE_MS) {
      visitors.delete(id);
      changed = true;
    }
  }
  if (changed) scheduleBroadcast();
}, 20_000).unref();
