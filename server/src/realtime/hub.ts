import type { WebSocket } from 'ws';
// The hub owns cross-workspace socket registries and writes member presence for
// whichever workspace a socket belongs to, so it cannot use a single scoped client.
// eslint-disable-next-line no-restricted-imports -- registries span workspaces by nature
import { unscopedPrisma } from '../db/unscoped.js';
import { startWatch, stopWatch, isWatching } from './replay.js';
import { sendAssistToVisitor } from './presence.js';

/**
 * In-process realtime hub, keyed by WORKSPACE.
 *
 * The single most important change from the pre-tenant version: every registry is
 * partitioned by workspace, and every fanout takes a workspace id. Previously
 * `broadcastToAgents` reached every connected agent on the install — which in a
 * multi-tenant product means one customer's messages appearing in another's inbox.
 *
 * Agent sockets also carry the conversation the agent is actively VIEWING, which
 * Web Push uses to skip notifying someone already looking at the message, and the
 * member's website grants, so per-website scoping holds on the realtime plane too
 * and not only on REST.
 */

export type RealtimeEvent =
  | { type: 'conversation:new'; conversation: unknown }
  | { type: 'conversation:updated'; conversation: unknown }
  | { type: 'message:new'; conversationId: string; message: unknown }
  | { type: 'typing'; conversationId: string; from: 'visitor' | 'agent'; isTyping: boolean }
  | { type: 'presence:list'; visitors: unknown[] }
  | { type: 'agent:status'; online: boolean }
  | { type: 'agent:joined'; conversationId: string; agentName: string | null }
  | { type: 'conversation:resolved'; conversationId: string }
  | { type: 'website:install_progress'; websiteId: string; phase: string; host?: string }
  // Control frames for the catch-up protocol. `hello` gives a reconnecting client
  // the current cursor; `resync` says the gap is too large to replay and the
  // client should refetch rather than assume it missed nothing.
  | { type: 'hello'; seq: number }
  | { type: 'resync' };

interface AgentSocketState {
  memberId: string;
  userId: string;
  workspaceId: string;
  /** null = every website in the workspace; an array = this member's grants. */
  websiteIds: string[] | null;
  viewing: string | null;
}

/** workspaceId -> sockets. Partitioning by workspace is what makes leaks structural. */
const agentSockets = new Map<string, Map<WebSocket, AgentSocketState>>();
/** conversationId -> visitor sockets. Already narrow: one conversation, one tenant. */
const visitorSockets = new Map<string, Set<WebSocket>>();
/** `${workspaceId}:${memberId}` -> live socket count (tabs/devices). */
const memberSocketCounts = new Map<string, number>();

function setMemberOnline(memberId: string, online: boolean): void {
  void unscopedPrisma.workspace_members
    .updateMany({ where: { id: memberId }, data: { is_online: online, last_seen: new Date() } })
    .catch(() => undefined);
}

/**
 * Events on the wire carry a sequence number the type union does not name, so
 * that adding the catch-up protocol did not mean threading `seq` through every
 * publisher. Only this file stamps it.
 */
type Envelope = RealtimeEvent & { seq?: number };

function send(ws: WebSocket, event: Envelope): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

/**
 * Is any agent online FOR THIS WORKSPACE (optionally for one website)?
 *
 * This was the most dangerous global in the old hub: it drives
 * `ai_response_mode: 'when_no_agent_online'` and the widget's online indicator, so
 * left global, workspace A's widget would claim "we're online" because workspace B
 * happened to have an agent connected — and A's AI would stay silent waiting for a
 * human who does not work there.
 */
export function anyAgentOnline(workspaceId: string, websiteId?: string): boolean {
  const sockets = agentSockets.get(workspaceId);
  if (!sockets || sockets.size === 0) return false;
  if (!websiteId) return true;
  for (const state of sockets.values()) {
    if (!state.websiteIds || state.websiteIds.includes(websiteId)) return true;
  }
  return false;
}

export function registerAgentSocket(
  ws: WebSocket,
  member: { memberId: string; userId: string; workspaceId: string; websiteIds: string[] | null },
): void {
  const { workspaceId, memberId } = member;
  let sockets = agentSockets.get(workspaceId);
  if (!sockets) {
    sockets = new Map();
    agentSockets.set(workspaceId, sockets);
  }
  const wasWorkspaceOffline = sockets.size === 0;
  sockets.set(ws, { ...member, viewing: null });

  const countKey = `${workspaceId}:${memberId}`;
  const prev = memberSocketCounts.get(countKey) ?? 0;
  memberSocketCounts.set(countKey, prev + 1);
  if (prev === 0) setMemberOnline(memberId, true);

  // First agent online in THIS workspace → tell that workspace's visitors only.
  if (wasWorkspaceOffline) publishToWorkspaceVisitors(workspaceId, { type: 'agent:status', online: true });

  // Hand the client the current cursor. A fresh tab records it and moves on; a
  // reconnecting one replies with `resume` and gets the gap filled.
  send(ws, { type: 'hello', seq: sequence });

  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        type?: string;
        conversationId?: string;
        visitorId?: string;
        websiteId?: string;
        since?: number;
        assist?: Record<string, unknown>;
      };
      const state = sockets.get(ws);
      if (!state) return;
      if (msg.type === 'resume' && typeof msg.since === 'number') {
        // The client is back and says where it left off. Either we can still fill
        // the gap from the buffer, or we say so — never a silent partial catch-up.
        if (!replaySince(ws, workspaceId, msg.since, state.websiteIds)) {
          send(ws, { type: 'resync' });
        }
      } else if (msg.type === 'view' && typeof msg.conversationId === 'string') {
        state.viewing = msg.conversationId;
      } else if (msg.type === 'unview') {
        state.viewing = null;
      } else if (msg.type === 'watch' && typeof msg.visitorId === 'string' && typeof msg.websiteId === 'string') {
        // Replay is gated on the agent's own workspace owning the website AND the
        // member being granted it. The old version's only check was "did this agent
        // ask to watch?", which proves nothing.
        if (!state.websiteIds || state.websiteIds.includes(msg.websiteId)) {
          startWatch(ws, state.workspaceId, msg.websiteId, msg.visitorId);
        }
      } else if (msg.type === 'unwatch') {
        stopWatch(ws);
      } else if (
        msg.type === 'assist' &&
        typeof msg.visitorId === 'string' &&
        typeof msg.websiteId === 'string' &&
        msg.assist
      ) {
        // Live Assist relays a pointer into the visitor's page, so it is gated on
        // an active watch for exactly that (website, visitor) pair.
        if (isWatching(ws, msg.websiteId, msg.visitorId)) {
          sendAssistToVisitor(msg.websiteId, msg.visitorId, msg.assist);
        }
      }
    } catch {
      // ignore malformed control frames
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    stopWatch(ws);
    const remaining = (memberSocketCounts.get(countKey) ?? 1) - 1;
    if (remaining <= 0) {
      memberSocketCounts.delete(countKey);
      setMemberOnline(memberId, false);
    } else {
      memberSocketCounts.set(countKey, remaining);
    }
    if (sockets.size === 0) {
      agentSockets.delete(workspaceId);
      publishToWorkspaceVisitors(workspaceId, { type: 'agent:status', online: false });
    }
  });
}

/** Member ids with a live socket in this workspace (push routing, AI takeover). */
export function onlineMemberIds(workspaceId: string): Set<string> {
  const out = new Set<string>();
  for (const state of agentSockets.get(workspaceId)?.values() ?? []) out.add(state.memberId);
  return out;
}

export function registerVisitorSocket(
  conversationId: string,
  workspaceId: string,
  websiteId: string,
  ws: WebSocket,
): void {
  let set = visitorSockets.get(conversationId);
  if (!set) {
    set = new Set();
    visitorSockets.set(conversationId, set);
  }
  set.add(ws);
  // Tell the freshly-connected visitor whether an agent is on THEIR website.
  send(ws, { type: 'agent:status', online: anyAgentOnline(workspaceId, websiteId) });
  ws.on('close', () => {
    const s = visitorSockets.get(conversationId);
    if (!s) return;
    s.delete(ws);
    if (s.size === 0) visitorSockets.delete(conversationId);
  });
}

/** Member ids in this workspace whose socket is currently viewing `conversationId`. */
export function membersViewing(workspaceId: string, conversationId: string): Set<string> {
  const ids = new Set<string>();
  for (const state of agentSockets.get(workspaceId)?.values() ?? []) {
    if (state.viewing === conversationId) ids.add(state.memberId);
  }
  return ids;
}

/**
 * Per-workspace event log, so a reconnecting agent can catch up.
 *
 * A dropped socket is normal — a laptop lid, a tunnel, a proxy idle timeout. What
 * is NOT acceptable is the agent coming back and silently missing the messages
 * that arrived while they were gone; they would answer a customer who had already
 * asked twice. So every event carries a monotonic `seq`, and reconnects ask for
 * everything after the last one they saw.
 *
 * The buffer is small and bounded on purpose. It is a catch-up window, not
 * durable history: if a socket was away longer than the window, the honest answer
 * is `resync`, which tells the client to refetch rather than to believe a gap it
 * cannot see. Sizing it to cover a minute or two of a busy workspace is the whole
 * requirement; anything larger is a memory leak pretending to be reliability.
 */
const BUFFER_SIZE = 250;

interface Buffered {
  seq: number;
  event: RealtimeEvent;
  /** Whose grants may see it; undefined means every member of the workspace. */
  websiteId?: string;
}

const eventLog = new Map<string, Buffered[]>();
let sequence = 0;

/** Events a member is allowed to see, given their website grants. */
function visibleTo(entry: Buffered, websiteIds: string[] | null): boolean {
  return !entry.websiteId || !websiteIds || websiteIds.includes(entry.websiteId);
}

/**
 * Replay everything after `since` to one socket, or tell it to resync.
 *
 * Returns false when the requested point has already fallen out of the window —
 * the caller then sends `resync` rather than a partial, misleading replay.
 */
function replaySince(
  ws: WebSocket,
  workspaceId: string,
  since: number,
  websiteIds: string[] | null,
): boolean {
  const log = eventLog.get(workspaceId) ?? [];
  if (log.length === 0) return since <= sequence;
  // The oldest entry we still hold. If the client's cursor predates it, there is a
  // hole we cannot fill.
  if (since < log[0]!.seq - 1) return false;
  for (const entry of log) {
    if (entry.seq <= since) continue;
    if (!visibleTo(entry, websiteIds)) continue;
    send(ws, { ...entry.event, seq: entry.seq });
  }
  return true;
}

/**
 * Fan out to a workspace's agents. When `websiteId` is given, sockets whose member
 * is not granted that website are skipped — so per-website narrowing holds here
 * too, not only in REST responses.
 */
export function publishToWorkspace(
  workspaceId: string,
  event: RealtimeEvent,
  opts: { websiteId?: string } = {},
): void {
  const seq = ++sequence;
  const stamped: Envelope = { ...event, seq };

  let log = eventLog.get(workspaceId);
  if (!log) {
    log = [];
    eventLog.set(workspaceId, log);
  }
  log.push({ seq, event, websiteId: opts.websiteId });
  if (log.length > BUFFER_SIZE) log.splice(0, log.length - BUFFER_SIZE);

  for (const [ws, state] of agentSockets.get(workspaceId) ?? []) {
    if (opts.websiteId && state.websiteIds && !state.websiteIds.includes(opts.websiteId)) continue;
    send(ws, stamped);
  }
}

/** Send to the visitor sockets attached to one conversation. */
export function sendToConversationVisitors(conversationId: string, event: RealtimeEvent): void {
  for (const ws of visitorSockets.get(conversationId) ?? []) send(ws, event);
}

/**
 * Send to every visitor socket belonging to a workspace.
 *
 * Deliberately resolved through the conversation registry rather than kept as a
 * third map: agent-status changes are rare, and a stale second index is how one
 * customer's status ends up on another's widget.
 */
const conversationOwner = new Map<string, { workspaceId: string; websiteId: string }>();

export function rememberConversationOwner(
  conversationId: string,
  workspaceId: string,
  websiteId: string,
): void {
  conversationOwner.set(conversationId, { workspaceId, websiteId });
}

export function publishToWorkspaceVisitors(workspaceId: string, event: RealtimeEvent): void {
  for (const [conversationId, sockets] of visitorSockets) {
    if (conversationOwner.get(conversationId)?.workspaceId !== workspaceId) continue;
    for (const ws of sockets) send(ws, event);
  }
}

/** Fan a message out to the workspace's agents and to the conversation's visitor. */
export function publishMessage(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  message: unknown,
): void {
  publishToWorkspace(workspaceId, { type: 'message:new', conversationId, message }, { websiteId });
  sendToConversationVisitors(conversationId, { type: 'message:new', conversationId, message });
}

/** Drop bookkeeping for a conversation nobody is connected to any more. */
export function forgetConversation(conversationId: string): void {
  if (!visitorSockets.has(conversationId)) conversationOwner.delete(conversationId);
}

export interface SocketStats {
  /** Workspaces with at least one agent socket — the vendor's "who is working". */
  workspacesWithAgents: number;
  agentSockets: number;
  visitorSockets: number;
  conversationsWithVisitors: number;
  /** The widest workspace, so one customer's fanout cost is visible on its own. */
  largestWorkspaceAgentSockets: number;
}

/**
 * A read-only census of the registries above, for the ops health page.
 *
 * Aggregate counts only, deliberately: the vendor panel gets "how loaded is the
 * realtime plane", never a list of who is connected. Watching a specific visitor
 * stays on the tenant side behind impersonation with a recorded reason.
 */
export function socketStats(): SocketStats {
  let agents = 0;
  let largest = 0;
  for (const sockets of agentSockets.values()) {
    agents += sockets.size;
    if (sockets.size > largest) largest = sockets.size;
  }
  let visitors = 0;
  for (const set of visitorSockets.values()) visitors += set.size;

  return {
    workspacesWithAgents: agentSockets.size,
    agentSockets: agents,
    visitorSockets: visitors,
    conversationsWithVisitors: visitorSockets.size,
    largestWorkspaceAgentSockets: largest,
  };
}
