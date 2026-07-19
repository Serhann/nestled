import type { WebSocket } from 'ws';
import { prisma } from '../db/prisma.js';
import { startWatch, stopWatch } from './replay.js';

/**
 * In-process realtime hub. Replaces Supabase realtime channels. Agents get a
 * firehose of conversation/message events; a visitor socket only receives
 * events for its own conversation.
 *
 * Agent sockets also carry which conversation the agent is *actively viewing*
 * (reported over WS). Web Push (Phase 2) uses this to skip notifying an agent
 * who is already looking at the conversation — they don't need a push for a
 * message on screen in front of them.
 */

export type RealtimeEvent =
  | { type: 'conversation:new'; conversation: unknown }
  | { type: 'conversation:updated'; conversation: unknown }
  | { type: 'message:new'; conversationId: string; message: unknown }
  | { type: 'typing'; conversationId: string; from: 'visitor' | 'agent'; isTyping: boolean }
  | { type: 'presence:list'; visitors: unknown[] }
  | { type: 'agent:status'; online: boolean }
  // Sent to a conversation's visitor when an agent claims/joins it, so the widget
  // can release its "waiting for an agent" hold.
  | { type: 'agent:joined'; conversationId: string; agentName: string | null };

interface AgentSocketState {
  agentId: string;
  viewing: string | null; // conversation id currently on screen, if any
}

const agentSockets = new Map<WebSocket, AgentSocketState>();
const visitorSockets = new Map<string, Set<WebSocket>>();

// How many live sockets each agent has (multiple tabs/devices). Drives the
// persisted agents.is_online flag, which Phase 7 uses for AI takeover.
const agentSocketCounts = new Map<string, number>();

function setAgentOnline(agentId: string, online: boolean): void {
  void prisma.agents
    .updateMany({ where: { id: agentId }, data: { is_online: online, last_seen: new Date() } })
    .catch(() => undefined);
}

function send(ws: WebSocket, event: RealtimeEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

export function anyAgentOnline(): boolean {
  return agentSockets.size > 0;
}

export function registerAgentSocket(ws: WebSocket, agentId: string): void {
  const wasOffline = agentSockets.size === 0;
  agentSockets.set(ws, { agentId, viewing: null });

  // Per-agent presence: first socket for this agent → mark online in the DB.
  const prev = agentSocketCounts.get(agentId) ?? 0;
  agentSocketCounts.set(agentId, prev + 1);
  if (prev === 0) setAgentOnline(agentId, true);

  // First agent online (any) → tell every visitor (widget header + fallback).
  if (wasOffline) broadcastToAllVisitors({ type: 'agent:status', online: true });

  // Inbound control messages from the agent client. Currently only tracks the
  // conversation the agent is viewing, for push suppression.
  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        type?: string;
        conversationId?: string;
        visitorId?: string;
      };
      const state = agentSockets.get(ws);
      if (!state) return;
      if (msg.type === 'view' && typeof msg.conversationId === 'string') {
        state.viewing = msg.conversationId;
      } else if (msg.type === 'unview') {
        state.viewing = null;
      } else if (msg.type === 'watch' && typeof msg.visitorId === 'string') {
        startWatch(ws, msg.visitorId); // MagicBrowse live replay
      } else if (msg.type === 'unwatch') {
        stopWatch(ws);
      }
    } catch {
      // ignore malformed control frames
    }
  });

  ws.on('close', () => {
    agentSockets.delete(ws);
    stopWatch(ws); // drop any MagicBrowse watch
    const remaining = (agentSocketCounts.get(agentId) ?? 1) - 1;
    if (remaining <= 0) {
      agentSocketCounts.delete(agentId);
      setAgentOnline(agentId, false); // last socket for this agent closed
    } else {
      agentSocketCounts.set(agentId, remaining);
    }
    if (agentSockets.size === 0) broadcastToAllVisitors({ type: 'agent:status', online: false });
  });
}

/** Agent ids currently connected (used by push routing / AI takeover). */
export function onlineAgentIds(): Set<string> {
  return new Set(agentSocketCounts.keys());
}

export function registerVisitorSocket(conversationId: string, ws: WebSocket): void {
  let set = visitorSockets.get(conversationId);
  if (!set) {
    set = new Set();
    visitorSockets.set(conversationId, set);
  }
  set.add(ws);
  // Tell the freshly-connected visitor the current agent-online state.
  send(ws, { type: 'agent:status', online: anyAgentOnline() });
  ws.on('close', () => {
    const s = visitorSockets.get(conversationId);
    if (!s) return;
    s.delete(ws);
    if (s.size === 0) visitorSockets.delete(conversationId);
  });
}

/** Agent ids with a live socket that is currently viewing `conversationId`. */
export function agentsViewing(conversationId: string): Set<string> {
  const ids = new Set<string>();
  for (const state of agentSockets.values()) {
    if (state.viewing === conversationId) ids.add(state.agentId);
  }
  return ids;
}

/** Broadcast to every connected agent (conversation list, notifications). */
export function broadcastToAgents(event: RealtimeEvent): void {
  for (const ws of agentSockets.keys()) send(ws, event);
}

/** Send to the visitor sockets attached to a single conversation. */
export function sendToConversationVisitors(conversationId: string, event: RealtimeEvent): void {
  const set = visitorSockets.get(conversationId);
  if (!set) return;
  for (const ws of set) send(ws, event);
}

/** Send to every connected visitor conversation socket (e.g. agent status). */
export function broadcastToAllVisitors(event: RealtimeEvent): void {
  for (const set of visitorSockets.values()) {
    for (const ws of set) send(ws, event);
  }
}

/** Fan a message out to both the agent firehose and the conversation visitor. */
export function publishMessage(conversationId: string, message: unknown): void {
  broadcastToAgents({ type: 'message:new', conversationId, message });
  sendToConversationVisitors(conversationId, { type: 'message:new', conversationId, message });
}
