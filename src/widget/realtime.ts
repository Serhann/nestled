import type { ChatMessage } from '../types/chat';

/**
 * The conversation socket.
 *
 * `/ws/visitor/:id?token=` authenticates with the conversation's own visitor
 * token — a secret this browser already holds, which is why it is acceptable on
 * a query string (browsers cannot set headers on a WS handshake). The PRESENCE
 * socket is a different animal and is deliberately not opened from here: it
 * belongs to the host page, where presence.js can see real navigation, and it
 * authenticates with the signed widget session instead.
 */

export interface RealtimeHandlers {
  onMessage(message: ChatMessage): void;
  onTyping(isTyping: boolean): void;
  onAgentStatus(online: boolean): void;
  onAgentJoined(): void;
  onResolved(): void;
}

interface Frame {
  type?: string;
  message?: ChatMessage;
  isTyping?: boolean;
  online?: boolean;
  from?: string;
}

export interface RealtimeConnection {
  close(): void;
}

const MAX_BACKOFF_MS = 30_000;

export function openConversationSocket(
  apiBase: string,
  conversationId: string,
  visitorToken: string,
  handlers: RealtimeHandlers,
): RealtimeConnection {
  const url =
    `${apiBase.replace(/^http/, 'ws')}/ws/visitor/${encodeURIComponent(conversationId)}` +
    `?token=${encodeURIComponent(visitorToken)}`;

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let closed = false;

  function connect(): void {
    if (closed) return;
    socket = new WebSocket(url);

    socket.onopen = () => {
      backoff = 1000;
    };

    socket.onmessage = (event) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(event.data)) as Frame;
      } catch {
        return;
      }
      if (frame.type === 'message:new' && frame.message) handlers.onMessage(frame.message);
      // The visitor's own typing is echoed back by the fanout; ignoring anything
      // that is not from an agent stops the indicator flickering as they type.
      else if (frame.type === 'typing' && frame.from === 'agent') handlers.onTyping(Boolean(frame.isTyping));
      else if (frame.type === 'agent:status') handlers.onAgentStatus(Boolean(frame.online));
      else if (frame.type === 'agent:joined') handlers.onAgentJoined();
      else if (frame.type === 'conversation:resolved') handlers.onResolved();
    };

    socket.onclose = () => {
      if (closed) return;
      // A dropped socket means silently missing replies, so reconnect with capped
      // backoff rather than leaving the visitor staring at a dead thread.
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    socket.onerror = () => socket?.close();
  }

  connect();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
