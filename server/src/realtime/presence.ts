import type { WebSocket } from 'ws';
import { publishPerAgent } from './hub.js';
import type { GeoLocation } from '../services/geo.js';
import type { VerifiedContext } from '../services/verifiedAttributes.js';

/**
 * Live visitor presence — everyone on a customer's site right now, including
 * anonymous visitors who never opened the chat.
 *
 * Keyed by WEBSITE, not globally. Two consequences that matter:
 *  - two customers can never collide on a visitor id (they are client-generated),
 *  - the board a workspace sees can only ever contain its own visitors.
 *
 * In-memory with a TTL sweep. Single-replica, like the rest of the realtime plane
 * (see bus.ts).
 */

export interface PageVisit {
  url: string;
  at: number;
}

export interface PresenceEntry {
  visitorId: string;
  workspaceId: string;
  websiteId: string;
  url: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  device: 'mobile' | 'desktop';
  screen: { w: number; h: number } | null;
  returning: boolean;
  sessionStart: number;
  pagesViewed: number;
  pages: PageVisit[];
  ip: string;
  geo: GeoLocation | null;
  conversationId: string | null;
  name: string | null;
  email: string | null;
  userAgent: string | null;
  language: string | null;
  timezone: string | null;
  /** HMAC-verified host context. */
  context: VerifiedContext | null;
  /** Unsigned host-supplied attributes — display only, never trusted. */
  data: Record<string, string>;
  lastSeen: number;
}

const MAX_PAGES = 30;
const STALE_MS = 60_000;

interface Tracked {
  entry: PresenceEntry;
  sockets: Set<WebSocket>;
}

/** websiteId -> visitorId -> tracked. */
const byWebsite = new Map<string, Map<string, Tracked>>();

function bucket(websiteId: string): Map<string, Tracked> {
  let m = byWebsite.get(websiteId);
  if (!m) {
    m = new Map();
    byWebsite.set(websiteId, m);
  }
  return m;
}

function find(websiteId: string, visitorId: string): Tracked | undefined {
  return byWebsite.get(websiteId)?.get(visitorId);
}

// Coalesce rapid changes into one broadcast per tick, per workspace.
const queued = new Set<string>();
function scheduleBroadcast(workspaceId: string): void {
  if (queued.has(workspaceId)) return;
  queued.add(workspaceId);
  setTimeout(() => {
    queued.delete(workspaceId);
    // Per agent, because each one may be granted a different set of websites.
    publishPerAgent(workspaceId, (websiteIds) => ({
      type: 'presence:list',
      visitors: snapshot(workspaceId, websiteIds),
    }));
  }, 250);
}

export interface HelloData {
  url?: string;
  referrer?: string;
  utm?: Record<string, string>;
  device?: 'mobile' | 'desktop';
  screen?: { w: number; h: number };
  returning?: boolean;
  sessionStart?: number;
  user_agent?: string;
  language?: string;
  timezone?: string;
}

/**
 * Record a page visit if the URL actually changed. Shared by the hello path (full
 * page loads — the only navigation signal on non-SPA host sites) and the SPA
 * `update` path. Guards against duplicates so a WS reconnect on the same page
 * never inflates the count.
 */
function recordPageVisit(entry: PresenceEntry, url: string | null | undefined, now: number): boolean {
  if (!url || url === entry.url) return false;
  entry.url = url;
  entry.pagesViewed += 1;
  entry.pages.push({ url, at: now });
  if (entry.pages.length > MAX_PAGES) entry.pages.splice(0, entry.pages.length - MAX_PAGES);
  return true;
}

/**
 * Attach a presence socket.
 *
 * `workspaceId`/`websiteId`/`visitorId` all come from the SIGNED widget session
 * token verified in the gateway — never from a query string. That is the fix for
 * the takeover described in gateway.ts.
 */
export function registerPresenceSocket(
  ws: WebSocket,
  ids: { workspaceId: string; websiteId: string; visitorId: string },
  ip: string,
  geo: GeoLocation | null,
  hello: HelloData,
): void {
  const now = Date.now();
  const site = bucket(ids.websiteId);
  let tracked = site.get(ids.visitorId);

  if (!tracked) {
    tracked = {
      sockets: new Set(),
      entry: {
        visitorId: ids.visitorId,
        workspaceId: ids.workspaceId,
        websiteId: ids.websiteId,
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
        name: null,
        email: null,
        userAgent: hello.user_agent ?? null,
        language: hello.language ?? null,
        timezone: hello.timezone ?? null,
        context: null,
        data: {},
        lastSeen: now,
      },
    };
    site.set(ids.visitorId, tracked);
  } else {
    tracked.entry.ip = ip;
    if (geo) tracked.entry.geo = geo;
    if (hello.screen) tracked.entry.screen = hello.screen;
    if (hello.user_agent) tracked.entry.userAgent = hello.user_agent;
    if (hello.language) tracked.entry.language = hello.language;
    if (hello.timezone) tracked.entry.timezone = hello.timezone;
    tracked.entry.lastSeen = now;
    recordPageVisit(tracked.entry, hello.url, now);
  }
  tracked.sockets.add(ws);

  ws.on('close', () => {
    const t = find(ids.websiteId, ids.visitorId);
    if (!t) return;
    t.sockets.delete(ws);
    t.entry.lastSeen = Date.now();
    scheduleBroadcast(ids.workspaceId);
  });

  scheduleBroadcast(ids.workspaceId);
}

export function updatePresence(
  websiteId: string,
  visitorId: string,
  patch: Partial<HelloData>,
): void {
  const t = find(websiteId, visitorId);
  if (!t) return;
  const now = Date.now();
  t.entry.lastSeen = now;
  if (patch.url !== undefined) recordPageVisit(t.entry, patch.url, now);
  if (patch.utm) t.entry.utm = patch.utm;
  scheduleBroadcast(t.entry.workspaceId);
}

export function setPresenceIdentity(
  websiteId: string,
  visitorId: string,
  identity: { name?: string | null; email?: string | null },
): void {
  const t = find(websiteId, visitorId);
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
  if (changed) scheduleBroadcast(t.entry.workspaceId);
}

export function setPresenceContext(
  websiteId: string,
  visitorId: string,
  context: VerifiedContext | null,
): void {
  const t = find(websiteId, visitorId);
  if (!t || !context) return;
  t.entry.context = context;
  scheduleBroadcast(t.entry.workspaceId);
}

/** Unsigned session attributes from Nestled('data', {...}). Display only. */
export function setPresenceData(
  websiteId: string,
  visitorId: string,
  attributes: Record<string, unknown>,
): void {
  const t = find(websiteId, visitorId);
  if (!t) return;
  for (const [k, v] of Object.entries(attributes)) {
    if (v == null) delete t.entry.data[k];
    else t.entry.data[k] = String(v).slice(0, 500);
  }
  scheduleBroadcast(t.entry.workspaceId);
}

export function attachConversationToVisitor(
  websiteId: string,
  visitorId: string,
  conversationId: string,
): void {
  const t = find(websiteId, visitorId);
  if (!t) return;
  t.entry.conversationId = conversationId;
  scheduleBroadcast(t.entry.workspaceId);
}

/**
 * Push a proactive "an agent started a chat with you" frame.
 *
 * It carries a single-use CLAIM token, never the conversation's `visitor_token`.
 * The old version put the visitor token on this wire, and because the presence
 * socket was joinable with any guessed visitor id, anyone could open
 * `/ws/presence?visitor_id=<victim>` and be handed full read/write access to that
 * conversation. Two independent fixes now stand between that and a breach: the
 * socket requires a signed session token (gateway.ts), and even a leaked frame is
 * worthless without the victim's own token because the claim must be exchanged.
 */
export function sendProactiveToVisitor(
  websiteId: string,
  visitorId: string,
  payload: { conversation_id: string; claim_token: string; message: string; agent_name: string },
): boolean {
  const t = find(websiteId, visitorId);
  if (!t || t.sockets.size === 0) return false;
  const frame = JSON.stringify({ type: 'proactive', ...payload });
  for (const ws of t.sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  return true;
}

/**
 * Relay a Live Assist frame (the agent's guiding pointer / click / banner) to the
 * visitor, where presence.js renders it as an overlay. View-only guidance — it
 * never executes host-page code.
 */
export function sendAssistToVisitor(
  websiteId: string,
  visitorId: string,
  assist: Record<string, unknown>,
): boolean {
  const t = find(websiteId, visitorId);
  if (!t || t.sockets.size === 0) return false;
  const frame = JSON.stringify({ type: 'assist', ...assist });
  for (const ws of t.sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  return true;
}

/**
 * Ask a visitor's page for an immediate full rrweb snapshot.
 *
 * Sent when an agent starts watching. Carries no data and grants nothing — the page
 * is already recording or it is not, and this only changes WHEN the next full frame
 * is emitted. Returns false when the visitor has no socket, which the caller may
 * ignore: they are about to find that out anyway.
 */
export function requestReplaySnapshot(websiteId: string, visitorId: string): boolean {
  const t = find(websiteId, visitorId);
  if (!t || t.sockets.size === 0) return false;
  const frame = JSON.stringify({ type: 'replay:snapshot' });
  for (const ws of t.sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  return true;
}

export function isVisitorOnline(websiteId: string, visitorId: string): boolean {
  const t = find(websiteId, visitorId);
  return Boolean(t && t.sockets.size > 0);
}

export function getVisitor(websiteId: string, visitorId: string): PresenceEntry | null {
  return find(websiteId, visitorId)?.entry ?? null;
}

/**
 * One visitor, as the live board consumes them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * There was no serializer. `snapshot()` spread the in-memory entry onto the wire,
 * which meant the board received `visitorId` while every line of the client read
 * `visitor_id` — so EVERY field on that screen was undefined. It did not look
 * broken, because each field has a fallback: "Anonymous visitor", "Unknown
 * location", "Unknown page", "0 pages", "Unknown browser". It looked like a page
 * full of visitors we knew nothing about.
 *
 * What gave it away was Say hello returning 400 for a missing `website_id`, and
 * React warning about duplicate keys — every key was `undefined`.
 *
 * Two other things a boundary buys, beyond the names:
 *
 *   - `workspaceId` and the full `pages` history stop leaving the process. The
 *     board needs a count, not a browsing history.
 *   - The browser is derived here rather than shipping the raw user agent, which
 *     is 120 characters of which six matter.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface PresenceRow {
  visitor_id: string;
  website_id: string;
  name: string | null;
  email: string | null;
  current_url: string | null;
  page_title: string | null;
  referrer: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  started_at: string;
  last_seen: string;
  page_count: number;
  conversation_id: string | null;
  online: boolean;
  context: unknown;
  data: Record<string, unknown>;
}

/** Crude on purpose, and it falls back to null rather than to a misleading guess. */
function browserOf(ua: string | null): string | null {
  if (!ua) return null;
  // Edge and Opera both claim Chrome in their user agent, so they are tested first.
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

export function serializePresence(
  entry: PresenceEntry,
  online: boolean,
): PresenceRow {
  return {
    visitor_id: entry.visitorId,
    website_id: entry.websiteId,
    name: entry.name,
    email: entry.email,
    current_url: entry.url,
    // Not captured today; the board falls back to the URL. Present in the contract
    // so adding it later is a server-only change.
    page_title: null,
    referrer: entry.referrer,
    country: entry.geo?.country ?? null,
    city: entry.geo?.city ?? null,
    device: entry.device,
    browser: browserOf(entry.userAgent),
    started_at: new Date(entry.sessionStart).toISOString(),
    last_seen: new Date(entry.lastSeen).toISOString(),
    page_count: entry.pagesViewed,
    conversation_id: entry.conversationId,
    online,
    context: entry.context,
    data: entry.data,
  };
}

/** The live board for one workspace, optionally narrowed to granted websites. */
export function snapshot(workspaceId: string, websiteIds?: string[] | null): PresenceRow[] {
  const out: PresenceRow[] = [];
  for (const [websiteId, visitors] of byWebsite) {
    if (websiteIds && !websiteIds.includes(websiteId)) continue;
    for (const t of visitors.values()) {
      if (t.entry.workspaceId !== workspaceId) continue;
      out.push(serializePresence(t.entry, t.sockets.size > 0));
    }
  }
  return out;
}

// Sweep stale entries (client vanished without a clean close).
setInterval(() => {
  const now = Date.now();
  const touched = new Set<string>();
  for (const [websiteId, visitors] of byWebsite) {
    for (const [id, t] of visitors) {
      if (t.sockets.size === 0 && now - t.entry.lastSeen > STALE_MS) {
        visitors.delete(id);
        touched.add(t.entry.workspaceId);
      }
    }
    if (visitors.size === 0) byWebsite.delete(websiteId);
  }
  for (const workspaceId of touched) scheduleBroadcast(workspaceId);
}, 20_000).unref();
