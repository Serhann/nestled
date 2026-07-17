import { useEffect, useState } from 'react';
import { listConversations, type AdminConversation, type LiveVisitor } from '../../lib/adminApi';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
  reloadNonce: number;
  unread: Record<string, number>;
  presence: LiveVisitor[];
}

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'pending', label: 'Pending' },
  { id: 'resolved', label: 'Resolved' },
] as const;

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ConversationsList({ selectedId, onSelect, reloadNonce, unread, presence }: Props) {
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listConversations(filter || undefined)
      .then((c) => !cancelled && setConversations(c))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filter, reloadNonce]);

  // Conversations whose visitor is online right now (green dot).
  const onlineConvIds = new Set(
    presence.filter((v) => v.online && v.conversationId).map((v) => v.conversationId as string),
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 p-2 border-b border-gray-100">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 rounded-full text-sm ${
              filter === f.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>}
        {!loading && conversations.length === 0 && (
          <div className="p-6 text-center text-gray-400 text-sm">No conversations yet</div>
        )}
        {conversations.map((c) => {
          const name = c.visitor_name || c.visitor_email || 'Anonymous visitor';
          const u = unread[c.id] ?? 0;
          const preview =
            c.last_message != null
              ? `${c.last_sender === 'visitor' ? '' : c.last_sender === 'ai' ? '🤖 ' : '↩ '}${c.last_message}`
              : 'No messages yet';
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full text-left px-4 py-3 border-b border-gray-50 flex gap-3 items-start ${
                selectedId === c.id ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
            >
              <div className="relative shrink-0 mt-0.5">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center text-sm font-semibold">
                  {name.charAt(0).toUpperCase()}
                </div>
                {onlineConvIds.has(c.id) && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-white rounded-full" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-800 truncate">{name}</span>
                  {c.needs_human && (
                    <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 rounded">needs human</span>
                  )}
                  <span className="ml-auto text-xs text-gray-400 shrink-0">{timeAgo(c.updated_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-gray-500 truncate flex-1">{preview}</p>
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
