import type { ChatMessage, ContextCard } from '../types/chat';

/**
 * The visitor plane's REST client.
 *
 * Two credentials, never mixed up:
 *
 *   session_token  signed by us, proves "this browser is a visitor of website X
 *                  with visitor id Y". Sent in the BODY of the endpoints that
 *                  create things, and on the presence socket's query string.
 *   visitor_token  a per-conversation secret returned once at creation. Sent as
 *                  a bearer header on that conversation's endpoints.
 *
 * The session token is what closed the presence takeover, so it is deliberately
 * awkward to confuse the two: they have different names, different transports
 * and different lifetimes.
 */

export interface Session {
  session_token: string;
  visitor_id: string;
}

export interface Conversation {
  id: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`api ${status}`);
  }
}

export function createApi(base: string) {
  async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const { token, ...rest } = init;
    const res = await fetch(`${base}${path}`, {
      ...rest,
      credentials: 'omit',
      headers: {
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.json().catch(() => null));
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  const post = <T>(path: string, body: unknown, token?: string) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), token });

  return {
    /** Exchange the public key for the signed session the sockets authenticate with. */
    session: (key: string, visitorId: string | null, href: string) =>
      post<Session>('/api/v1/widget/session', { key, visitor_id: visitorId ?? undefined, href }),

    createConversation: (body: {
      session_token: string;
      visitor_name?: string;
      visitor_email?: string;
      fingerprint?: string;
      context_token?: string;
      metadata?: Record<string, unknown>;
    }) =>
      post<{ conversation_id: string; visitor_token: string }>('/api/v1/widget/conversations', body),

    /**
     * Redeem a proactive chat's single-use claim for the real visitor token.
     *
     * The proactive frame never carries the visitor token itself, so this
     * exchange — which requires THIS browser's own session — is the only way to
     * turn an agent-initiated conversation into one we can write to.
     */
    claim: (conversationId: string, claimToken: string, sessionToken: string) =>
      post<{ visitor_token: string }>(`/api/v1/widget/conversations/${conversationId}/claim`, {
        claim_token: claimToken,
        session_token: sessionToken,
      }),

    messages: (conv: Conversation) =>
      request<{ messages: ChatMessage[] }>(
        `/api/v1/widget/conversations/${conv.id}/messages`,
        { token: conv.token },
      ),

    send: (conv: Conversation, content: string) =>
      post<{ message: ChatMessage }>(
        `/api/v1/widget/conversations/${conv.id}/messages`,
        { content },
        conv.token,
      ),

    typing: (conv: Conversation, isTyping: boolean) =>
      post(`/api/v1/widget/conversations/${conv.id}/typing`, { is_typing: isTyping }, conv.token),

    /**
     * Push a freshly signed host context onto a live conversation.
     *
     * `context_card` is read back if the server sends one. It does not today —
     * see ContextCard.tsx — but the widget must never derive a card itself, so
     * this is the seam where a server-rendered one will arrive.
     */
    attributes: (conv: Conversation, token: string) =>
      post<{ ok: boolean; context_card?: ContextCard }>(
        `/api/v1/widget/conversations/${conv.id}/attributes`,
        { token },
        conv.token,
      ),

    rate: (conv: Conversation, body: { stars: number; tags?: string[]; comment?: string }) =>
      post(`/api/v1/widget/conversations/${conv.id}/rating`, body, conv.token),

    offlineMessage: (sessionToken: string, email: string, message: string) =>
      post<{ conversation_id: string; visitor_token: string }>('/api/v1/widget/offline-message', {
        session_token: sessionToken,
        email,
        message,
      }),

    /** Fire-and-forget analytics; a failure here must never surface to a visitor. */
    fireTrigger: (id: string) => {
      void post(`/api/v1/widget/triggers/${id}/fire`, {}).catch(() => undefined);
    },
  };
}

export type WidgetApi = ReturnType<typeof createApi>;
