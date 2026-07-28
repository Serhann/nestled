import { del, get, post, put } from '../http';
import type {
  CannedResponse,
  Channel,
  ConversationDetail,
  ConversationRow,
  ConversationStatus,
  KbEntry,
  Message,
  Note,
  PersonProfile,
  PresenceVisitor,
  Starter,
} from './types';

/**
 * The inbox, the live-visitor board, and the content an agent reaches for while
 * replying (knowledge base, canned responses, starters).
 */

const w = (workspaceId: string, path: string): string => `/api/v1/w/${workspaceId}${path}`;

export interface InboxFilters {
  status?: ConversationStatus | 'all';
  channel?: Channel | 'all';
  /** The urgency views. Selecting one also sorts by deadline instead of recency. */
  due?: 'at_risk' | 'breached' | 'waiting' | 'unread';
  website_id?: string;
  /** A member id, or the two special values the server understands. */
  assignee?: string | 'me' | 'unassigned';
  tag?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Filters live in the URL's search params, so this takes them as a plain object
 * and turns them into a query string in one place. That also makes the filter set
 * a natural TanStack Query cache key.
 */
export function inboxQueryString(filters: InboxFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const listConversations = (
  id: string,
  filters: InboxFilters = {},
): Promise<{ conversations: ConversationRow[]; next_cursor: string | null }> =>
  get(w(id, `/conversations${inboxQueryString(filters)}`));

export const getConversation = (
  id: string,
  conversationId: string,
): Promise<{ conversation: ConversationDetail }> => get(w(id, `/conversations/${conversationId}`));

/**
 * Post an agent reply.
 *
 * `delivery` is how the caller learns whether the reply actually reached anybody.
 * On the widget it is always ok; on email or SMS the send can fail after the message
 * is already in the thread, and the agent has to be told rather than left believing
 * they answered.
 */
export const sendReply = (
  id: string,
  conversationId: string,
  content: string,
): Promise<{ message: Message | null; delivery?: { ok: boolean; error?: string } }> =>
  post(w(id, `/conversations/${conversationId}/messages`), { content });

export const setStatus = (
  id: string,
  conversationId: string,
  status: ConversationStatus,
): Promise<{ conversation: { id: string; status: ConversationStatus } }> =>
  post(w(id, `/conversations/${conversationId}/status`), { status });

export const assign = (
  id: string,
  conversationId: string,
  memberId: string | null,
): Promise<{ conversation: { id: string; assigned_member_id: string | null } }> =>
  post(w(id, `/conversations/${conversationId}/assign`), { member_id: memberId });

export const setTags = (
  id: string,
  conversationId: string,
  tags: string[],
): Promise<{ conversation: { id: string; tags: string[] } }> =>
  post(w(id, `/conversations/${conversationId}/tags`), { tags });

/**
 * Typing is a hint, not a fact, and it is sent on a keystroke timer. A failure
 * here must never surface to the agent as an error, so the caller is expected to
 * ignore the rejection — hence the deliberate `.catch`.
 */
export const sendTyping = (id: string, conversationId: string, isTyping: boolean): void => {
  void post(w(id, `/conversations/${conversationId}/typing`), { is_typing: isTyping }).catch(
    () => undefined,
  );
};

export const listNotes = (id: string, conversationId: string): Promise<{ notes: Note[] }> =>
  get(w(id, `/conversations/${conversationId}/notes`));

export const addNote = (
  id: string,
  conversationId: string,
  content: string,
): Promise<{ note: Note }> => post(w(id, `/conversations/${conversationId}/notes`), { content });

/**
 * Translate one piece of text.
 *
 * Always resolves — the server answers 200 even when it could not translate,
 * because this is called while an agent is mid-reply. `translated: false` with a
 * reason means `text` is the ORIGINAL coming back unchanged, and the caller must
 * say so rather than presenting it as a translation.
 */
export const translate = (
  id: string,
  text: string,
  /** A language CODE (`tr`, `en`). The server rejects display names. */
  to: string,
): Promise<{ text: string; translated: boolean; reason?: 'plan_limit' | 'unavailable' }> =>
  post(w(id, '/translate'), { text, to });

// ── Visitors ────────────────────────────────────────────────────────────────
export const listPresence = (id: string): Promise<{ visitors: PresenceVisitor[] }> =>
  get(w(id, '/presence'));

export const startChat = (
  id: string,
  visitorId: string,
  input: { website_id: string; message: string },
): Promise<{ conversation: { id: string }; delivered: boolean }> =>
  post(w(id, `/presence/${encodeURIComponent(visitorId)}/start-chat`), input);

export const visitorIps = (
  id: string,
  visitorId: string,
): Promise<{ ips: { ip: string; country: string | null; city: string | null; last_seen: string }[] }> =>
  get(w(id, `/visitors/${encodeURIComponent(visitorId)}/ips`));

export const visitorPerson = (
  id: string,
  visitorId: string,
): Promise<{ person: PersonProfile | null }> =>
  get(w(id, `/visitors/${encodeURIComponent(visitorId)}/person`));

// ── Content ─────────────────────────────────────────────────────────────────
export const listKb = (id: string): Promise<{ items: KbEntry[] }> => get(w(id, '/kb'));
export const createKb = (id: string, input: Partial<KbEntry>): Promise<{ item: KbEntry }> =>
  post(w(id, '/kb'), input);
export const updateKb = (
  id: string,
  entryId: string,
  input: Partial<KbEntry>,
): Promise<{ item: KbEntry }> => put(w(id, `/kb/${entryId}`), input);
export const deleteKb = (id: string, entryId: string): Promise<{ ok: true }> =>
  del(w(id, `/kb/${entryId}`));

export const listCanned = (id: string): Promise<{ items: CannedResponse[] }> => get(w(id, '/canned'));
export const createCanned = (
  id: string,
  input: Partial<CannedResponse>,
): Promise<{ item: CannedResponse }> => post(w(id, '/canned'), input);
export const updateCanned = (
  id: string,
  entryId: string,
  input: Partial<CannedResponse>,
): Promise<{ item: CannedResponse }> => put(w(id, `/canned/${entryId}`), input);
export const deleteCanned = (id: string, entryId: string): Promise<{ ok: true }> =>
  del(w(id, `/canned/${entryId}`));

export const listStarters = (id: string): Promise<{ items: Starter[] }> => get(w(id, '/starters'));
export const createStarter = (id: string, input: Partial<Starter>): Promise<{ item: Starter }> =>
  post(w(id, '/starters'), input);
export const updateStarter = (
  id: string,
  entryId: string,
  input: Partial<Starter>,
): Promise<{ item: Starter }> => put(w(id, `/starters/${entryId}`), input);
export const deleteStarter = (id: string, entryId: string): Promise<{ ok: true }> =>
  del(w(id, `/starters/${entryId}`));

// ── Response times ──────────────────────────────────────────────────────────

export interface AttentionCounts {
  at_risk: number;
  breached: number;
  unread: number;
  waiting: number;
}

/** Polled by the shell, so the numbers are visible when you are NOT in the queue view. */
export const conversationAttention = (id: string): Promise<AttentionCounts> =>
  get(w(id, '/conversations/attention'));

export const setUnread = (
  id: string,
  conversationId: string,
  unread: boolean,
): Promise<{ conversation: { id: string; unread_at: string | null } | null }> =>
  post(w(id, `/conversations/${conversationId}/unread`), { unread });

export interface ResponseTargets {
  enabled: boolean;
  first_response_minutes: number | null;
  next_response_minutes: number | null;
  business_hours_only: boolean;
  escalate_enabled: boolean;
  escalate_to_member_id: string | null;
  notify_owners: boolean;
}

export const getResponseTargets = (
  id: string,
  websiteId: string,
): Promise<{ targets: ResponseTargets; business_hours: { enabled: boolean; timezone: string } }> =>
  get(w(id, `/websites/${websiteId}/response-targets`));

export const saveResponseTargets = (
  id: string,
  websiteId: string,
  input: ResponseTargets,
): Promise<{ targets: ResponseTargets }> =>
  put(w(id, `/websites/${websiteId}/response-targets`), input);

export interface ResponseTimeReport {
  days: number;
  total: number;
  answered: number;
  unanswered: number;
  breached: number;
  first_response_minutes: {
    p50: number | null;
    p90: number | null;
    fastest: number | null;
    slowest: number | null;
  };
  by_channel: { channel: Channel; answered: number; p50: number | null; p90: number | null }[];
  unit: 'business_minutes';
}

export const responseTimeReport = (id: string, days = 30): Promise<ResponseTimeReport> =>
  get(w(id, `/reports/response-times?days=${days}`));
