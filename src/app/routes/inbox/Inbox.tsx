import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Inbox as InboxIcon, Languages, Search } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { useRealtime } from '../../providers/RealtimeProvider';
import {
  getConversation,
  listConversations,
  sendReply,
  setStatus,
  type InboxFilters,
} from '../../../lib/api/inbox';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { useAppStore } from '../../store';
import { Button } from '../../../ui/Button';
import { Badge, statusTone } from '../../../ui/Badge';
import { Select } from '../../../ui/Form';
import { EmptyState, ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { visitorLanguage } from '../../../lib/language';
import { ConversationList } from './ConversationList';
import { Thread } from './Thread';
import { Composer } from './Composer';
import { ConversationDetails } from './ConversationDetails';
import { useTranslate } from './useTranslate';
import type { ConversationStatus, Message } from '../../../lib/api/types';

/** Stable identity, so the translation hook's effect does not see a new array each render. */
const EMPTY_MESSAGES: Message[] = [];

/**
 * The inbox.
 *
 * Filters live in the URL's search params, which buys three things at once: a
 * filtered view is a shareable link, the browser's back button behaves, and the
 * filter object is a natural cache key. The selected conversation is a path
 * segment for the same reasons.
 */
export default function Inbox() {
  const { workspace, can } = useWorkspace();
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const realtime = useRealtime();
  const [cursor, setCursor] = useState<string | null>(null);
  const searchTimer = useRef(0);

  const filters: InboxFilters = {
    status: (params.get('status') as ConversationStatus | 'all') ?? 'open',
    website_id: params.get('website') ?? undefined,
    assignee: params.get('assignee') ?? undefined,
    q: params.get('q') ?? undefined,
  };

  const list = useQuery({
    queryKey: qk.conversations(workspace.id, filters),
    queryFn: () => listConversations(workspace.id, filters),
    enabled: can('conversation:read'),
  });

  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  // Tell the server which conversation is on screen, so Web Push skips notifying
  // someone who is already looking at the message.
  useEffect(() => {
    realtime.view(conversationId ?? null);
    return () => realtime.view(null);
  }, [conversationId, realtime]);

  if (!can('conversation:read')) return <NoAccess what="the inbox" />;

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setCursor(null);
  };

  const base = `/w/${workspace.slug}/inbox`;

  return (
    <div className="flex-1 flex min-h-0">
      <div
        className={`w-full md:w-80 shrink-0 flex flex-col border-r border-gray-200/70 bg-cream ${
          conversationId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-3 space-y-2 border-b border-gray-200/70">
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden />
            <input
              defaultValue={filters.q ?? ''}
              placeholder="Search conversations"
              aria-label="Search conversations"
              onChange={(e) => {
                // Debounced into the URL, so the shareable link and the request
                // stay in step and the back button steps through real states.
                const value = e.target.value;
                window.clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => setFilter('q', value || null), 300);
              }}
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </label>
          <div className="flex gap-1.5">
            <Select
              value={filters.status ?? 'open'}
              onChange={(e) => setFilter('status', e.target.value)}
              className="!py-1.5 !text-xs"
              aria-label="Status"
            >
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </Select>
            <Select
              value={filters.assignee ?? ''}
              onChange={(e) => setFilter('assignee', e.target.value || null)}
              className="!py-1.5 !text-xs"
              aria-label="Assignee"
            >
              <option value="">Anyone</option>
              <option value="me">Mine</option>
              <option value="unassigned">Unassigned</option>
            </Select>
            {(websites.data?.websites.length ?? 0) > 1 && (
              <Select
                value={filters.website_id ?? ''}
                onChange={(e) => setFilter('website', e.target.value || null)}
                className="!py-1.5 !text-xs"
                aria-label="Website"
              >
                <option value="">All sites</option>
                {websites.data!.websites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>

        {list.isLoading && <Spinner />}
        {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.data &&
          (list.data.conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={InboxIcon}
                title="Nothing here"
                hint={
                  filters.q || filters.status !== 'open'
                    ? 'No conversations match these filters.'
                    : 'When someone messages you, it lands here.'
                }
              />
            </div>
          ) : (
            <ConversationList
              rows={list.data.conversations}
              basePath={base}
              activeId={conversationId ?? null}
              hasMore={Boolean(list.data.next_cursor) && cursor !== list.data.next_cursor}
              onLoadMore={() => setCursor(list.data!.next_cursor)}
            />
          ))}
      </div>

      {conversationId ? (
        <ConversationPane
          key={conversationId}
          conversationId={conversationId}
          onClose={() => navigate(base)}
        />
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center bg-canvas">
          <p className="text-sm text-gray-400">Pick a conversation to get started.</p>
        </div>
      )}
    </div>
  );
}

function ConversationPane({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const isTyping = useAppStore((s) => s.isTyping(conversationId));
  const clearDraft = useAppStore((s) => s.clearDraft);

  const detail = useQuery({
    queryKey: qk.conversation(workspace.id, conversationId),
    queryFn: () => getConversation(workspace.id, conversationId),
  });

  const reply = useMutation({
    mutationFn: (content: string) => sendReply(workspace.id, conversationId, content),
    onSuccess: async (result) => {
      clearDraft(conversationId);
      // The socket echo will also carry this message; the cache patch matches on
      // id so the agent sees their reply instantly without it appearing twice.
      queryClient.setQueryData(qk.conversation(workspace.id, conversationId), (prev: unknown) => {
        const typed = prev as { conversation: { messages: unknown[] } } | undefined;
        if (!typed) return prev;
        return {
          conversation: {
            ...typed.conversation,
            messages: [...typed.conversation.messages, result.message],
          },
        };
      });
    },
  });

  const resolve = useMutation({
    mutationFn: (status: ConversationStatus) => setStatus(workspace.id, conversationId, status),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.conversation(workspace.id, conversationId) }),
  });

  // Above the early returns, because hooks cannot live below a conditional return.
  // An empty message list while the query is in flight is harmless: the hook does
  // nothing at all until the agent switches translation on.
  const translation = useTranslate(
    workspace.id,
    conversationId,
    detail.data?.conversation.messages ?? EMPTY_MESSAGES,
  );

  if (detail.isLoading) return <div className="flex-1"><Spinner /></div>;
  if (detail.error) return <div className="flex-1 p-6"><ErrorState error={detail.error} /></div>;
  if (!detail.data) return null;

  const conversation = detail.data.conversation;
  // An unverified hint from the visitor's browser, which is all it needs to be: it
  // only picks the default for a control the agent can ignore. Null when the hint is
  // missing, unusable, or already English — the control then does not appear at all.
  const theirLanguage = visitorLanguage(conversation.metadata);

  return (
    <div className="flex-1 flex min-w-0">
      <div className="flex-1 flex flex-col min-w-0 bg-canvas">
        <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-gray-200/70 bg-cream">
          <button onClick={onClose} className="md:hidden text-sm text-gray-500" aria-label="Back">
            ←
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-800 truncate">
              {conversation.visitor_name || conversation.visitor_email || 'Visitor'}
            </p>
            <Badge tone={statusTone(conversation.status)}>{conversation.status}</Badge>
          </div>
          {/*
            Only offered when the visitor's browser says they are not reading
            English — `visitorLanguage` returns null otherwise. Putting a "translate
            to English" button on an English conversation invites a metered call that
            can only return the same words.
          */}
          {can('conversation:reply') && theirLanguage && (
            <Button
              size="sm"
              variant={translation.on ? 'subtle' : 'ghost'}
              onClick={translation.toggle}
              title={`This visitor's browser is set to ${theirLanguage.name}`}
            >
              <Languages className="w-4 h-4" aria-hidden />
              {translation.on ? 'Showing English' : `Translate from ${theirLanguage.name}`}
            </Button>
          )}
          {can('conversation:resolve') && conversation.status !== 'resolved' && (
            <Button
              size="sm"
              variant="ghost"
              busy={resolve.isPending}
              onClick={() => resolve.mutate('resolved')}
            >
              <CheckCircle2 className="w-4 h-4" aria-hidden />
              Resolve
            </Button>
          )}
        </header>

        {translation.problem && (
          <p className="shrink-0 px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-100">
            {translation.problem === 'plan_limit'
              ? 'Your AI allowance for this month is used up, so messages are shown as the visitor wrote them. Translation counts against the same allowance as AI replies.'
              : 'Translation is unavailable right now. Messages are shown as the visitor wrote them.'}
          </p>
        )}

        <Thread
          messages={conversation.messages}
          visitorTyping={isTyping}
          translation={translation}
        />

        <Composer
          workspaceId={workspace.id}
          conversationId={conversationId}
          sending={reply.isPending}
          disabled={!can('conversation:reply')}
          onSend={(content) => reply.mutate(content)}
          translateTo={theirLanguage}
        />
      </div>

      <ConversationDetails conversation={conversation} />
    </div>
  );
}
