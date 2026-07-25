import type { WebSocket } from 'ws';
import { broadcastToAgents } from './hub.js';
import type { GeoLocation } from '../services/geo.js';
import type { VisitorContext } from '../services/siteContext.js';

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
  // Client hints (display only) so the agent gets the same visitor card the
  // conversation sidebar shows, before any chat exists.
  userAgent: string | null;
  language: string | null;
  timezone: string | null;
  // Trusted host context (HMAC-verified) — customer + orders, same shape the
  // conversation metadata carries.
  context: VisitorContext | null;
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
  user_agent?: string;
  language?: string;
  timezone?: string;
}

/**
 * Record a page visit if the URL actually changed. Shared by the hello path
 * (full page loads — the only navigation signal on non-SPA sites like JetFood)
 * and the SPA `update` path. Returns true if a new page was recorded. Guards
 * against duplicates so a WS reconnect on the same page never inflates counts.
 */
function recordPageVisit(entry: PresenceEntry, url: string | null | undefined, now: number): boolean {
  if (!url || url === entry.url) return false;
  entry.url = url;
  entry.pagesViewed += 1;
  entry.pages.push({ url, at: now });
  if (entry.pages.length > MAX_PAGES) entry.pages = entry.pages.slice(-MAX_PAGES);
  return true;
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
        userAgent: hello.user_agent ?? null,
        language: hello.language ?? null,
        timezone: hello.timezone ?? null,
        context: null,
        lastSeen: now,
      },
    };
    visitors.set(visitorId, tracked);
  } else {
    // Reconnect / second tab / a NEW full-page load (non-SPA sites navigate by
    // reloading, so each page arrives as a fresh hello) — refresh, keep counters,
    // and record the new page if the URL changed.
    tracked.entry.ip = ip;
    if (geo) tracked.entry.geo = geo;
    if (hello.mode) tracked.entry.mode = hello.mode;
    if (hello.screen) tracked.entry.screen = hello.screen;
    if (hello.user_agent) tracked.entry.userAgent = hello.user_agent;
    if (hello.language) tracked.entry.language = hello.language;
    if (hello.timezone) tracked.entry.timezone = hello.timezone;
    tracked.entry.lastSeen = now;
    recordPageVisit(tracked.entry, hello.url, now);
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
  const now = Date.now();
  t.entry.lastSeen = now;
  if (patch.url !== undefined) {
    recordPageVisit(t.entry, patch.url, now);
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

/** Store the HMAC-verified host context (customer + orders) on a present
 *  visitor so the live-visitor card can show it without a conversation. */
export function setPresenceContext(visitorId: string, context: VisitorContext | null): void {
  const t = visitors.get(visitorId);
  if (!t || !context) return;
  t.entry.context = context;
  scheduleBroadcast();
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
