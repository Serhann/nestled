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
  X,
  Sparkles,
  ArrowRight,
  Eye,
  Languages,
  ChevronDown,
  ChevronUp,
  Check,
  Pencil,
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
  conversationOrigin,
  translate,
  updateVisitor,
  listVisitorIps,
  getVisitorPerson,
  type VisitorIp,
  type PersonProfile,
} from '../../lib/adminApi';
import { Markdown } from '../../lib/markdown';
import { VisitorAvatar } from './VisitorAvatar';
import {
  CrossSitePersonBlock,
  InfoRow,
  IpHistoryBlock,
  Metric,
  PageHistoryBlock,
  VerifiedContextCard,
  deviceLabel,
  duration,
} from './visitorInfo';
import {
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
  magicBrowse?: boolean;
  onWatch?: (visitorId: string) => void;
  onOpenConversation?: (conversationId: string) => void;
  refreshSignal?: number; // bump → refetch this conversation (live metadata change)
  onChanged: () => void;
}

type TimelineItem =
  | { kind: 'msg'; at: string; data: AdminMessage }
  | { kind: 'note'; at: string; data: ConversationNote };

type Tab = 'info' | 'activity' | 'notes';

const TRANSLATE_LANGS = [
  'English', 'Turkish', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Arabic', 'Russian', 'Hindi', 'Chinese', 'Japanese', 'Korean', 'Dutch',
] as const;

export function ChatPanel({ conversationId, meId, liveMessage, typing, presence, magicBrowse, onWatch, onOpenConversation, refreshSignal, onChanged }: Props) {
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
  // Live translation: inbound = show visitor/AI messages in the agent's
  // language; outbound = send the agent's reply in the customer's language.
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [editName, setEditName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [ips, setIps] = useState<VisitorIp[]>([]);
  const [person, setPerson] = useState<PersonProfile | null>(null);
  const [showTranslate, setShowTranslate] = useState(false);
  const [translateTo, setTranslateTo] = useState(() => localStorage.getItem('nestled_tx_in') || '');
  const [replyLang, setReplyLang] = useState(() => localStorage.getItem('nestled_tx_out') || '');
  const [translations, setTranslations] = useState<Record<string, string>>({});
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
        const vid = c.conversation.visitor_id;
        if (vid) {
          listVisitorIps(vid).then((r) => !cancelled && setIps(r)).catch(() => undefined);
          getVisitorPerson(vid).then((p) => !cancelled && setPerson(p)).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    listCanned().then(setCanned).catch(() => undefined);
    listAgents().then(setAgents).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Live refresh: an agent-firehose "conversation:updated" for THIS conversation
  // (e.g. the host re-signed a fresh order status). Refetch the conversation only
  // — leave messages/scroll untouched — so the VERIFIED CONTEXT card updates.
  useEffect(() => {
    if (!refreshSignal) return;
    let cancelled = false;
    getConversation(conversationId)
      .then((c) => !cancelled && setConversation(c.conversation))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshSignal, conversationId]);

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

  // Inbound translation: translate visitor/AI messages into the agent's chosen
  // language, cached by `${id}|${lang}`. A ref keeps the effect off `translations`
  // so filling the cache doesn't re-trigger it.
  const translationsRef = useRef(translations);
  translationsRef.current = translations;
  useEffect(() => {
    if (!translateTo) return;
    const todo = messages.filter(
      (m) => m.sender_type !== 'agent' && (m.content ?? '').trim() && !(`${m.id}|${translateTo}` in translationsRef.current),
    );
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const m of todo) {
        try {
          const t = await translate(m.content, translateTo);
          if (cancelled) return;
          setTranslations((prev) => ({ ...prev, [`${m.id}|${translateTo}`]: t }));
        } catch {
          /* leave original */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, translateTo]);

  const setTx = (dir: 'in' | 'out', lang: string) => {
    if (dir === 'in') {
      setTranslateTo(lang);
      localStorage.setItem('nestled_tx_in', lang);
    } else {
      setReplyLang(lang);
      localStorage.setItem('nestled_tx_out', lang);
    }
  };

  const visitorTyping = typing?.conversationId === conversationId && typing.isTyping;

  const cannedMatches = useMemo(() => {
    if (mode !== 'reply') return [];
    const m = /^\/([a-z0-9-]*)$/.exec(input.trim());
    if (!m) return [];
    const q = m[1];
    // Scope to this conversation's site: an empty `sites` shows everywhere.
    const cmode = (conversation?.metadata as { widget_mode?: string } | undefined)?.widget_mode;
    return canned
      .filter((c) => c.sites.length === 0 || (cmode != null && c.sites.includes(cmode)))
      .filter((c) => c.shortcut.startsWith(q))
      .slice(0, 6);
  }, [input, canned, mode, conversation]);

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
        // Outbound translation: send the reply in the customer's language.
        let toSend = content;
        if (replyLang) {
          try {
            toSend = await translate(content, replyLang);
          } catch {
            /* fall back to the original */
          }
        }
        const m = await apiReply(conversationId, toSend);
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

  const startEditName = () => {
    setNameDraft(conversation?.visitor_name ?? '');
    setEditName(true);
  };
  const saveName = async () => {
    const next = nameDraft.trim();
    await updateVisitor(conversationId, { visitor_name: next || null });
    setConversation((c) => (c ? { ...c, visitor_name: next || null } : c));
    setEditName(false);
    onChanged();
  };

  const name = conversation?.visitor_name || conversation?.visitor_email || 'Anonymous visitor';
  const meta = conversation?.metadata as
    | {
        current_page?: string;
        location?: { city?: string; region?: string; country?: string; country_code?: string; isp?: string; org?: string };
        ip_address?: string;
        user_agent?: string;
        language?: string;
        timezone?: string;
        referrer?: string | null;
        screen_resolution?: string;
        user_id?: string;
        phone?: string;
        prechat?: Record<string, string>;
        // Mirrors server/src/services/verifiedAttributes.ts.
        verified_context?: {
          customer?: { id?: string | number; name?: string; email?: string; phone?: string };
          attributes?: Record<string, string | number | boolean | null>;
        };
        attributes?: Record<string, string>;
        handoff?: {
          by?: string;
          reason?: string;
          summary?: string;
          suggestion?: string;
          request?: string;
          fields?: Record<string, string> | null;
          at?: string;
        };
      }
    | undefined;
  const handoff = conversation?.needs_human ? meta?.handoff : undefined;
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
              {(() => {
                const src = conversationOrigin(conversation?.metadata);
                if (!src) return null;
                return <span className="text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0 bg-gray-100 text-gray-600">{src}</span>;
              })()}
              {handoff && (
                <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wide bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                  <Sparkles className="w-2.5 h-2.5" /> ESCALATED BY BOT
                </span>
              )}
            </p>
            <p className="text-xs text-gray-500 truncate flex items-center gap-1">
              {handoff?.reason && <span className="text-blue-600 font-medium">{handoff.reason} · </span>}
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
            {/* Live translation */}
            <div className="relative">
              <button
                onClick={() => setShowTranslate((s) => !s)}
                title="Live translation"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition ${
                  translateTo || replyLang ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                <Languages className="w-4 h-4" />
                <span className="hidden sm:inline">{translateTo || replyLang ? 'Translating' : 'Translate'}</span>
              </button>
              {showTranslate && (
                <div className="absolute right-0 mt-1 w-64 bg-white rounded-2xl shadow-lg border border-gray-100 p-3 z-20 space-y-3">
                  <div>
                    <label className="block text-[11px] font-bold tracking-wide text-gray-500 mb-1">SHOW MESSAGES IN</label>
                    <select
                      value={translateTo}
                      onChange={(e) => setTx('in', e.target.value)}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                    >
                      <option value="">Off (original)</option>
                      {TRANSLATE_LANGS.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold tracking-wide text-gray-500 mb-1">SEND MY REPLIES IN</label>
                    <select
                      value={replyLang}
                      onChange={(e) => setTx('out', e.target.value)}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                    >
                      <option value="">Off (as typed)</option>
                      {TRANSLATE_LANGS.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-[11px] text-gray-400">Powered by your configured AI provider.</p>
                </div>
              )}
            </div>
            {magicBrowse && onWatch && conversation?.visitor_id && (
              <button
                onClick={() => onWatch(conversation.visitor_id)}
                disabled={!live?.online}
                title={live?.online ? "Watch this visitor's screen live" : 'Live view is available while the visitor is online'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition ${
                  live?.online ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                <Eye className="w-4 h-4" />
                <span className="hidden sm:inline">Watch</span>
                {live?.online && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
              </button>
            )}
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
          {/* Bot → human handoff summary (design t3). Sticky so the agent always
              sees it while scrolling; collapsible to reclaim space. */}
          {handoff && (
            <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-3 pb-2 bg-gray-50/95 backdrop-blur">
              <div className="rounded-2xl border border-blue-200 bg-blue-50 shadow-sm p-4">
              <button
                type="button"
                onClick={() => setSummaryOpen((s) => !s)}
                className="flex items-center gap-1.5 w-full"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span className="text-[10px] font-bold tracking-wider text-blue-700">BOT SUMMARY</span>
                {!summaryOpen && handoff.summary && (
                  <span className="text-xs text-gray-600 truncate ml-1.5 font-normal">{handoff.summary}</span>
                )}
                {handoff.at && summaryOpen && (
                  <span className="ml-auto text-[11px] text-gray-400">{new Date(handoff.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                )}
                {summaryOpen ? <ChevronUp className="w-4 h-4 text-blue-500 shrink-0 ml-auto" /> : <ChevronDown className="w-4 h-4 text-blue-500 shrink-0 ml-auto" />}
              </button>
              {summaryOpen && (
              <div className="mt-2">
              {handoff.summary && <p className="text-sm text-gray-800 leading-relaxed mb-2">{handoff.summary}</p>}
              <p className="text-sm text-gray-800 leading-relaxed">
                <span className="font-semibold">{handoff.reason ?? 'Handoff'}</span>.
              </p>
              {/* Whatever the starter's intake form collected — the field names are
                  the customer's, so render them generically rather than by key. */}
              {handoff.fields && Object.keys(handoff.fields).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(handoff.fields).map(([key, value]) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 rounded-full bg-white border border-blue-200 text-blue-700 px-2.5 py-1 text-xs font-semibold"
                    >
                      <span className="font-normal text-blue-500">{key}</span> {value}
                    </span>
                  ))}
                </div>
              )}
              {handoff.request && (
                <p className="text-xs text-gray-500 mt-1.5 italic">“{handoff.request}”</p>
              )}
              {handoff.suggestion && (
                <div className="mt-3 flex items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1 rounded-full bg-white border border-blue-200 text-blue-700 px-2.5 py-1 text-xs font-semibold shrink-0">
                    <ArrowRight className="w-3 h-3" /> Suggested
                  </span>
                  <span className="text-gray-700">{handoff.suggestion}</span>
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                {assignedId !== meId && (
                  <button
                    onClick={() => doAssign(undefined)}
                    className="inline-flex items-center gap-1.5 bg-blue-600 text-white rounded-full px-3.5 py-1.5 text-xs font-semibold hover:bg-blue-700 transition"
                  >
                    <UserPlus className="w-3.5 h-3.5" /> Claim &amp; reply
                  </button>
                )}
                <button
                  onClick={toggleResolved}
                  className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 rounded-full px-3.5 py-1.5 text-xs font-semibold hover:bg-gray-50 transition"
                >
                  <CheckCircle className="w-3.5 h-3.5" /> Mark resolved
                </button>
              </div>
              </div>
              )}
              </div>
            </div>
          )}
          {timeline.map((item) =>
            item.kind === 'note' ? (
              <div key={`n-${item.data.id}`} className="mx-auto max-w-[90%] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
                <div className="text-[11px] text-amber-600 mb-0.5">📝 Internal note · {item.data.agent_name ?? 'Agent'}</div>
                <p className="whitespace-pre-wrap break-words">{item.data.content}</p>
              </div>
            ) : (
              <Bubble
                key={`m-${item.data.id}`}
                m={item.data}
                translated={
                  translateTo && item.data.sender_type !== 'agent'
                    ? translations[`${item.data.id}|${translateTo}`]
                    : undefined
                }
              />
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
            <div className="border-b border-gray-100 max-h-52 overflow-y-auto">
              <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-wider text-gray-400">
                CANNED RESPONSES · press Enter or click to insert
              </div>
              {cannedMatches.map((c) => (
                <button key={c.id} onClick={() => setInput(c.content)} className="w-full text-left px-4 py-2 hover:bg-blue-50">
                  <span className="text-sm font-semibold text-blue-600">/{c.shortcut}</span>
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
              onKeyDown={(e) => {
                // Enter while the canned hint is open inserts the top match
                // instead of sending the "/shortcut" text.
                if (e.key === 'Enter' && cannedMatches.length > 0) {
                  e.preventDefault();
                  setInput(cannedMatches[0].content);
                }
              }}
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
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
            <VisitorAvatar email={conversation?.visitor_email} name={name} size={32} />
            <div className="min-w-0 flex-1">
              {editName ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => void saveName()}
                    placeholder="Visitor name"
                    className="min-w-0 flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  />
                  <button type="submit" className="text-blue-600 p-1" aria-label="Save name">
                    <Check className="w-4 h-4" />
                  </button>
                </form>
              ) : (
                <button onClick={startEditName} className="group flex items-center gap-1 max-w-full" title="Rename visitor">
                  <span className="text-sm font-semibold text-gray-800 truncate">{name}</span>
                  <Pencil className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 shrink-0" />
                </button>
              )}
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
                {meta?.verified_context && <VerifiedContextCard context={meta.verified_context} />}
                <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="Location" value={geoText || 'Unknown'} />
                <InfoRow icon={<span className="font-mono text-[10px]">IP</span>} label="IP address" value={meta?.ip_address ?? 'Unknown'} mono />
                {meta?.location?.isp && <InfoRow label="ISP" value={meta.location.isp} />}
                {conversation?.visitor_email && <InfoRow label="Email" value={conversation.visitor_email} />}
                {meta?.phone && <InfoRow label="Phone" value={meta.phone} />}
                {meta?.user_id && <InfoRow label="User ID" value={meta.user_id} mono />}
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
                {meta?.prechat && Object.keys(meta.prechat).length > 0 && (
                  <>
                    <div className="pt-1 mt-1 border-t border-gray-100 text-[11px] font-bold tracking-wide text-gray-400">PRE-CHAT</div>
                    {Object.entries(meta.prechat).map(([k, v]) => (
                      <InfoRow key={k} label={k.replace(/^visitor_/, '').replace(/_/g, ' ')} value={String(v)} />
                    ))}
                  </>
                )}
                <IpHistoryBlock ips={ips} />
                <CrossSitePersonBlock
                  person={person}
                  excludeConversationId={conversationId}
                  onOpenConversation={onOpenConversation}
                />
              </dl>
            )}

            {tab === 'activity' && (
              <div className="space-y-4">
                {magicBrowse && onWatch && conversation?.visitor_id && (
                  <button
                    onClick={() => onWatch(conversation.visitor_id)}
                    disabled={!live?.online}
                    className={`w-full flex items-center gap-2.5 rounded-2xl px-4 py-3 text-left transition ${
                      live?.online ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    <Eye className="w-5 h-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">Watch live session</span>
                      <span className={`block text-[11px] ${live?.online ? 'text-white/80' : 'text-gray-400'}`}>
                        {live?.online ? 'See their screen in real time' : 'Available while the visitor is online'}
                      </span>
                    </span>
                    {live?.online && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />}
                  </button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="Status" value={live?.online ? 'Online' : 'Offline'} good={live?.online} />
                  <Metric label="Time on site" value={live ? duration(live.timeOnSite) : '—'} />
                  <Metric label="Visitor" value={live ? (live.returning ? 'Returning' : 'New') : '—'} />
                  <Metric label="Pages viewed" value={live ? String(live.pagesViewed) : '—'} />
                </div>
                <PageHistoryBlock
                  pages={live?.pages}
                  emptyText={
                    live
                      ? 'No page history yet.'
                      : 'Visitor is offline — live page history is only available while they browse.'
                  }
                />
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

function Bubble({ m, translated }: { m: AdminMessage; translated?: string }) {
  const isAgent = m.sender_type === 'agent';
  const attachment = m.metadata?.attachment;
  const showTx = translated != null && translated !== m.content;
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
        ) : showTx ? (
          <>
            <Markdown text={translated ?? ''} />
            <p className="mt-1 text-[11px] italic opacity-70 flex items-center gap-1 border-t border-black/5 pt-1">
              <Languages className="w-3 h-3 shrink-0" /> {m.content}
            </p>
          </>
        ) : (
          <Markdown text={m.content} />
        )}
      </div>
    </div>
  );
}
