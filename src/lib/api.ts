/*
 * Widget API client for the self-hosted backend (Phase 4). Replaces the direct
 * Supabase access the old widget used. REST for CRUD, WebSocket for realtime.
 * The API origin comes from the `api` URL param the embed passes to the iframe,
 * falling back to the widget's own origin (useful when both are same-origin).
 */

export interface WidgetConfig {
  widget_title: string;
  welcome_message: string;
  primary_color: string;
  widget_position: 'left' | 'right';
  widget_avatar_url: string | null;
  ai_enabled: boolean;
  pre_chat_enabled: boolean;
  pre_chat_fields: PreChatField[];
  auto_welcome_enabled: boolean;
  auto_welcome_message: string | null;
  auto_welcome_delay: number;
  notification_sound_enabled: boolean;
  // Per-site quick actions (Site + Quick-action managers). Empty → widget uses
  // its built-in pack. `fields` = an intake form to collect before running.
  quick_actions?: WidgetQuickAction[];
  // Domain allowlist result for this load (Site manager). authorized=false means
  // the host domain isn't in the site's allowlist; enforce_domains hides the widget.
  authorized?: boolean;
  enforce_domains?: boolean;
}

export interface WidgetField {
  name: string;
  label: string;
  required: boolean;
}
export interface WidgetQuickAction {
  intent: string;
  label?: string;
  kind?: 'auto' | 'human';
  fields?: WidgetField[];
}

export interface PreChatField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel';
  required: boolean;
  placeholder: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  url: string; // path like /api/attachments/:id
}

export interface WidgetMessage {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  sender_id: string | null;
  metadata: {
    attachment?: Attachment;
    agent?: { name: string; avatar_url: string | null };
    [k: string]: unknown;
  };
  created_at: string;
}

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function apiBase(): string {
  return (param('api') || window.location.origin).replace(/\/$/, '');
}

function wsBase(): string {
  return apiBase().replace(/^http/, 'ws');
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function getWidgetConfig(): Promise<{ settings: WidgetConfig }> {
  const site = param('mode') || 'food';
  const href = param('href') || document.referrer || '';
  const q = `site=${encodeURIComponent(site)}${href ? `&href=${encodeURIComponent(href)}` : ''}`;
  return fetch(`${apiBase()}/api/widget-config?${q}`).then((r) => json<{ settings: WidgetConfig }>(r));
}

export function getAgentStatus(): Promise<{ online: boolean }> {
  return fetch(`${apiBase()}/api/agent-status`).then((r) => json<{ online: boolean }>(r));
}

export function getGeo(): Promise<{ country_code: string | null }> {
  return fetch(`${apiBase()}/api/geo`).then((r) => json<{ country_code: string | null }>(r));
}

export function getActiveTriggers(): Promise<{ triggers: unknown[] }> {
  const mode = param('mode') || 'food';
  return fetch(`${apiBase()}/api/triggers/active?mode=${encodeURIComponent(mode)}`).then((r) => json<{ triggers: unknown[] }>(r));
}

/** Fire-and-forget trigger analytics ping. */
export function fireTrigger(id: string): void {
  void fetch(`${apiBase()}/api/triggers/${id}/fire`, { method: 'POST' }).catch(() => undefined);
}

export function createConversation(body: {
  visitor_id: string;
  visitor_name?: string;
  visitor_email?: string;
  fingerprint?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ conversation_id: string; visitor_token: string }> {
  return fetch(`${apiBase()}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<{ conversation_id: string; visitor_token: string }>(r));
}

export function getMessages(convId: string, token: string): Promise<{ messages: WidgetMessage[] }> {
  return fetch(`${apiBase()}/api/conversations/${convId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => json<{ messages: WidgetMessage[] }>(r));
}

export function sendMessage(
  convId: string,
  token: string,
  content: string,
): Promise<{ message: WidgetMessage }> {
  return fetch(`${apiBase()}/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
  }).then((r) => json<{ message: WidgetMessage }>(r));
}

// Quick-action keys are now data-driven (managed in the admin), so this is a
// free string rather than a fixed union.
export type QuickIntent = string;

/** Post an order-aware quick action; returns the visitor request + bot reply. */
export function quickAction(
  convId: string,
  token: string,
  intent: QuickIntent,
  order?: { id?: string; status?: string; eta?: string; restaurant?: string },
  fields?: Record<string, string>,
): Promise<{ messages: WidgetMessage[]; needs_human: boolean }> {
  return fetch(`${apiBase()}/api/conversations/${convId}/quick-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ intent, order, fields }),
  }).then((r) => json<{ messages: WidgetMessage[]; needs_human: boolean }>(r));
}

export function uploadAttachment(
  convId: string,
  token: string,
  file: File,
): Promise<{ message: WidgetMessage }> {
  const form = new FormData();
  form.append('file', file);
  return fetch(`${apiBase()}/api/conversations/${convId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  }).then((r) => json<{ message: WidgetMessage }>(r));
}

export function sendTyping(convId: string, token: string, isTyping: boolean): void {
  void fetch(`${apiBase()}/api/conversations/${convId}/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ is_typing: isTyping }),
  }).catch(() => undefined);
}

/** Full, token-authenticated URL for an attachment (works as an <img src>). */
export function attachmentUrl(path: string, token: string): string {
  return `${apiBase()}${path}?token=${encodeURIComponent(token)}`;
}

export interface WSHandlers {
  onMessage?: (m: WidgetMessage) => void;
  onTyping?: (isTyping: boolean) => void;
  onAgentStatus?: (online: boolean) => void;
  onAgentJoined?: (agentName: string | null) => void;
}

export interface PresenceProactive {
  conversation_id: string;
  visitor_token: string;
  message: string;
  agent_name: string;
}

/**
 * Open a host-page presence connection from the widget itself. Used only when
 * the widget runs standalone (demo / opened directly) — in the real embed the
 * host page's presence.js is authoritative and reports the true host URL, so the
 * widget must NOT double-report there. Announces the visitor, heartbeats, and
 * forwards any proactive "open the chat" push. Returns a stop() handle.
 */
export function openPresenceWS(
  visitorId: string,
  handlers: { onProactive?: (p: PresenceProactive) => void; fingerprint?: string } = {},
): { stop: () => void } {
  let ws: WebSocket | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let delay = 1000;

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const returning = (() => {
    try {
      const was = localStorage.getItem('jetchat_returning') === '1';
      localStorage.setItem('jetchat_returning', '1');
      return was;
    } catch {
      return false;
    }
  })();
  const sessionStart = Date.now();

  const hello = () =>
    JSON.stringify({
      type: 'hello',
      url: param('href') || document.referrer || window.location.href,
      referrer: document.referrer || null,
      device: isMobile ? 'mobile' : 'desktop',
      screen: { w: window.screen.width, h: window.screen.height },
      returning,
      sessionStart,
      mode: param('mode') || 'food',
      fingerprint: handlers.fingerprint || param('fp') || '',
    });

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${wsBase()}/ws/presence?visitor_id=${encodeURIComponent(visitorId)}`);
    ws.onopen = () => {
      delay = 1000;
      ws?.send(hello());
      hb = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };
    ws.onmessage = (event) => {
      let e: { type?: string; [k: string]: unknown };
      try {
        e = JSON.parse(event.data);
      } catch {
        return;
      }
      if (e.type === 'proactive') handlers.onProactive?.(e as unknown as PresenceProactive);
    };
    ws.onclose = () => {
      if (hb) clearInterval(hb);
      if (closed) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return {
    stop() {
      closed = true;
      if (hb) clearInterval(hb);
      ws?.close();
    },
  };
}

/** Open the visitor conversation WebSocket. Returns the socket for cleanup. */
export function openConversationWS(convId: string, token: string, handlers: WSHandlers): WebSocket {
  const ws = new WebSocket(`${wsBase()}/ws/visitor/${convId}?token=${encodeURIComponent(token)}`);
  ws.onmessage = (event) => {
    let e: { type?: string; [k: string]: unknown };
    try {
      e = JSON.parse(event.data);
    } catch {
      return;
    }
    if (e.type === 'message:new' && e.message) handlers.onMessage?.(e.message as WidgetMessage);
    else if (e.type === 'typing' && e.from === 'agent') handlers.onTyping?.(Boolean(e.isTyping));
    else if (e.type === 'agent:status') handlers.onAgentStatus?.(Boolean(e.online));
    else if (e.type === 'agent:joined') handlers.onAgentJoined?.((e.agentName as string | null) ?? null);
  };
  return ws;
}
