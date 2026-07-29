import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { RealtimeConnection, type RealtimeEvent } from '../../lib/realtime';
import { qk } from '../../lib/queryKeys';
import { useAppStore } from '../store';
import { playChime, playSent } from '../../lib/sound';
import { useWorkspace } from './WorkspaceProvider';
import type { ConversationDetail, ConversationRow, Message, PresenceVisitor } from '../../lib/api/types';

/**
 * Socket events are folded into the query cache directly.
 *
 * The tempting alternative — invalidate on every event — turns one incoming
 * message into a refetch of the whole inbox, for every agent, every time. On a
 * busy workspace that is a self-inflicted load test. So each event patches
 * exactly the rows it affects, and `resync` is the single case that refetches.
 */

interface RealtimeValue {
  connected: boolean;
  /** Tell the server which conversation this agent is looking at. */
  view: (conversationId: string | null) => void;
  watch: (websiteId: string, visitorId: string) => void;
  unwatch: () => void;
  /** Relay the agent's guiding pointer onto the visitor's own page. */
  assist: (websiteId: string, visitorId: string, payload: Record<string, unknown>) => void;
  /** Replay frames bypass the cache entirely — see the note below. */
  onReplay: (fn: ((events: unknown[]) => void) | null) => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { workspace } = useWorkspace();
  const workspaceId = workspace.id;
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  /**
   * rrweb frames never enter the query cache. They arrive dozens per second and
   * are only meaningful to whichever replay view is mounted, so they go straight
   * to a callback that view registers — putting them in a cache would mean
   * retaining megabytes of DOM mutations nobody will read again.
   */
  const replaySink = useRef<((events: unknown[]) => void) | null>(null);
  /**
   * In a ref, not a dependency.
   *
   * The socket effect below reconnects whenever its dependencies change, and a
   * reconnect drops presence and replays the event gap. Nothing about "who am I"
   * should be able to cause that.
   */
  const memberIdRef = useRef(workspace.member_id);
  memberIdRef.current = workspace.member_id;

  useEffect(() => {
    const connection = new RealtimeConnection(workspaceId, {
      onStatusChange: setConnected,
      onResync: () => {
        // The gap was too large to replay. Everything for this workspace is
        // suspect, so everything for this workspace is refetched — and nothing
        // else, because another workspace's cache was never affected.
        void queryClient.invalidateQueries({ queryKey: qk.workspace(workspaceId) });
      },
      onEvent: (event) => {
        if (event.type === 'rrweb:events' && Array.isArray(event.events)) {
          replaySink.current?.(event.events as unknown[]);
          return;
        }
        applyEvent(queryClient, workspaceId, event);
        announce(event, memberIdRef.current);
      },
    });
    connectionRef.current = connection;
    connection.connect();
    return () => {
      connection.close();
      connectionRef.current = null;
    };
  }, [workspaceId, queryClient]);

  const value = useMemo<RealtimeValue>(
    () => ({
      connected,
      view: (conversationId) => connectionRef.current?.view(conversationId),
      watch: (websiteId, visitorId) => connectionRef.current?.watch(websiteId, visitorId),
      unwatch: () => connectionRef.current?.unwatch(),
      assist: (websiteId, visitorId, payload) =>
        connectionRef.current?.assist(websiteId, visitorId, payload),
      onReplay: (fn) => {
        replaySink.current = fn;
      },
    }),
    [connected],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * The audible half of an event.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * There was no audible half at all: `playChime` existed, was well written, was
 * tested by hand once, and was imported by nobody — so an agent with the tab in the
 * background found out about a waiting customer whenever they next looked. The
 * store even persisted a `soundEnabled` preference for a sound that could not play.
 *
 * Three rules, and the second and third are what stop this becoming noise people
 * mute permanently:
 *
 *   1. **Someone else wrote → chime.** A customer message, or a brand new
 *      conversation, which is the most important sound in the product.
 *   2. **You sent → a different, quieter sound.** Confirmation, not an alert. On
 *      email and SMS "it left" is genuinely slower and less certain than it looks.
 *   3. **A COLLEAGUE sent → silence.** In a shared inbox every agent is subscribed
 *      to every conversation; chiming on their replies turns a busy afternoon into
 *      a chorus, and the fix people reach for is switching sound off entirely.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function announce(event: RealtimeEvent, myMemberId: string): void {
  // Not gated on tab visibility: a backgrounded tab is exactly when a sound is the
  // only signal there is.
  if (!useAppStore.getState().soundEnabled) return;

  if (event.type === 'conversation:new') {
    playChime();
    return;
  }
  if (event.type !== 'message:new') return;

  const message = event.message as Message | undefined;
  if (!message) return;
  if (message.sender_type !== 'agent') {
    playChime();
    return;
  }
  if (message.sender_member_id === myMemberId) playSent();
}

/** Patch every cached list of conversations, whatever filters produced it. */
function patchConversationLists(
  queryClient: QueryClient,
  workspaceId: string,
  update: (rows: ConversationRow[]) => ConversationRow[],
): void {
  const caches = queryClient.getQueriesData<{ conversations: ConversationRow[]; next_cursor: string | null }>({
    queryKey: ['w', workspaceId, 'conversations'],
  });
  for (const [key, data] of caches) {
    if (!data) continue;
    queryClient.setQueryData(key, { ...data, conversations: update(data.conversations) });
  }
}

export function applyEvent(
  queryClient: QueryClient,
  workspaceId: string,
  event: RealtimeEvent,
): void {
  switch (event.type) {
    case 'message:new': {
      const conversationId = event.conversationId as string;
      const message = event.message as Message;

      queryClient.setQueryData<{ conversation: ConversationDetail }>(
        qk.conversation(workspaceId, conversationId),
        (prev) => {
          if (!prev) return prev;
          // The sender's own optimistic copy is already there; matching on id keeps
          // the echo from doubling it.
          if (prev.conversation.messages.some((m) => m.id === message.id)) return prev;
          return {
            conversation: {
              ...prev.conversation,
              messages: [...prev.conversation.messages, message],
              message_count: prev.conversation.message_count + 1,
            },
          };
        },
      );

      patchConversationLists(queryClient, workspaceId, (rows) => {
        const index = rows.findIndex((r) => r.id === conversationId);
        if (index === -1) return rows;
        const row: ConversationRow = {
          ...rows[index]!,
          last_message: message.content,
          last_sender: message.sender_type,
          message_count: rows[index]!.message_count + 1,
          updated_at: message.created_at,
        };
        // The inbox is ordered by activity, so the row moves to the top rather
        // than updating in place and appearing to be old.
        return [row, ...rows.filter((_, i) => i !== index)];
      });
      break;
    }

    /**
     * A reply's delivery outcome, arriving after the message itself.
     *
     * Patches in place rather than appending. On email and SMS the row is written as
     * `pending` and published immediately, then the send is attempted — so the copy
     * already on screen says "sending…" and nothing else would ever correct it.
     */
    case 'message:delivery': {
      const conversationId = event.conversationId as string;
      const messageId = event.messageId as string;
      const status = event.status as 'sent' | 'failed';
      const error = (event.error ?? null) as string | null;

      queryClient.setQueryData<{ conversation: ConversationDetail }>(
        qk.conversation(workspaceId, conversationId),
        (prev) => {
          if (!prev) return prev;
          const index = prev.conversation.messages.findIndex((m) => m.id === messageId);
          if (index === -1) return prev;
          const messages = [...prev.conversation.messages];
          messages[index] = { ...messages[index]!, delivery_status: status, delivery_error: error };
          return { conversation: { ...prev.conversation, messages } };
        },
      );
      break;
    }

    /**
     * A deadline was missed while the agent was looking at something else.
     *
     * Invalidate rather than patch: the sweep also reassigned it and marked it unread,
     * so several fields moved at once and re-reading is both simpler and correct. The
     * attention counts go too, because the badge is the thing that makes this visible.
     */
    case 'conversation:breached': {
      const conversationId = event.conversationId as string;
      void queryClient.invalidateQueries({ queryKey: qk.conversation(workspaceId, conversationId) });
      // Every filtered list, by prefix — an at-risk view and an "everything" view can
      // both be cached, and only one of them is the one on screen.
      void queryClient.invalidateQueries({ queryKey: ['w', workspaceId, 'conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['attention', workspaceId] });
      break;
    }

    case 'conversation:new': {
      const conversation = event.conversation as ConversationRow;
      patchConversationLists(queryClient, workspaceId, (rows) =>
        rows.some((r) => r.id === conversation.id) ? rows : [conversation, ...rows],
      );
      break;
    }

    case 'conversation:updated':
    case 'conversation:resolved': {
      const patch =
        event.type === 'conversation:resolved'
          ? { id: event.conversationId as string, status: 'resolved' as const }
          : (event.conversation as Partial<ConversationRow> & { id: string });

      patchConversationLists(queryClient, workspaceId, (rows) =>
        rows.map((r) => (r.id === patch.id ? { ...r, ...patch } : r)),
      );
      queryClient.setQueryData<{ conversation: ConversationDetail }>(
        qk.conversation(workspaceId, patch.id),
        (prev) => (prev ? { conversation: { ...prev.conversation, ...patch } } : prev),
      );
      break;
    }

    case 'typing': {
      if (event.from !== 'visitor') break;
      useAppStore.getState().markTyping(event.conversationId as string, Boolean(event.isTyping));
      break;
    }

    case 'presence:list': {
      queryClient.setQueryData(qk.presence(workspaceId), {
        visitors: event.visitors as PresenceVisitor[],
      });
      break;
    }

    case 'website:install_progress': {
      // The onboarding install detector listens for exactly this. Patching the
      // cached status is what turns "waiting…" into "we can see your site" without
      // the customer refreshing the page they are anxiously watching.
      const websiteId = event.websiteId as string;
      queryClient.setQueryData(qk.installStatus(workspaceId, websiteId), (prev: unknown) =>
        prev && typeof prev === 'object'
          ? { ...(prev as object), phase: event.phase, wrong_domain_host: event.host ?? null }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: qk.installStatus(workspaceId, websiteId) });
      break;
    }

    default:
      break;
  }
}
