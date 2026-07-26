import { Link } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { Badge, statusTone } from '../../../ui/Badge';
import { useAppStore } from '../../store';
import type { ConversationRow } from '../../../lib/api/types';

/**
 * The conversation list.
 *
 * Virtualized, because a busy workspace's inbox is thousands of rows and the old
 * panel rendered every one of them — which was fine in a demo and janky on a real
 * account. Only the visible window is in the DOM.
 */
export function ConversationList({
  rows,
  basePath,
  activeId,
  onLoadMore,
  hasMore,
}: {
  rows: ConversationRow[];
  basePath: string;
  activeId: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const typing = useAppStore((s) => s.typing);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 300) onLoadMore();
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const isTyping = typing.some((t) => t.conversationId === row.id && t.expiresAt > Date.now());
          return (
            <div
              key={row.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <Link
                to={`${basePath}/${row.id}`}
                className={`block h-full px-4 py-3 border-b border-gray-100 transition ${
                  row.id === activeId ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-semibold text-gray-800 truncate flex-1">
                    {row.visitor_name || row.visitor_email || 'Visitor'}
                  </span>
                  <span className="text-[11px] text-gray-400 shrink-0">{relative(row.updated_at)}</span>
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {isTyping ? (
                    <span className="text-blue-600 font-medium">typing…</span>
                  ) : (
                    <>
                      {row.last_sender === 'agent' && <span className="text-gray-400">You: </span>}
                      {row.last_message ?? 'No messages yet'}
                    </>
                  )}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.needs_human && <Badge tone="red">needs a human</Badge>}
                  {!row.assigned_member_id && <Badge tone="amber">unassigned</Badge>}
                  {row.tags.slice(0, 2).map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact relative time. Long enough ago and an absolute date is more useful. */
export function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
