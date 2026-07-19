import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Paperclip,
  CheckCircle,
  RotateCcw,
  MapPin,
  FileText,
  StickyNote,
  UserPlus,
  PanelRightClose,
  PanelRightOpen,
  Globe,
  Monitor,
  Smartphone,
  Clock,
  Link2,
  History,
  X,
} from 'lucide-react';
import {
  getConversation,
  reply as apiReply,
  setStatus,
  uploadAttachment,
  sendTyping,
  attachmentUrl,
  getNotes,
  addNote,
  listCanned,
  listAgents,
  assignConversation,
  type AdminConversation,
  type AdminMessage,
  type ConversationNote,
  type CannedResponse,
  type AgentRow,
  type LiveVisitor,
} from '../../lib/adminApi';

interface Props {
  conversationId: string;
  meId: string;
  liveMessage: { conversationId: string; message: AdminMessage } | null;
  typing: { conversationId: string; isTyping: boolean } | null;
  presence: LiveVisitor[];
  onChanged: () => void;
}

type TimelineItem =
  | { kind: 'msg'; at: string; data: AdminMessage }
  | { kind: 'note'; at: string; data: ConversationNote };

type Tab = 'info' | 'activity' | 'notes';

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function ChatPanel({ conversationId, meId, liveMessage, typing, presence, onChanged }: Props) {
  const [conversation, setConversation] = useState<AdminConversation | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [canned, setCanned] = useState<CannedResponse[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [sending, setSending] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showInfo, setShowInfo] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024);
  const [tab, setTab] = useState<Tab>('info');
  const [noteDraft, setNoteDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getConversation(conversationId), getNotes(conversationId)])
      .then(([c, n]) => {
        if (cancelled) return;
        setConversation(c.conversation);
        setMessages(c.messages);
        setNotes(n);
      })
      .catch(() => undefined);
    listCanned().then(setCanned).catch(() => undefined);
    listAgents().then(setAgents).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (liveMessage && liveMessage.conversationId === conversationId) {
      setMessages((prev) =>
        prev.some((m) => m.id === liveMessage.message.id) ? prev : [...prev, liveMessage.message],
      );
    }
  }, [liveMessage, conversationId]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...messages.map((m) => ({ kind: 'msg' as const, at: m.created_at, data: m })),
      ...notes.map((n) => ({ kind: 'note' as const, at: n.created_at, data: n })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, notes]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timeline, typing]);

  const visitorTyping = typing?.conversationId === conversationId && typing.isTyping;

  const cannedMatches = useMemo(() => {
    if (mode !== 'reply') return [];
    const m = /^\/([a-z0-9-]*)$/.exec(input.trim());
    if (!m) return [];
    const q = m[1];
    return canned.filter((c) => c.shortcut.startsWith(q)).slice(0, 5);
  }, [input, canned, mode]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    setSending(true);
    try {
      if (mode === 'note') {
        const note = await addNote(conversationId, content);
        setNotes((prev) => [...prev, note]);
      } else {
        const m = await apiReply(conversationId, content);
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        onChanged();
      }
    } finally {
      setSending(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSending(true);
    try {
      const m = await uploadAttachment(conversationId, file);
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      onChanged();
    } finally {
      setSending(false);
    }
  };

  const handleInput = (v: string) => {
    setInput(v);
    if (mode !== 'reply') return;
    sendTyping(conversationId, true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => sendTyping(conversationId, false), 2000);
  };

  const toggleResolved = async () => {
    if (!conversation) return;
    const next = conversation.status === 'resolved' ? 'open' : 'resolved';
    await setStatus(conversationId, next);
    setConversation({ ...conversation, status: next });
    onChanged();
  };

  const doAssign = async (agentId?: string | null) => {
    await assignConversation(conversationId, agentId);
    setConversation((c) => (c ? { ...c, assigned_agent_id: agentId === undefined ? meId : agentId } : c));
    setShowAssign(false);
    onChanged();
  };

  const submitNote = async () => {
    const content = noteDraft.trim();
    if (!content) return;
    const note = await addNote(conversationId, content);
    setNotes((prev) => [...prev, note]);
    setNoteDraft('');
  };

  const name = conversation?.visitor_name || conversation?.visitor_email || 'Anonymous visitor';
  const meta = conversation?.metadata as
    | {
        current_page?: string;
        location?: { city?: string; region?: string; country?: string; country_code?: string };
        ip_address?: string;
        user_agent?: string;
        language?: string;
        timezone?: string;
        referrer?: string | null;
        screen_resolution?: string;
        order_id?: string;
        user_id?: string;
        phone?: string;
      }
    | undefined;
  const geoText = meta?.location
    ? [meta.location.city, meta.location.region, meta.location.country].filter(Boolean).join(', ')
    : '';
  const assignedId = conversation?.assigned_agent_id ?? null;
  const assignedName = assignedId ? agents.find((a) => a.id === assignedId)?.name ?? 'someone' : null;

  // Match the live-presence record for this visitor (online status + pages).
  const live = presence.find((v) => v.visitorId === conversation?.visitor_id) ?? null;

  return (
    <div className="flex h-full relative min-w-0">
      {/* Conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-gray-200 flex items-center gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-gray-800 truncate flex items-center gap-2">
              {name}
              {live?.online && (
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-green-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> online
                </span>
              )}
            </p>
            <p className="text-xs text-gray-500 truncate flex items-center gap-1">
              {meta?.order_id && <span className="text-blue-600">Order #{meta.order_id} · </span>}
              {geoText && (
                <>
                  <MapPin className="w-3 h-3 shrink-0" />
                  {geoText}
                  {' · '}
                </>
              )}
              {meta?.current_page || ''}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <div className="relative">
              <button
                onClick={() => setShowAssign((s) => !s)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-gray-100 text-gray-600 hover:bg-gray-200 transition"
              >
                <UserPlus className="w-4 h-4" />
                {assignedId === meId ? 'You' : assignedName ?? 'Assign'}
              </button>
              {showAssign && (
                <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-10 max-h-64 overflow-y-auto">
                  <button onClick={() => doAssign(undefined)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                    Claim (assign to me)
                  </button>
                  {assignedId && (
                    <button onClick={() => doAssign(null)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                      Release to pool
                    </button>
                  )}
                  <div className="border-t border-gray-100 my-1" />
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => doAssign(a.id)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span className={`w-2 h-2 rounded-full ${a.is_online ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={toggleResolved}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition ${
                conversation?.status === 'resolved' ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-green-100 text-green-700 hover:bg-green-200'
              }`}
            >
              {conversation?.status === 'resolved' ? <RotateCcw className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
              <span className="hidden sm:inline">{conversation?.status === 'resolved' ? 'Reopen' : 'Resolve'}</span>
            </button>
            <button
              onClick={() => setShowInfo((s) => !s)}
              className={`p-2 rounded-full transition ${showInfo ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              title="Visitor details"
              aria-label="Visitor details"
            >
              {showInfo ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
          {timeline.map((item) =>
            item.kind === 'note' ? (
              <div key={`n-${item.data.id}`} className="mx-auto max-w-[90%] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
                <div className="text-[11px] text-amber-600 mb-0.5">📝 Internal note · {item.data.agent_name ?? 'Agent'}</div>
                <p className="whitespace-pre-wrap break-words">{item.data.content}</p>
              </div>
            ) : (
              <Bubble key={`m-${item.data.id}`} m={item.data} />
            ),
          )}
          {visitorTyping && (
            <div className="flex justify-start">
              <div className="bg-white shadow-sm rounded-lg px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-gray-200">
          {cannedMatches.length > 0 && (
            <div className="border-b border-gray-100 max-h-48 overflow-y-auto">
              {cannedMatches.map((c) => (
                <button key={c.id} onClick={() => setInput(c.content)} className="w-full text-left px-4 py-2 hover:bg-gray-50">
                  <span className="text-sm font-medium text-blue-600">/{c.shortcut}</span>
                  <span className="text-sm text-gray-500 ml-2">{c.title}</span>
                  <p className="text-xs text-gray-400 truncate">{c.content}</p>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5 px-3 pt-2.5">
            <button onClick={() => setMode('reply')} className={`text-xs font-semibold px-3 py-1 rounded-full transition ${mode === 'reply' ? 'bg-blue-100 text-blue-700' : 'text-gray-400 hover:bg-gray-100'}`}>
              Reply
            </button>
            <button onClick={() => setMode('note')} className={`text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1 transition ${mode === 'note' ? 'bg-amber-100 text-amber-700' : 'text-gray-400 hover:bg-gray-100'}`}>
              <StickyNote className="w-3 h-3" /> Note
            </button>
          </div>
          <form onSubmit={handleSend} className="p-3 pt-2 flex items-center gap-2">
            <input ref={fileRef} type="file" onChange={handleFile} className="hidden"
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" />
            <button type="button" onClick={() => fileRef.current?.click()} className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition shrink-0" disabled={sending || mode === 'note'} aria-label="Attach">
              <Paperclip className="w-5 h-5" />
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => handleInput(e.target.value)}
              placeholder={mode === 'note' ? 'Add an internal note…' : 'Type a reply…  (/ for canned)'}
              className={`flex-1 px-4 py-2.5 border rounded-full text-sm outline-none transition focus:ring-4 ${
                mode === 'note' ? 'bg-amber-50 border-amber-200 focus:ring-amber-400/20 focus:border-amber-400' : 'bg-gray-50 border-gray-200 focus:bg-white focus:ring-blue-500/15 focus:border-blue-400'
              }`}
            />
            <button type="submit" disabled={!input.trim() || sending} className={`w-11 h-11 shrink-0 flex items-center justify-center text-white rounded-full shadow-md transition active:scale-95 disabled:opacity-40 disabled:shadow-none ${mode === 'note' ? 'bg-amber-500 shadow-amber-500/25' : 'bg-blue-600 shadow-blue-600/25 hover:bg-blue-700'}`} aria-label="Send">
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>

      {/* ── Visitor detail sidebar (Crisp-style, tabbed) ─────────────────── */}
      {showInfo && (
        <aside className="absolute lg:static inset-0 lg:inset-auto z-20 bg-white lg:w-80 shrink-0 lg:border-l border-gray-200 flex flex-col">
          <div className="flex items-center gap-2 px-4 h-12 border-b border-gray-100">
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center text-sm font-semibold shrink-0">
              {name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800 truncate">{name}</p>
              <p className="text-[11px] text-gray-500">
                {live?.online ? 'Online now' : 'Offline'} · {conversation?.status ?? '—'}
              </p>
            </div>
            <button onClick={() => setShowInfo(false)} className="ml-auto p-1 text-gray-400 lg:hidden" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-100 text-sm">
            {(['info', 'activity', 'notes'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 font-medium capitalize ${
                  tab === t ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'
                }`}
              >
                {t === 'notes' ? `Notes${notes.length ? ` (${notes.length})` : ''}` : t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 text-sm">
            {tab === 'info' && (
              <dl className="space-y-2.5">
                <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="Location" value={geoText || 'Unknown'} />
                <InfoRow icon={<span className="font-mono text-[10px]">IP</span>} label="IP address" value={meta?.ip_address ?? 'Unknown'} mono />
                {conversation?.visitor_email && <InfoRow label="Email" value={conversation.visitor_email} />}
                {meta?.phone && <InfoRow label="Phone" value={meta.phone} />}
                {meta?.user_id && <InfoRow label="User ID" value={meta.user_id} mono />}
                {meta?.order_id && <InfoRow label="Order" value={`#${meta.order_id}`} />}
                <InfoRow
                  icon={live?.device === 'mobile' ? <Smartphone className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
                  label="Device"
                  value={meta?.user_agent ? deviceLabel(meta.user_agent) : live?.device ?? 'Unknown'}
                />
                {meta?.screen_resolution && <InfoRow label="Screen" value={meta.screen_resolution} />}
                {meta?.language && <InfoRow label="Language" value={meta.language} />}
                {meta?.timezone && <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Timezone" value={meta.timezone} />}
                {meta?.referrer && <InfoRow label="Referrer" value={meta.referrer} truncate />}
                <InfoRow icon={<Link2 className="w-3.5 h-3.5" />} label="Current page" value={live?.url || meta?.current_page || 'Unknown'} truncate />
                {conversation && <InfoRow label="First seen" value={new Date(conversation.created_at).toLocaleString()} />}
                <InfoRow label="Messages" value={String(conversation?.message_count ?? messages.length)} />
                <InfoRow label="Visitor ID" value={conversation?.visitor_id ?? ''} mono truncate />
              </dl>
            )}

            {tab === 'activity' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="Status" value={live?.online ? 'Online' : 'Offline'} good={live?.online} />
                  <Metric label="Time on site" value={live ? duration(live.timeOnSite) : '—'} />
                  <Metric label="Visitor" value={live ? (live.returning ? 'Returning' : 'New') : '—'} />
                  <Metric label="Pages viewed" value={live ? String(live.pagesViewed) : '—'} />
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    <History className="w-3.5 h-3.5" /> Visited pages
                  </p>
                  {live && live.pages.length > 0 ? (
                    <ol className="space-y-1.5">
                      {live.pages
                        .slice()
                        .reverse()
                        .map((p, i) => (
                          <li key={`${p.at}-${i}`} className="flex items-start gap-2 text-xs">
                            <span className="text-gray-400 shrink-0 tabular-nums">{clockTime(p.at)}</span>
                            <span className={`min-w-0 break-all ${i === 0 ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>{p.url}</span>
                          </li>
                        ))}
                    </ol>
                  ) : (
                    <p className="text-xs text-gray-400">
                      {live ? 'No page history yet.' : 'Visitor is offline — live page history is only available while they browse.'}
                    </p>
                  )}
                </div>
              </div>
            )}

            {tab === 'notes' && (
              <div className="space-y-3">
                <div>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={3}
                    placeholder="Add an internal note (only agents see this)…"
                    className="w-full px-3 py-2 border border-amber-200 bg-amber-50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                  <button
                    onClick={submitNote}
                    disabled={!noteDraft.trim()}
                    className="mt-2 w-full bg-amber-500 text-white py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    Add note
                  </button>
                </div>
                {notes.length === 0 ? (
                  <p className="text-xs text-gray-400">No notes yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {notes
                      .slice()
                      .reverse()
                      .map((n) => (
                        <li key={n.id} className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                          <div className="text-[11px] text-amber-600 mb-0.5">
                            {n.agent_name ?? 'Agent'} · {new Date(n.created_at).toLocaleString()}
                          </div>
                          <p className="text-sm text-amber-900 whitespace-pre-wrap break-words">{n.content}</p>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <p className={`text-sm font-semibold ${good ? 'text-green-600' : 'text-gray-800'}`}>{value}</p>
      <p className="text-[11px] text-gray-500">{label}</p>
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  mono,
  truncate,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="flex items-center gap-1 text-gray-400 shrink-0 w-24">
        {icon}
        {label}
      </span>
      <span
        className={`text-gray-800 min-w-0 ${mono ? 'font-mono text-xs' : ''} ${truncate ? 'truncate' : 'break-words'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** Best-effort human label for a user-agent string (browser · OS). */
function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone|iPad|iOS/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' · ');
}

function Bubble({ m }: { m: AdminMessage }) {
  const isAgent = m.sender_type === 'agent';
  const attachment = m.metadata?.attachment;
  return (
    <div className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-3.5 py-2.5 text-sm shadow-sm ${
          isAgent
            ? 'bg-blue-600 text-white rounded-3xl rounded-br-md'
            : m.sender_type === 'ai'
              ? 'bg-violet-50 text-gray-800 rounded-3xl rounded-bl-md ring-1 ring-violet-100'
              : 'bg-white text-gray-800 rounded-3xl rounded-bl-md'
        }`}
      >
        {m.sender_type === 'ai' && <div className="text-[11px] font-semibold text-violet-500 mb-1">🤖 AI Assistant</div>}
        {m.sender_type === 'visitor' && <div className="text-[11px] text-gray-400 mb-1">Visitor</div>}
        {attachment ? (
          attachment.kind === 'image' ? (
            <a href={attachmentUrl(attachment.url)} target="_blank" rel="noreferrer">
              <img src={attachmentUrl(attachment.url)} alt={attachment.filename} className="rounded max-h-52 object-cover" />
            </a>
          ) : (
            <a href={attachmentUrl(attachment.url)} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
              <FileText className="w-4 h-4 shrink-0" />
              <span className="truncate">{attachment.filename}</span>
            </a>
          )
        ) : (
          <p className="whitespace-pre-wrap break-words">{m.content}</p>
        )}
      </div>
    </div>
  );
}
