import { wsOrigin } from './origins';
import { getSession } from './tokens';

/**
 * The agent socket.
 *
 * Two properties this client must have, learned from the version it replaces:
 *
 * 1. **It reconnects and catches up.** The old one reconnected and simply carried
 *    on, so anything published while the socket was down was lost — the agent came
 *    back to a stale inbox and answered a customer who had already asked twice.
 *    Every event now carries a `seq`; on reconnect we send `{type:'resume', since}`
 *    and the server either replays the gap or tells us to `resync`, at which point
 *    the caller refetches. There is no third outcome where we quietly believe we
 *    are up to date.
 *
 * 2. **It backs off.** A server restart otherwise means every open panel
 *    reconnecting in a tight loop at the same instant.
 */

export interface RealtimeEvent {
  type: string;
  seq?: number;
  [key: string]: unknown;
}

export interface RealtimeHandlers {
  onEvent(event: RealtimeEvent): void;
  /** The gap was too large to replay: refetch everything for this workspace. */
  onResync(): void;
  onStatusChange?(connected: boolean): void;
}

const MAX_BACKOFF_MS = 30_000;

export class RealtimeConnection {
  private socket: WebSocket | null = null;
  private closedByUs = false;
  private attempt = 0;
  private lastSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly handlers: RealtimeHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const session = getSession();
    if (!session) return;

    const url = `${wsOrigin()}/ws/agent?workspace=${encodeURIComponent(this.workspaceId)}&token=${encodeURIComponent(session.access_token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatusChange?.(true);
      // Only ask to resume if we have actually seen events before; a first
      // connection has nothing to catch up on.
      if (this.lastSeq > 0) socket.send(JSON.stringify({ type: 'resume', since: this.lastSeq }));
    };

    socket.onmessage = (raw) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw.data as string) as RealtimeEvent;
      } catch {
        return;
      }
      if (typeof event.seq === 'number') this.lastSeq = Math.max(this.lastSeq, event.seq);

      if (event.type === 'hello') return;
      if (event.type === 'resync') {
        this.handlers.onResync();
        return;
      }
      this.handlers.onEvent(event);
    };

    socket.onclose = () => {
      this.socket = null;
      this.handlers.onStatusChange?.(false);
      if (this.closedByUs) return;
      this.scheduleReconnect();
    };

    // `onerror` is always followed by `onclose`, so reconnection is handled in
    // exactly one place rather than racing between two callbacks.
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    // Exponential with jitter: without the jitter, every panel in the company
    // reconnects on the same tick after a deploy and the first thing the new
    // process sees is a thundering herd.
    const base = Math.min(1000 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** Tell the server which conversation this agent is looking at (push skips it). */
  view(conversationId: string | null): void {
    this.send(conversationId ? { type: 'view', conversationId } : { type: 'unview' });
  }

  watch(websiteId: string, visitorId: string): void {
    this.send({ type: 'watch', websiteId, visitorId });
  }

  unwatch(): void {
    this.send({ type: 'unwatch' });
  }

  assist(websiteId: string, visitorId: string, assist: Record<string, unknown>): void {
    this.send({ type: 'assist', websiteId, visitorId, assist });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }
}
