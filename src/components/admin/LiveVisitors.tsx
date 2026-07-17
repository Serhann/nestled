import { useState } from 'react';
import { Globe, Monitor, Smartphone, MessageSquarePlus, Eye, History, X } from 'lucide-react';
import { startChat, type LiveVisitor } from '../../lib/adminApi';

interface Props {
  visitors: LiveVisitor[];
  onStarted: (conversationId: string) => void;
  magicBrowse: boolean;
  onWatch: (visitorId: string) => void;
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function LiveVisitors({ visitors, onStarted, magicBrowse, onWatch }: Props) {
  const [target, setTarget] = useState<LiveVisitor | null>(null);
  const [message, setMessage] = useState('Hi! 👋 Can I help you with anything?');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const online = visitors.filter((v) => v.online);

  const send = async () => {
    if (!target || !message.trim()) return;
    setBusy(true);
    try {
      const res = await startChat(target.visitorId, message.trim());
      setTarget(null);
      onStarted(res.conversation_id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-100 sticky top-0 bg-white">
        <h2 className="font-semibold text-gray-800">Live visitors</h2>
        <p className="text-sm text-gray-500">{online.length} online right now</p>
      </div>

      {online.length === 0 && <div className="p-6 text-center text-gray-400 text-sm">No visitors on the site right now</div>}

      <div className="divide-y divide-gray-50">
        {online.map((v) => (
          <div key={v.visitorId}>
            <div className="px-4 py-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0">
                {v.device === 'mobile' ? <Smartphone className="w-4 h-4" /> : <Monitor className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="text-gray-700 truncate">
                    {v.geo ? [v.geo.city, v.geo.country].filter(Boolean).join(', ') || 'Unknown' : 'Unknown'}
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500">{v.returning ? 'returning' : 'new'}</span>
                  <span className="ml-auto text-xs text-gray-400 shrink-0">{duration(v.timeOnSite)}</span>
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {v.url || 'unknown page'}
                  {v.conversationId ? ' · in chat' : ''}
                </p>
              </div>
              {/* Page-history toggle */}
              <button
                onClick={() => setExpanded(expanded === v.visitorId ? null : v.visitorId)}
                className={`shrink-0 flex items-center gap-1 p-2 rounded-lg ${expanded === v.visitorId ? 'bg-gray-100 text-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
                aria-label="Page history"
                title="Page history"
              >
                <History className="w-4 h-4" />
                <span className="text-xs">{v.pagesViewed}</span>
              </button>
              {magicBrowse && (
                <button
                  onClick={() => onWatch(v.visitorId)}
                  className="shrink-0 p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                  aria-label="Watch live"
                  title="Watch live"
                >
                  <Eye className="w-5 h-5" />
                </button>
              )}
              {!v.conversationId && (
                <button
                  onClick={() => setTarget(v)}
                  className="shrink-0 p-2 text-blue-600 hover:bg-blue-50 rounded-lg"
                  aria-label="Start chat"
                >
                  <MessageSquarePlus className="w-5 h-5" />
                </button>
              )}
            </div>
            {/* Page-visit history (most recent last) */}
            {expanded === v.visitorId && (
              <ol className="px-4 pb-3 pl-16 space-y-1">
                {(v.pages ?? []).length === 0 && <li className="text-xs text-gray-400">No page history yet</li>}
                {(v.pages ?? [])
                  .slice()
                  .reverse()
                  .map((p, i) => (
                    <li key={`${p.at}-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400 shrink-0 tabular-nums">{clockTime(p.at)}</span>
                      <span className={`truncate ${i === 0 ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>{p.url}</span>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        ))}
      </div>

      {/* Proactive start-chat sheet */}
      {target && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4" onClick={() => setTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">Start a chat</h3>
              <button onClick={() => setTarget(null)} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-500 mb-3">
              Send an opening message. The chat opens on the visitor's screen if they're still browsing.
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 mb-3"
            />
            <button
              onClick={send}
              disabled={busy || !message.trim()}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send & open chat'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
