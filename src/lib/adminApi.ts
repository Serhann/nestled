/*
 * Admin (agent) API client for the self-hosted backend (Phase 5). Handles the
 * JWT access/refresh dance, agent REST endpoints, the agent realtime WebSocket,
 * and the live-visitor presence board. The admin app is a PWA; the same origin
 * hosts it and (typically) proxies to this API, but the base is configurable via
 * VITE_API_BASE for split-origin deploys.
 */

const ACCESS_KEY = 'jetchat_admin_access';
const REFRESH_KEY = 'jetchat_admin_refresh';
const AGENT_KEY = 'jetchat_admin_agent';

export interface AdminAgent {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
}

export interface AdminConversation {
  id: string;
  visitor_id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  status: 'open' | 'pending' | 'resolved';
  assigned_agent_id: string | null;
  needs_human: boolean;
  message_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_sender: 'visitor' | 'agent' | 'ai' | null;
}

/**
 * Which site / scenario pack a conversation came from, for a scannable label in
 * the inbox. Derived from `widget_mode` (set by the embed's data-mode), falling
 * back to the host page's hostname.
 */
export function conversationSource(
  metadata: Record<string, unknown> | null | undefined,
): { label: string; tone: 'food' | 'saas' | 'web' } {
  const mode = metadata?.widget_mode;
  if (mode === 'saas') return { label: 'TryJet', tone: 'saas' };
  if (mode === 'food') return { label: 'JetFood', tone: 'food' };
  const page = metadata?.current_page;
  if (typeof page === 'string') {
    try {
      return { label: new URL(page).hostname.replace(/^www\./, ''), tone: 'web' };
    } catch {
      /* not a URL */
    }
  }
  return { label: 'Web', tone: 'web' };
}

export interface AdminMessage {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  sender_id: string | null;
  metadata: { attachment?: AdminAttachment; [k: string]: unknown };
  created_at: string;
}

export interface AdminAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  url: string;
}

export interface VisitorGeo {
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
  isp?: string | null;
  org?: string | null;
}

/** HMAC-verified host context (customer + orders) — same shape in conversation
 *  metadata (`verified_context`) and on a live-visitor presence entry. */
export interface VerifiedContext {
  customer?: {
    id?: string | number;
    name?: string;
    email?: string;
    phone?: string;
    orders_count?: number;
    since?: string;
  };
  current_order?: {
    id?: string;
    status?: string;
    eta?: string;
    restaurant?: string;
    total?: string | number;
    currency?: string;
    date?: string;
    url?: string;
  };
  recent_orders?: { id?: string; status?: string; total?: string | number; date?: string; restaurant?: string }[];
}

export interface LiveVisitor {
  visitorId: string;
  url: string | null;
  referrer: string | null;
  device: 'mobile' | 'desktop';
  returning: boolean;
  pagesViewed: number;
  pages: { url: string; at: number }[];
  ip: string;
  geo: VisitorGeo | null;
  conversationId: string | null;
  mode?: string;
  name?: string | null; // identified customer (from verified host context)
  email?: string | null;
  online: boolean;
  timeOnSite: number;
  utm?: Record<string, string>;
  screen?: { w: number; h: number } | null;
  userAgent?: string | null;
  language?: string | null;
  timezone?: string | null;
  context?: VerifiedContext | null; // trusted customer/order context
  sessionStart?: number;
}

/** Site / scenario label for a live visitor (mirrors conversationSource). */
export function visitorSource(v: { mode?: string; url?: string | null }): {
  label: string;
  tone: 'food' | 'saas' | 'web';
} {
  if (v.mode === 'saas') return { label: 'TryJet', tone: 'saas' };
  if (v.mode === 'food') return { label: 'JetFood', tone: 'food' };
  if (v.url) {
    try {
      return { label: new URL(v.url).hostname.replace(/^www\./, ''), tone: 'web' };
    } catch {
      /* not a URL */
    }
  }
  return { label: 'Web', tone: 'web' };
}

export function apiBase(): string {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_API_BASE || '';
  return (env || window.location.origin).replace(/\/$/, '');
}
function wsBase(): string {
  return apiBase().replace(/^http/, 'ws');
}

export const tokens = {
  access: () => localStorage.getItem(ACCESS_KEY),
  refresh: () => localStorage.getItem(REFRESH_KEY),
  agent: (): AdminAgent | null => {
    const raw = localStorage.getItem(AGENT_KEY);
    return raw ? (JSON.parse(raw) as AdminAgent) : null;
  },
  set(access: string, refresh: string, agent: AdminAgent) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
    localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(AGENT_KEY);
  },
};

async function refreshAccess(): Promise<boolean> {
  const refresh = tokens.refresh();
  if (!refresh) return false;
  const res = await fetch(`${apiBase()}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { access_token: string; refresh_token: string; agent: AdminAgent };
  tokens.set(data.access_token, data.refresh_token, data.agent);
  return true;
}

/** fetch with the access token; on a 401 it refreshes once and retries. */
async function authed(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  const access = tokens.access();
  if (access) headers.set('Authorization', `Bearer ${access}`);
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (res.status === 401 && retry && (await refreshAccess())) {
    return authed(path, init, false);
  }
  return res;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function login(email: string, password: string): Promise<AdminAgent> {
  const res = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Invalid email or password' : 'Login failed');
  const data = (await res.json()) as { access_token: string; refresh_token: string; agent: AdminAgent };
  tokens.set(data.access_token, data.refresh_token, data.agent);
  return data.agent;
}

/**
 * Change your own password. Requires the current password. On success the
 * server revokes other sessions; the current one keeps working until its access
 * token expires.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await authed(`/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) {
    const msg = await res
      .json()
      .then((d: { error?: string }) => d.error)
      .catch(() => undefined);
    throw new Error(msg || 'Could not change password');
  }
}

export async function logout(): Promise<void> {
  const refresh = tokens.refresh();
  if (refresh) {
    await fetch(`${apiBase()}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    }).catch(() => undefined);
  }
  tokens.clear();
}

// ── Conversations ─────────────────────────────────────────────────────────────
export async function listConversations(status?: string): Promise<AdminConversation[]> {
  const q = status ? `?status=${status}` : '';
  const r = await authed(`/api/agent/conversations${q}`);
  return (await jsonOrThrow<{ conversations: AdminConversation[] }>(r)).conversations;
}

export async function getConversation(
  id: string,
): Promise<{ conversation: AdminConversation; messages: AdminMessage[] }> {
  const r = await authed(`/api/agent/conversations/${id}`);
  return jsonOrThrow(r);
}

export async function reply(id: string, content: string): Promise<AdminMessage> {
  const r = await authed(`/api/agent/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return (await jsonOrThrow<{ message: AdminMessage }>(r)).message;
}

export async function setStatus(id: string, status: 'open' | 'pending' | 'resolved'): Promise<void> {
  await authed(`/api/agent/conversations/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

/** Set/rename the visitor's name (and optionally email) on a conversation. */
export async function updateVisitor(
  id: string,
  body: { visitor_name?: string | null; visitor_email?: string | null },
): Promise<void> {
  await authed(`/api/agent/conversations/${id}/visitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface VisitorIp {
  id: string;
  visitor_id: string;
  ip: string;
  geo: VisitorGeo | null;
  hits: number;
  first_seen: string;
  last_seen: string;
}
/** Every IP a visitor has connected from (across sessions / IP changes). */
export async function listVisitorIps(visitorId: string): Promise<VisitorIp[]> {
  const r = await authed(`/api/agent/visitors/${encodeURIComponent(visitorId)}/ips`);
  return (await jsonOrThrow<{ ips: VisitorIp[] }>(r)).ips;
}

// ── Cross-site people pool ──────────────────────────────────────────────────
export interface PersonProfile {
  id: string;
  display_name: string | null;
  primary_email: string | null;
  created_at: string;
  visitor_ids: string[];
  sites: string[];
  emails: string[];
  fingerprints: number;
  conversations: {
    id: string;
    visitor_id: string;
    visitor_name: string | null;
    status: string;
    mode: string | null;
    message_count: number;
    updated_at: string;
  }[];
  ips: { ip: string; geo: VisitorGeo | null; hits: number; last_seen: string }[];
}

/**
 * The unified cross-site person a visitor id resolves to — every site, email,
 * IP and conversation fused under one identity via device fingerprint. Returns
 * null if this visitor has not been pooled yet.
 */
export async function getVisitorPerson(visitorId: string): Promise<PersonProfile | null> {
  const r = await authed(`/api/agent/visitors/${encodeURIComponent(visitorId)}/person`);
  return (await jsonOrThrow<{ person: PersonProfile | null }>(r)).person;
}

// ── Assignment ────────────────────────────────────────────────────────────────
/** Omit agentId to claim for yourself; pass null to release to the pool. */
export async function assignConversation(id: string, agentId?: string | null): Promise<void> {
  await authed(`/api/agent/conversations/${id}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentId === undefined ? {} : { agent_id: agentId }),
  });
}

// ── Internal notes ───────────────────────────────────────────────────────────
export interface ConversationNote {
  id: string;
  agent_name: string | null;
  content: string;
  created_at: string;
}
export async function getNotes(id: string): Promise<ConversationNote[]> {
  const r = await authed(`/api/agent/conversations/${id}/notes`);
  return (await jsonOrThrow<{ notes: ConversationNote[] }>(r)).notes;
}
export async function addNote(id: string, content: string): Promise<ConversationNote> {
  const r = await authed(`/api/agent/conversations/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return (await jsonOrThrow<{ note: ConversationNote }>(r)).note;
}

// ── Canned responses ──────────────────────────────────────────────────────────
export interface CannedResponse {
  id: string;
  shortcut: string;
  title: string;
  content: string;
  sites: string[]; // which sites/modes this applies to; empty = all
}
export async function listCanned(): Promise<CannedResponse[]> {
  const r = await authed('/api/canned-responses');
  return (await jsonOrThrow<{ items: CannedResponse[] }>(r)).items;
}
export async function createCanned(body: Omit<CannedResponse, 'id'>): Promise<void> {
  await authed('/api/canned-responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
export async function deleteCanned(id: string): Promise<void> {
  await authed(`/api/canned-responses/${id}`, { method: 'DELETE' });
}

// ── Sites (site manager, admin) ───────────────────────────────────────────────
export interface SiteQuickAction {
  intent: string;
  label?: string;
}
export interface Site {
  id: string;
  key: string;
  name: string;
  is_active: boolean;
  primary_color: string | null;
  widget_title: string | null;
  welcome_message: string | null;
  widget_position: 'left' | 'right' | null;
  system_prompt: string | null;
  pre_chat_enabled: boolean | null; // null = inherit global; true = site fields; false = off
  pre_chat_fields: SitePreChatField[];
  quick_actions: SiteQuickAction[];
  allowed_domains: string[];
  enforce_domains: boolean;
  context_secret: string | null; // shared HMAC secret for signed host context
}
export interface SitePreChatField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel';
  required: boolean;
  placeholder: string;
}
export type SiteInput = Omit<Site, 'id'>;

export interface SiteDomain {
  id: string;
  site_key: string;
  host: string;
  hits: number;
  authorized: boolean;
  first_seen: string;
  last_seen: string;
}
export async function listSiteDomains(): Promise<SiteDomain[]> {
  const r = await authed('/api/sites/domains');
  return (await jsonOrThrow<{ domains: SiteDomain[] }>(r)).domains;
}

export async function listSites(): Promise<Site[]> {
  const r = await authed('/api/sites');
  return (await jsonOrThrow<{ sites: Site[] }>(r)).sites;
}
export async function createSite(body: SiteInput): Promise<void> {
  const r = await authed('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That site key already exists' : 'Could not save');
}
export async function updateSite(id: string, body: SiteInput): Promise<void> {
  const r = await authed(`/api/sites/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That site key already exists' : 'Could not save');
}
export async function deleteSite(id: string): Promise<void> {
  await authed(`/api/sites/${id}`, { method: 'DELETE' });
}

// ── Quick actions (managed, admin) ────────────────────────────────────────────
export interface QuickActionField {
  name: string;
  label: string;
  required: boolean;
}
export interface QuickActionDef {
  id: string;
  key: string;
  label: string;
  kind: 'auto' | 'human';
  visitor_template: string;
  reply_template: string;
  suggestion: string | null;
  fields: QuickActionField[];
  priority: number;
  is_active: boolean;
}
export type QuickActionInput = Omit<QuickActionDef, 'id'>;

export async function listQuickActions(): Promise<QuickActionDef[]> {
  const r = await authed('/api/quick-actions');
  return (await jsonOrThrow<{ items: QuickActionDef[] }>(r)).items;
}
export async function createQuickAction(body: QuickActionInput): Promise<void> {
  const r = await authed('/api/quick-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That key already exists' : 'Could not save');
}
export async function updateQuickAction(id: string, body: QuickActionInput): Promise<void> {
  const r = await authed(`/api/quick-actions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That key already exists' : 'Could not save');
}
export async function deleteQuickAction(id: string): Promise<void> {
  await authed(`/api/quick-actions/${id}`, { method: 'DELETE' });
}

// ── Live translation (agent) ──────────────────────────────────────────────────
export async function translate(text: string, to: string): Promise<string> {
  const r = await authed('/api/agent/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, to }),
  });
  return (await jsonOrThrow<{ text: string }>(r)).text;
}

// ── Settings + AI usage (admin) ───────────────────────────────────────────────
export interface AdminSettings {
  public: Record<string, unknown>;
  private: Record<string, unknown>;
}
export async function getSettings(): Promise<AdminSettings> {
  const r = await authed('/api/settings');
  return jsonOrThrow<AdminSettings>(r);
}
export async function updatePublicSettings(body: Record<string, unknown>): Promise<void> {
  await authed('/api/settings/public', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
export async function updatePrivateSettings(body: Record<string, unknown>): Promise<void> {
  await authed('/api/settings/private', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
export async function getAiUsage(): Promise<{ replies: number; input_tokens: number; output_tokens: number }> {
  const r = await authed('/api/ai/usage');
  return (await jsonOrThrow<{ month: { replies: number; input_tokens: number; output_tokens: number } }>(r)).month;
}

// ── Knowledge base ────────────────────────────────────────────────────────────
export interface KBItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  priority: number;
  is_active: boolean;
  sites: string[]; // which sites/modes this applies to; empty = all
}
export type KBInput = Omit<KBItem, 'id'>;

export async function listKB(): Promise<KBItem[]> {
  const r = await authed('/api/knowledge-base');
  return (await jsonOrThrow<{ items: KBItem[] }>(r)).items;
}
export async function createKB(body: KBInput): Promise<void> {
  const r = await authed('/api/knowledge-base', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Could not save');
}
export async function updateKB(id: string, body: KBInput): Promise<void> {
  const r = await authed(`/api/knowledge-base/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Could not save');
}
export async function deleteKB(id: string): Promise<void> {
  await authed(`/api/knowledge-base/${id}`, { method: 'DELETE' });
}

// ── Triggers (admin) ──────────────────────────────────────────────────────────
export interface TriggerFull {
  id: string;
  name: string;
  identifier: string;
  is_active: boolean;
  priority: number;
  fire_count: number;
  conversation_count: number;
  sites: string[]; // which sites/modes this applies to; empty = all
  actions: Record<string, unknown> | null;
  events: Record<string, unknown> | null;
  behaviors: Record<string, unknown> | null;
  platforms: Record<string, unknown> | null;
}
export interface TriggerInput {
  name: string;
  identifier: string;
  is_active: boolean;
  priority: number;
  sites: string[]; // which sites/modes this applies to; empty = all
  actions: {
    show_message: boolean;
    message_content: string | null;
    localized_messages: Record<string, string>;
    open_chatbox: boolean;
    play_sound: boolean;
  };
  events: {
    on_leave_intent: boolean;
    on_click_link: boolean;
    click_selectors: string[];
    on_pages: boolean;
    page_urls: string[];
    on_url_parameters: boolean;
    url_parameters: Record<string, string>;
    after_delay: boolean;
    delay_seconds: number;
  };
  behaviors: {
    show_as_website: boolean;
    execute_if_online: boolean;
    execute_on_first_visit: boolean;
    execute_if_no_other_trigger: boolean;
    country_restriction: string[];
  };
  platforms: { desktop_enabled: boolean; mobile_enabled: boolean };
}
export async function listTriggers(): Promise<TriggerFull[]> {
  const r = await authed('/api/triggers');
  return (await jsonOrThrow<{ triggers: TriggerFull[] }>(r)).triggers;
}
export async function createTrigger(body: TriggerInput): Promise<void> {
  const r = await authed('/api/triggers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That identifier already exists' : 'Could not save');
}
export async function updateTrigger(id: string, body: TriggerInput): Promise<void> {
  const r = await authed(`/api/triggers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Could not save');
}
export async function deleteTrigger(id: string): Promise<void> {
  await authed(`/api/triggers/${id}`, { method: 'DELETE' });
}

// ── Agents (admin) ────────────────────────────────────────────────────────────
export interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  is_online: boolean;
  last_seen: string;
  avatar_url: string | null;
}
export async function listAgents(): Promise<AgentRow[]> {
  const r = await authed('/api/agents');
  return (await jsonOrThrow<{ agents: AgentRow[] }>(r)).agents;
}
export async function createAgent(body: {
  name: string;
  email: string;
  password: string;
  role: 'admin' | 'agent';
}): Promise<void> {
  const r = await authed('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 409 ? 'That email already exists' : 'Could not create agent');
}
export async function deleteAgent(id: string): Promise<void> {
  const r = await authed(`/api/agents/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Could not delete agent');
}
export async function uploadAgentAvatar(id: string, file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  const r = await authed(`/api/agents/${id}/avatar`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(r.status === 413 ? 'Image too large (max 2 MB)' : 'Could not upload avatar');
}

export async function uploadAttachment(id: string, file: File): Promise<AdminMessage> {
  const form = new FormData();
  form.append('file', file);
  const r = await authed(`/api/agent/conversations/${id}/attachments`, { method: 'POST', body: form });
  return (await jsonOrThrow<{ message: AdminMessage }>(r)).message;
}

export function sendTyping(id: string, isTyping: boolean): void {
  void authed(`/api/agent/conversations/${id}/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_typing: isTyping }),
  }).catch(() => undefined);
}

export function attachmentUrl(path: string): string {
  return `${apiBase()}${path}?jwt=${encodeURIComponent(tokens.access() ?? '')}`;
}

// ── Live visitors / proactive ─────────────────────────────────────────────────
export async function getPresence(): Promise<LiveVisitor[]> {
  const r = await authed('/api/agent/presence');
  return (await jsonOrThrow<{ visitors: LiveVisitor[] }>(r)).visitors;
}

export async function startChat(
  visitorId: string,
  message: string,
): Promise<{ conversation_id: string; delivered: boolean }> {
  const r = await authed(`/api/agent/presence/${visitorId}/start-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return jsonOrThrow(r);
}

// ── Realtime (agent WS) ───────────────────────────────────────────────────────
export interface AgentWSHandlers {
  onConversationNew?: () => void;
  onConversationUpdated?: (conversationId?: string) => void;
  onMessage?: (conversationId: string, message: AdminMessage) => void;
  onTyping?: (conversationId: string, isTyping: boolean) => void;
  onPresence?: (visitors: LiveVisitor[]) => void;
  onReplay?: (visitorId: string, events: unknown[], reset: boolean) => void;
}

export interface AgentSocket {
  view: (conversationId: string | null) => void;
  watch: (visitorId: string | null) => void;
  /** Live Assist: relay a guiding pointer/click/banner to the watched visitor. */
  assist: (visitorId: string, payload: Record<string, unknown>) => void;
  close: () => void;
}

/** Open the agent realtime socket. Reconnects with backoff; auto-uses the token. */
export function openAgentWS(handlers: AgentWSHandlers): AgentSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let viewing: string | null = null;

  const connect = () => {
    if (closed) return;
    const access = tokens.access();
    if (!access) return;
    ws = new WebSocket(`${wsBase()}/ws/agent?token=${encodeURIComponent(access)}`);
    ws.onopen = () => {
      delay = 1000;
      if (viewing && ws) ws.send(JSON.stringify({ type: 'view', conversationId: viewing }));
    };
    ws.onmessage = (event) => {
      let e: { type?: string; [k: string]: unknown };
      try {
        e = JSON.parse(event.data);
      } catch {
        return;
      }
      if (e.type === 'conversation:new') handlers.onConversationNew?.();
      else if (e.type === 'conversation:updated')
        handlers.onConversationUpdated?.((e.conversation as { id?: string } | undefined)?.id);
      else if (e.type === 'message:new')
        handlers.onMessage?.(e.conversationId as string, e.message as AdminMessage);
      else if (e.type === 'typing' && e.from === 'visitor')
        handlers.onTyping?.(e.conversationId as string, Boolean(e.isTyping));
      else if (e.type === 'presence:list') handlers.onPresence?.(e.visitors as LiveVisitor[]);
      else if (e.type === 'rrweb:events')
        handlers.onReplay?.(e.visitorId as string, (e.events as unknown[]) ?? [], Boolean(e.reset));
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  return {
    view(conversationId) {
      viewing = conversationId;
      send(conversationId ? { type: 'view', conversationId } : { type: 'unview' });
    },
    watch(visitorId) {
      send(visitorId ? { type: 'watch', visitorId } : { type: 'unwatch' });
    },
    assist(visitorId, payload) {
      send({ type: 'assist', visitorId, assist: payload });
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
