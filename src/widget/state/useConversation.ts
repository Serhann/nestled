import { useCallback, useEffect, useRef, useState } from 'react';
import type { BootPayload, ChatMessage, ContextCard } from '../../types/chat';
import { ApiError, type Conversation, type WidgetApi } from '../api';
import type { EmbedParams } from '../boot';
import { openConversationSocket, type RealtimeConnection } from '../realtime';
import { loadConversation, saveConversation } from '../store';

import type { HostState } from './useHostBridge';

interface Options {
  api: WidgetApi;
  params: EmbedParams;
  boot: BootPayload;
  host: React.MutableRefObject<HostState>;
  onIncoming(message: ChatMessage): void;
  onAgentStatus(online: boolean): void;
  onResolved(): void;
}

export interface ConversationState {
  conversation: Conversation | null;
  messages: ChatMessage[];
  agentTyping: boolean;
  /** A human has taken the chat: stop offering starters, they are talking to someone. */
  escalated: boolean;
  sending: boolean;
  error: string | null;
  contextCard: ContextCard | null;
  ensureSession(): Promise<string>;
  ensureConversation(identity?: { name?: string; email?: string }): Promise<Conversation>;
  send(content: string): Promise<void>;
  setTyping(): void;
  rate(body: { stars: number; tags: string[]; comment: string }): Promise<void>;
  /** Redeem a proactive chat's claim token and adopt the conversation. */
  adopt(conversationId: string, claimToken: string): Promise<void>;
  pushContext(token: string): void;
  reset(): void;
  clearError(): void;
}

export function useConversation(opts: Options): ConversationState {
  const { api, params, boot, host } = opts;
  const [conversation, setConversation] = useState<Conversation | null>(() => {
    if (!params.reset) return loadConversation(params.websiteKey);
    saveConversation(params.websiteKey, null);
    return null;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextCard, setContextCard] = useState<ContextCard | null>(boot.context_card ?? null);

  const sessionRef = useRef<Promise<string> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<RealtimeConnection | null>(null);
  const callbacks = useRef(opts);
  callbacks.current = opts;

  /**
   * One session per page load, shared by every caller.
   *
   * Memoised as the PROMISE, not the token: two starters tapped in quick
   * succession would otherwise mint two sessions with two different visitor ids,
   * and the second would not match the presence socket the host page opened.
   */
  const ensureSession = useCallback((): Promise<string> => {
    if (!sessionRef.current) {
      sessionRef.current = api
        .session(params.websiteKey, params.visitorId, params.href)
        .then((s) => s.session_token)
        .catch((err: unknown) => {
          sessionRef.current = null;
          throw err;
        });
    }
    return sessionRef.current;
  }, [api, params.websiteKey, params.visitorId, params.href]);

  const applyConversation = useCallback(
    (next: Conversation | null) => {
      saveConversation(params.websiteKey, next);
      setConversation(next);
    },
    [params.websiteKey],
  );

  const ensureConversation = useCallback(
    async (identity?: { name?: string; email?: string }): Promise<Conversation> => {
      if (conversation) return conversation;
      const sessionToken = await ensureSession();
      const h = host.current;
      const created = await api.createConversation({
        session_token: sessionToken,
        visitor_name: identity?.name ?? h.identity.name,
        visitor_email: identity?.email ?? h.identity.email,
        fingerprint: params.fingerprint ?? undefined,
        context_token: h.contextToken ?? undefined,
        metadata: {
          user_agent: navigator.userAgent,
          language: navigator.language,
          referrer: document.referrer || null,
          current_page: params.href,
          screen_resolution: `${window.screen.width}x${window.screen.height}`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(h.triggerId ? { trigger_id: h.triggerId } : {}),
          ...(Object.keys(h.data).length ? { attributes: h.data } : {}),
          ...(Object.keys(h.prechat).length ? { prechat: h.prechat } : {}),
          ...h.identity,
        },
      });
      const next = { id: created.conversation_id, token: created.visitor_token };
      applyConversation(next);
      return next;
    },
    [api, applyConversation, conversation, ensureSession, host, params.fingerprint, params.href],
  );

  // ── History + realtime, for as long as a conversation exists ───────────────
  useEffect(() => {
    if (!conversation) {
      setMessages([]);
      return;
    }
    let cancelled = false;

    void api
      .messages(conversation)
      .then(({ messages: history }) => {
        if (cancelled) return;
        setMessages(history);
        // Survives a reload: if a human already spoke, the starter chips stay gone.
        if (history.some((m) => m.sender_type === 'agent')) setEscalated(true);
        const card = [...history].reverse().find((m) => m.metadata?.context_card)?.metadata.context_card;
        if (card) setContextCard(card);
      })
      .catch((err: unknown) => {
        // A stored token the server no longer accepts (conversation purged by
        // retention, or the site was reset) must not wedge the widget shut.
        if (err instanceof ApiError && err.status === 401) applyConversation(null);
      });

    const socket = openConversationSocket(params.apiBase, conversation.id, conversation.token, {
      onMessage: (message) => {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        if (message.metadata?.context_card) setContextCard(message.metadata.context_card);
        if (message.sender_type !== 'visitor') callbacks.current.onIncoming(message);
        if (message.sender_type === 'agent') setEscalated(true);
      },
      onTyping: setAgentTyping,
      onAgentStatus: (online) => callbacks.current.onAgentStatus(online),
      onAgentJoined: () => setEscalated(true),
      onResolved: () => callbacks.current.onResolved(),
    });
    socketRef.current = socket;

    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
    };
  }, [api, applyConversation, conversation, params.apiBase]);

  const send = useCallback(
    async (content: string) => {
      setSending(true);
      setError(null);
      try {
        const conv = await ensureConversation();
        const { message } = await api.send(conv, content);
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      } catch {
        setError('send');
      } finally {
        setSending(false);
      }
    },
    [api, ensureConversation],
  );

  const setTyping = useCallback(() => {
    if (!conversation) return;
    void api.typing(conversation, true).catch(() => undefined);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      void api.typing(conversation, false).catch(() => undefined);
    }, 2000);
  }, [api, conversation]);

  const rate = useCallback(
    async (body: { stars: number; tags: string[]; comment: string }) => {
      const conv = await ensureConversation();
      await api.rate(conv, body);
    },
    [api, ensureConversation],
  );

  const adopt = useCallback(
    async (conversationId: string, claimToken: string) => {
      const sessionToken = await ensureSession();
      const { visitor_token } = await api.claim(conversationId, claimToken, sessionToken);
      applyConversation({ id: conversationId, token: visitor_token });
    },
    [api, applyConversation, ensureSession],
  );

  const pushContext = useCallback(
    (token: string) => {
      if (!conversation) return;
      void api
        .attributes(conversation, token)
        .then((r) => r.context_card && setContextCard(r.context_card))
        .catch(() => undefined);
    },
    [api, conversation],
  );

  const reset = useCallback(() => {
    applyConversation(null);
    setMessages([]);
    setEscalated(false);
    setAgentTyping(false);
    setContextCard(null);
    setError(null);
  }, [applyConversation]);

  return {
    conversation,
    messages,
    agentTyping,
    escalated,
    sending,
    error,
    contextCard,
    ensureSession,
    ensureConversation,
    send,
    setTyping,
    rate,
    adopt,
    pushContext,
    reset,
    clearError: useCallback(() => setError(null), []),
  };
}
