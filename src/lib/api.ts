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
  return fetch(`${apiBase()}/api/widget-config`).then((r) => json<{ settings: WidgetConfig }>(r));
}

export function getAgentStatus(): Promise<{ online: boolean }> {
  return fetch(`${apiBase()}/api/agent-status`).then((r) => json<{ online: boolean }>(r));
}

export function getGeo(): Promise<{ country_code: string | null }> {
  return fetch(`${apiBase()}/api/geo`).then((r) => json<{ country_code: string | null }>(r));
}

export function getActiveTriggers(): Promise<{ triggers: unknown[] }> {
  return fetch(`${apiBase()}/api/triggers/active`).then((r) => json<{ triggers: unknown[] }>(r));
}

/** Fire-and-forget trigger analytics ping. */
export function fireTrigger(id: string): void {
  void fetch(`${apiBase()}/api/triggers/${id}/fire`, { method: 'POST' }).catch(() => undefined);
}

export function createConversation(body: {
  visitor_id: string;
  visitor_name?: string;
  visitor_email?: string;
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
  };
  return ws;
}
