import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { RealtimeConnection, type RealtimeEvent } from '../../lib/realtime';
import { qk } from '../../lib/queryKeys';
import { useAppStore } from '../store';
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
