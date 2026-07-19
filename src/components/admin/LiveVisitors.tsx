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
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="px-5 py-4 border-b border-gray-100 sticky top-0 bg-white/90 backdrop-blur z-10">
        <h2 className="font-bold text-gray-800 text-lg">Live visitors</h2>
        <p className="text-sm text-gray-500 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500 ring-2 ring-green-500/20" />
          {online.length} online right now
        </p>
      </div>

      {online.length === 0 && (
        <div className="p-12 text-center text-gray-400 text-sm">
          <div className="mx-auto mb-3 w-14 h-14 rounded-3xl bg-gray-100 flex items-center justify-center text-2xl">👀</div>
          No visitors on the site right now
        </div>
      )}

      <div className="p-3 space-y-2">
        {online.map((v) => (
          <div key={v.visitorId} className="bg-white rounded-2xl border border-gray-100/80 shadow-sm overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0 ring-4 ring-green-500/10">
                {v.device === 'mobile' ? <Smartphone className="w-4 h-4" /> : <Monitor className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="text-gray-700 truncate">
                    {v.geo
                      ? [v.geo.city, v.geo.region, v.geo.country].filter(Boolean).join(', ') || 'Unknown location'
                      : 'Unknown location'}
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500">{v.returning ? 'returning' : 'new'}</span>
                  <span className="ml-auto text-xs text-gray-400 shrink-0">{duration(v.timeOnSite)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                  {v.ip && (
                    <span className="font-mono bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 shrink-0">{v.ip}</span>
                  )}
                  <span className="truncate">
                    {v.url || 'unknown page'}
                    {v.conversationId ? ' · in chat' : ''}
                  </span>
                </div>
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
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={() => setTarget(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-xl animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-gray-800 text-lg">Start a chat 👋</h3>
              <button onClick={() => setTarget(null)} className="text-gray-400 hover:text-gray-600 p-1 -m-1"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-500 mb-3">
              Send an opening message. The chat opens on the visitor's screen if they're still browsing.
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-sm focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400 outline-none transition mb-3"
            />
            <button
              onClick={send}
              disabled={busy || !message.trim()}
              className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold shadow-md shadow-blue-600/25 hover:bg-blue-700 active:scale-[0.98] transition disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send & open chat'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
