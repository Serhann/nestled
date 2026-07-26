import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Inbox, Radio } from 'lucide-react';
import { listConversations, conversationOrigin, type AdminConversation, type LiveVisitor } from '../../lib/adminApi';
import { VisitorAvatar } from './VisitorAvatar';


interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
  reloadNonce: number;
  unread: Record<string, number>;
  presence: LiveVisitor[];
}

type FilterId = 'inbox' | 'unanswered' | 'active' | 'handoff' | 'resolved' | 'all';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A conversation is "awaiting a reply" when the customer is the last to speak
 *  (or the bot handed off) and it hasn't been resolved. */
function isUnanswered(c: AdminConversation): boolean {
  return c.status !== 'resolved' && (c.last_sender === 'visitor' || c.needs_human);
}

export function ConversationsList({ selectedId, onSelect, reloadNonce, unread, presence }: Props) {
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [filter, setFilter] = useState<FilterId>('inbox');
  const [loading, setLoading] = useState(true);

  // Fetch the whole list; every filter is applied client-side so we can combine
  // live-presence and reply-state (the API only knows status).
  useEffect(() => {
    let cancelled = false;
    listConversations()
      .then((c) => !cancelled && setConversations(c))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  // Conversations whose visitor is online right now (green dot).
  const onlineConvIds = useMemo(
    () => new Set(presence.filter((v) => v.online && v.conversationId).map((v) => v.conversationId as string)),
    [presence],
  );
  const isOnline = (c: AdminConversation) => onlineConvIds.has(c.id);

  const counts = useMemo(() => {
    let unanswered = 0;
    let handoff = 0;
    let active = 0;
    for (const c of conversations) {
      if (isUnanswered(c)) unanswered++;
      if (c.needs_human) handoff++;
      if (isOnline(c)) active++;
    }
    return { unanswered, handoff, active };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, onlineConvIds]);

  const FILTERS: { id: FilterId; label: string }[] = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'unanswered', label: 'Unanswered' },
    { id: 'active', label: 'Active' },
    { id: 'handoff', label: 'Handoffs' },
    { id: 'resolved', label: 'Resolved' },
    { id: 'all', label: 'All' },
  ];

  const visible = useMemo(() => {
    const list = conversations.filter((c) => {
      switch (filter) {
        case 'inbox':
          // The focused view: someone is here now, or waiting for us.
          return isOnline(c) || isUnanswered(c);
        case 'unanswered':
          return isUnanswered(c);
        case 'active':
          return isOnline(c);
        case 'handoff':
          return c.needs_human;
        case 'resolved':
          return c.status === 'resolved';
        default:
          return true;
      }
    });
    // Waiting-for-us first, then online, then most recent.
    return list.sort((a, b) => {
      const au = isUnanswered(a) ? 1 : 0;
      const bu = isUnanswered(b) ? 1 : 0;
      if (au !== bu) return bu - au;
      const ao = isOnline(a) ? 1 : 0;
      const bo = isOnline(b) ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return b.updated_at.localeCompare(a.updated_at);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, filter, onlineConvIds]);

  const emptyText: Record<FilterId, string> = {
    inbox: "You're all caught up — no one waiting or online.",
    unanswered: 'No unanswered conversations. Nice work!',
    active: 'No visitors are in a chat right now.',
    handoff: 'No handoffs waiting.',
    resolved: 'No resolved conversations yet.',
    all: 'No conversations yet',
  };

  const badgeFor = (id: FilterId): number =>
    id === 'unanswered' ? counts.unanswered : id === 'handoff' ? counts.handoff : id === 'active' ? counts.active : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1.5 p-2.5 border-b border-gray-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          const badge = badgeFor(f.id);
          const accent = f.id === 'handoff';
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold transition shrink-0 inline-flex items-center gap-1.5 ${
                active
                  ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/25'
                  : badge > 0
                    ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {f.id === 'inbox' && <Inbox className="w-3.5 h-3.5" />}
              {f.id === 'active' && <Radio className="w-3.5 h-3.5" />}
              {accent && <Sparkles className="w-3.5 h-3.5" />}
              {f.label}
              {badge > 0 && (
                <span className={`min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center ${active ? 'bg-white/25' : 'bg-blue-600 text-white'}`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>}
        {!loading && visible.length === 0 && (
          <div className="p-10 text-center text-gray-400 text-sm">
            <div className="mx-auto mb-2 w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center text-xl">💬</div>
            {emptyText[filter]}
          </div>
        )}
        {visible.map((c) => {
          const name = c.visitor_name || c.visitor_email || 'Anonymous visitor';
          const u = unread[c.id] ?? 0;
          const online = isOnline(c);
          const unanswered = isUnanswered(c);
          const src = conversationOrigin(c.metadata);
          const preview =
            c.last_message != null
              ? `${c.last_sender === 'visitor' ? '' : c.last_sender === 'ai' ? '🤖 ' : '↩ '}${c.last_message}`
              : 'No messages yet';
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full text-left px-3 py-2.5 rounded-2xl flex gap-3 items-start transition ${
                selectedId === c.id ? 'bg-blue-50 ring-1 ring-blue-100' : 'hover:bg-gray-100'
              }`}
            >
              <div className="relative shrink-0 mt-0.5">
                <VisitorAvatar email={c.visitor_email} name={name} size={40} className="shadow-sm" />
                {online && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-white rounded-full" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-800 truncate">{name}</span>
                  {c.needs_human ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full shrink-0">
                      <Sparkles className="w-2.5 h-2.5" /> waiting {timeAgo(c.updated_at)}
                    </span>
                  ) : (
                    unanswered && (
                      <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full shrink-0">unanswered</span>
                    )
                  )}
                  <span className="ml-auto text-xs text-gray-400 shrink-0">{timeAgo(c.updated_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold bg-gray-100 text-gray-600">
                    {src}
                  </span>
                  <p className={`text-sm truncate flex-1 ${unanswered ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>{preview}</p>
                  {u > 0 && (
                    <span className="bg-red-500 text-white text-[10px] rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center shrink-0">
                      {u}
                    </span>
                  )}
                </div>
                {c.status === 'resolved' && <span className="text-[10px] text-gray-400">resolved</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
