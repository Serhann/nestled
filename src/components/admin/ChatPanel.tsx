import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Paperclip, CheckCircle, RotateCcw, MapPin, FileText, StickyNote, UserPlus } from 'lucide-react';
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
} from '../../lib/adminApi';

interface Props {
  conversationId: string;
  meId: string;
  liveMessage: { conversationId: string; message: AdminMessage } | null;
  typing: { conversationId: string; isTyping: boolean } | null;
  onChanged: () => void;
}

type TimelineItem =
  | { kind: 'msg'; at: string; data: AdminMessage }
  | { kind: 'note'; at: string; data: ConversationNote };

export function ChatPanel({ conversationId, meId, liveMessage, typing, onChanged }: Props) {
  const [conversation, setConversation] = useState<AdminConversation | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [canned, setCanned] = useState<CannedResponse[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [sending, setSending] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
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

  // `/shortcut` autocomplete for canned responses (reply mode only).
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

  const name = conversation?.visitor_name || conversation?.visitor_email || 'Anonymous visitor';
  const meta = conversation?.metadata as
    | { current_page?: string; location?: { city?: string; country?: string }; order_id?: string; user_id?: string; phone?: string }
    | undefined;
  const assignedId = conversation?.assigned_agent_id ?? null;
  const assignedName = assignedId ? agents.find((a) => a.id === assignedId)?.name ?? 'someone' : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-800 truncate">
            {name}
            {conversation?.visitor_email && conversation?.visitor_name && (
              <span className="ml-2 text-xs font-normal text-gray-400">{conversation.visitor_email}</span>
            )}
            {meta?.phone && (
              <a href={`tel:${meta.phone}`} className="ml-2 text-xs font-normal text-gray-400 hover:text-gray-600">
                {meta.phone}
              </a>
            )}
          </p>
          <p className="text-xs text-gray-500 truncate flex items-center gap-1">
            {meta?.order_id && <span className="text-blue-600">Order #{meta.order_id} · </span>}
            {meta?.location?.country && (
              <>
                <MapPin className="w-3 h-3" />
                {[meta.location.city, meta.location.country].filter(Boolean).join(', ')}
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
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm bg-gray-100 text-gray-700"
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
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium ${
              conversation?.status === 'resolved' ? 'bg-gray-100 text-gray-600' : 'bg-green-50 text-green-700'
            }`}
          >
            {conversation?.status === 'resolved' ? <RotateCcw className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
            {conversation?.status === 'resolved' ? 'Reopen' : 'Resolve'}
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
        {/* Canned `/` autocomplete */}
        {cannedMatches.length > 0 && (
          <div className="border-b border-gray-100 max-h-48 overflow-y-auto">
            {cannedMatches.map((c) => (
              <button
                key={c.id}
                onClick={() => setInput(c.content)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50"
              >
                <span className="text-sm font-medium text-blue-600">/{c.shortcut}</span>
                <span className="text-sm text-gray-500 ml-2">{c.title}</span>
                <p className="text-xs text-gray-400 truncate">{c.content}</p>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 px-3 pt-2">
          <button
            onClick={() => setMode('reply')}
            className={`text-xs px-2 py-1 rounded ${mode === 'reply' ? 'bg-blue-100 text-blue-700' : 'text-gray-500'}`}
          >
            Reply
          </button>
          <button
            onClick={() => setMode('note')}
            className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${mode === 'note' ? 'bg-amber-100 text-amber-700' : 'text-gray-500'}`}
          >
            <StickyNote className="w-3 h-3" /> Note
          </button>
        </div>
        <form onSubmit={handleSend} className="p-3 pt-1.5 flex items-center gap-2">
          <input ref={fileRef} type="file" onChange={handleFile} className="hidden"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" />
          <button type="button" onClick={() => fileRef.current?.click()} className="p-2 text-gray-500 hover:text-gray-700" disabled={sending || mode === 'note'} aria-label="Attach">
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            placeholder={mode === 'note' ? 'Add an internal note…' : 'Type a reply…  (/ for canned)'}
            className={`flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 ${
              mode === 'note' ? 'bg-amber-50 border-amber-200 focus:ring-amber-400' : 'border-gray-300 focus:ring-blue-500'
            }`}
          />
          <button type="submit" disabled={!input.trim() || sending} className={`p-2 text-white rounded-lg disabled:opacity-50 ${mode === 'note' ? 'bg-amber-500' : 'bg-blue-600'}`} aria-label="Send">
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: AdminMessage }) {
  const isAgent = m.sender_type === 'agent';
  const attachment = m.metadata?.attachment;
  return (
    <div className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isAgent ? 'bg-blue-600 text-white' : m.sender_type === 'ai' ? 'bg-violet-50 text-gray-800' : 'bg-white shadow-sm text-gray-800'
        }`}
      >
        {m.sender_type === 'ai' && <div className="text-[11px] text-violet-500 mb-1">🤖 AI Assistant</div>}
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
