import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, X, Send, Minimize2, Paperclip, Volume2, VolumeX, FileText } from 'lucide-react';
import {
  apiBase,
  attachmentUrl,
  createConversation,
  getAgentStatus,
  getActiveTriggers,
  getGeo,
  getMessages,
  getWidgetConfig,
  fireTrigger,
  openConversationWS,
  openPresenceWS,
  sendMessage as apiSendMessage,
  sendTyping,
  uploadAttachment,
  type WidgetConfig,
  type WidgetMessage,
  type PreChatField,
} from '../lib/api';
import { strings } from '../lib/strings';
import { TriggerEngine } from '../utils/triggerEngine';
import type { Trigger } from '../types/chat';

function hostUrl(): string {
  return new URLSearchParams(window.location.search).get('href') || document.referrer || window.location.href;
}

/**
 * True when the widget runs inside the embed iframe (the normal case): the host
 * page sizes the iframe via the `jetchat:resize` messages, so the panel should
 * fill it (inset-0). When rendered standalone (the /chat page opened directly)
 * it must instead be a constrained floating card so it doesn't cover the page.
 */
function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent access throws → we are embedded
  }
}

/** Visitor identity from embed params (ue/un/up/uid/oid) or direct URL params. */
function readIdentity(): Record<string, string> {
  const p = new URLSearchParams(window.location.search);
  const id: Record<string, string> = {};
  const map: Array<[string, string, string]> = [
    ['ue', 'user_email', 'email'],
    ['un', 'user_name', 'name'],
    ['up', 'user_phone', 'phone'],
    ['uid', 'user_id', 'user_id'],
    ['oid', 'order_id', 'order_id'],
  ];
  for (const [short, long, key] of map) {
    const v = p.get(short) || p.get(long);
    if (v) id[key] = v;
  }
  return id;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CONV_KEY = 'jetchat_conv';
const MUTE_KEY = 'jetchat_muted';
// Short notification blip.
const BLIP =
  'data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

interface StoredConversation {
  id: string;
  token: string;
}

function getVisitorId(): string {
  const fromParam = new URLSearchParams(window.location.search).get('vid');
  if (fromParam) return fromParam;
  let id = localStorage.getItem('jetchat_visitor_id');
  if (!id) {
    id = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('jetchat_visitor_id', id);
  }
  return id;
}

function loadStoredConversation(): StoredConversation | null {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    return raw ? (JSON.parse(raw) as StoredConversation) : null;
  } catch {
    return null;
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A header background gradient derived from the configured primary color. */
function headerGradient(color: string): string {
  return `linear-gradient(135deg, ${color} 0%, color-mix(in srgb, ${color} 75%, #000) 100%)`;
}

export function ChatWidget() {
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversation, setConversation] = useState<StoredConversation | null>(loadStoredConversation);
  const [agentOnline, setAgentOnline] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const [unread, setUnread] = useState(0);
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1');
  const [sending, setSending] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [triggerMessage, setTriggerMessage] = useState<string | null>(null);
  const [activeTriggerId, setActiveTriggerId] = useState<string | null>(null);

  // Pre-chat + offline-message forms.
  const [showPreChat, setShowPreChat] = useState(false);
  const [preChat, setPreChat] = useState<Record<string, string>>({});
  const [preChatErrors, setPreChatErrors] = useState<Record<string, string>>({});
  const [leaveEmail, setLeaveEmail] = useState('');
  const [leaveMessage, setLeaveMessage] = useState('');
  const [leaveErrors, setLeaveErrors] = useState<{ email?: string; message?: string }>({});
  const [leaveSent, setLeaveSent] = useState(false);

  const visitorId = useRef(getVisitorId());
  const identity = useRef<Record<string, string>>(readIdentity());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const engineRef = useRef<TriggerEngine | null>(null);
  const triggersRan = useRef(false);

  const primaryColor = config?.primary_color || '#3B82F6';
  const embedded = isEmbedded();
  const side = config?.widget_position === 'left' ? 'left' : 'right';

  // ── Load config + agent status ──────────────────────────────────────────────
  useEffect(() => {
    getWidgetConfig()
      .then((r) => setConfig(r.settings))
      .catch(() => undefined);
    audioRef.current = new Audio(BLIP);
  }, []);

  // ── Keep the online/offline indicator fresh ─────────────────────────────────
  // Before a conversation exists there is no realtime channel, so a one-shot
  // fetch would go stale (e.g. show "offline" after an agent connects). Poll the
  // status endpoint on a short interval and whenever the tab regains focus. Once
  // a conversation opens, its WS also pushes agent:status live (see below).
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      getAgentStatus()
        .then((r) => !cancelled && setAgentOnline(r.online))
        .catch(() => undefined);
    refresh();
    const interval = setInterval(refresh, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  // ── Persist conversation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (conversation) localStorage.setItem(CONV_KEY, JSON.stringify(conversation));
  }, [conversation]);

  // ── Load history + open realtime when a conversation exists ──────────────────
  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    getMessages(conversation.id, conversation.token)
      .then((r) => {
        if (!cancelled) setMessages(r.messages);
      })
      .catch(() => undefined);

    const ws = openConversationWS(conversation.id, conversation.token, {
      onMessage: (m) => {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        if (m.sender_type !== 'visitor') {
          if (!openRef.current) setUnread((u) => u + 1);
          playBlip();
        }
      },
      onTyping: (t) => setAgentTyping(t),
      onAgentStatus: (o) => setAgentOnline(o),
    });
    wsRef.current = ws;
    return () => {
      cancelled = true;
      ws.close();
      wsRef.current = null;
    };
  }, [conversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentTyping]);

  // ── Tell the host embed how big to make the iframe ───────────────────────────
  useEffect(() => {
    const state = open ? (minimized ? 'minimized' : 'open') : 'closed';
    const size =
      state === 'closed'
        ? { width: 76, height: 76 }
        : state === 'minimized'
          ? { width: 384, height: 68 }
          : { width: 384, height: 640 };
    window.parent.postMessage({ type: 'jetchat:resize', state, ...size }, '*');
  }, [open, minimized]);

  // ── Standalone presence ──────────────────────────────────────────────────────
  // When the widget runs on its own (demo / opened directly, not inside the embed
  // iframe), open a presence connection so this visitor shows up on the admin's
  // Live Visitors board. In the real embed the host page's presence.js does this
  // (and reports the true host URL), so we skip it there to avoid double-tracking.
  useEffect(() => {
    if (embedded) return;
    const p = openPresenceWS(visitorId.current, {
      onProactive: (data) => {
        setConversation({ id: data.conversation_id, token: data.visitor_token });
        setShowPreChat(false);
        setOpen(true);
        setMinimized(false);
        setUnread(0);
      },
    });
    return () => p.stop();
  }, [embedded]);

  // ── Proactive: the embed forwards an agent-initiated chat ────────────────────
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'jetchat:proactive' && data.conversation_id && data.visitor_token) {
        setConversation({ id: data.conversation_id, token: data.visitor_token });
        setShowPreChat(false);
        setOpen(true);
        setMinimized(false);
        setUnread(0);
      } else if (data && data.type === 'jetchat:identify' && data.traits) {
        // Late identity (e.g. after the visitor logs in on the host site).
        Object.assign(identity.current, data.traits);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const playBlip = useCallback(() => {
    if (muted || openRef.current) return;
    audioRef.current?.play().catch(() => undefined);
  }, [muted]);

  // Execute a matched trigger's actions. Proactive messages are shown locally
  // (a website nudge); a conversation is created only when the visitor replies.
  const executeTrigger = useCallback((t: Trigger) => {
    if (!t.actions) return;
    fireTrigger(t.id);
    setActiveTriggerId(t.id);
    if (t.actions.open_chatbox) {
      setOpen(true);
      setMinimized(false);
      setUnread(0);
    }
    if (t.actions.show_message && t.actions.message_content) {
      setTriggerMessage(t.actions.message_content);
      if (!openRef.current) setUnread((u) => u + 1);
    }
    if (t.actions.play_sound && !muted) audioRef.current?.play().catch(() => undefined);
    engineRef.current?.markTriggerExecuted(t.id);
  }, [muted]);

  // Load active triggers + server-side country, then evaluate once on load.
  useEffect(() => {
    if (!config || triggersRan.current) return;
    triggersRan.current = true;
    void (async () => {
      try {
        const [{ triggers }, geo] = await Promise.all([getActiveTriggers(), getGeo().catch(() => ({ country_code: null }))]);
        if (!triggers || triggers.length === 0) return;
        const engine = new TriggerEngine();
        engine.setCountry(geo.country_code);
        engine.setTriggers(triggers as Trigger[]);
        engineRef.current = engine;

        engine.setupEventListeners({
          onLeaveIntent: executeTrigger,
          onClickLink: executeTrigger,
          onDelay: executeTrigger,
        });

        const matched = await engine.evaluateTriggers({ isOnline: agentOnline, currentUrl: hostUrl() });
        for (const t of matched) {
          // Delay / leave-intent / click triggers fire via their listeners.
          if (t.events?.after_delay || t.events?.on_leave_intent || t.events?.on_click_link) continue;
          executeTrigger(t);
        }
      } catch {
        /* triggers are best-effort */
      }
    })();
  }, [config, agentOnline, executeTrigger]);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem(MUTE_KEY, next ? '1' : '0');
      return next;
    });
  };

  const conversationMetadata = () => ({
    user_agent: navigator.userAgent,
    language: navigator.language,
    referrer: document.referrer || null,
    current_page: hostUrl(),
    screen_resolution: `${window.screen.width}x${window.screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Attribute the conversation to the trigger that produced it (analytics).
    ...(activeTriggerId ? { trigger_id: activeTriggerId } : {}),
    // Known visitor identity (user_id, order_id, and any custom traits).
    ...identity.current,
  });

  const ensureConversation = useCallback(
    async (extra?: { visitor_name?: string; visitor_email?: string }): Promise<StoredConversation> => {
      if (conversation) return conversation;
      const created = await createConversation({
        visitor_id: visitorId.current,
        // Prefer explicit prechat/leave-form input, else known identity.
        visitor_name: extra?.visitor_name ?? identity.current.name,
        visitor_email: extra?.visitor_email ?? identity.current.email,
        metadata: conversationMetadata(),
      });
      const conv = { id: created.conversation_id, token: created.visitor_token };
      setConversation(conv);
      return conv;
    },
    [conversation],
  );

  // ── Open / close ─────────────────────────────────────────────────────────────
  const handleOpen = () => {
    setOpen(true);
    setMinimized(false);
    setUnread(0);
    if (!conversation) {
      if (config?.pre_chat_enabled) setShowPreChat(true);
    }
  };
  const handleClose = () => {
    setOpen(false);
    setShowPreChat(false);
  };

  // Offline fallback = no agent online AND AI disabled AND no conversation yet.
  const showLeaveMessage =
    open && !showPreChat && !conversation && !agentOnline && config != null && !config.ai_enabled;

  // ── Send text ────────────────────────────────────────────────────────────────
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    setSending(true);
    try {
      const conv = await ensureConversation();
      const { message } = await apiSendMessage(conv.id, conv.token, content);
      setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
    } catch {
      setAttachError(strings.genericError);
    } finally {
      setSending(false);
    }
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    if (!conversation) return;
    sendTyping(conversation.id, conversation.token, true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      if (conversation) sendTyping(conversation.id, conversation.token, false);
    }, 2000);
  };

  // ── Attachments ──────────────────────────────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAttachError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setAttachError(strings.attachmentTooLarge);
      return;
    }
    setSending(true);
    try {
      const conv = await ensureConversation();
      const { message } = await uploadAttachment(conv.id, conv.token, file);
      setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
    } catch (err) {
      setAttachError((err as Error).message.includes('415') ? strings.attachmentRejected : strings.genericError);
    } finally {
      setSending(false);
    }
  };

  // ── Pre-chat submit (inline validation, no alert) ────────────────────────────
  const handlePreChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fields = config?.pre_chat_fields ?? [];
    const errors: Record<string, string> = {};
    for (const f of fields) {
      const val = (preChat[f.name] ?? '').trim();
      if (f.required && !val) errors[f.name] = strings.requiredField;
      else if (f.type === 'email' && val && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val))
        errors[f.name] = strings.invalidEmail;
    }
    setPreChatErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setShowPreChat(false);
    await ensureConversation({
      visitor_name: preChat.visitor_name,
      visitor_email: preChat.visitor_email,
    });
  };

  // ── Offline "leave a message" submit ─────────────────────────────────────────
  const handleLeaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { email?: string; message?: string } = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(leaveEmail)) errors.email = strings.invalidEmail;
    if (!leaveMessage.trim()) errors.message = strings.requiredField;
    setLeaveErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      const conv = await ensureConversation({ visitor_email: leaveEmail });
      await apiSendMessage(conv.id, conv.token, leaveMessage.trim());
      setLeaveSent(true);
    } catch {
      setLeaveErrors({ message: strings.genericError });
    }
  };

  // ── Render: launcher (closed) ─────────────────────────────────────────────────
  if (!open) {
    // In the embed iframe the launcher sits flush (the iframe itself is small
    // and positioned by the host); standalone it anchors to the configured side.
    const launcherClass = embedded
      ? 'fixed bottom-2 right-2'
      : `fixed bottom-4 ${side === 'left' ? 'left-4' : 'right-4'}`;
    return (
      <button
        onClick={handleOpen}
        aria-label={strings.headerDefaultTitle}
        className={`${launcherClass} group z-[2147483000] w-16 h-16 rounded-full shadow-xl flex items-center justify-center text-white transition-transform duration-200 hover:scale-110 active:scale-95`}
        style={{ backgroundColor: primaryColor }}
      >
        {config?.widget_avatar_url ? (
          <img src={config.widget_avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
        ) : (
          <MessageCircle className="w-7 h-7 transition-transform duration-200 group-hover:rotate-[8deg]" />
        )}
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[22px] h-[22px] px-1 flex items-center justify-center ring-2 ring-white">
            {unread}
          </span>
        )}
      </button>
    );
  }

  // ── Render: panel (open) ──────────────────────────────────────────────────────
  // Embedded: fill the (host-sized) iframe. Standalone: a floating card that is
  // full-screen on phones but a compact panel on ≥sm so it never covers the page.
  const panelClass = embedded
    ? 'fixed inset-0 bg-white flex flex-col overflow-hidden'
    : `fixed z-[2147483000] inset-0 sm:inset-auto sm:bottom-4 ${
        side === 'left' ? 'sm:left-4' : 'sm:right-4'
      } sm:w-[384px] sm:h-[640px] sm:max-h-[calc(100dvh-2rem)] bg-white shadow-2xl sm:rounded-2xl flex flex-col overflow-hidden`;
  return (
    <div className={panelClass}>
      <div className="px-4 py-4 text-white flex items-center justify-between shrink-0" style={{ background: headerGradient(primaryColor) }}>
        <div className="flex items-center gap-3 min-w-0">
          {config?.widget_avatar_url ? (
            <img src={config.widget_avatar_url} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-white/40" />
          ) : (
            <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="font-bold truncate leading-tight">{config?.widget_title || strings.headerDefaultTitle}</h3>
            <div className="flex items-center gap-1.5 text-xs text-white/90 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${agentOnline ? 'bg-green-400 ring-2 ring-green-400/30' : 'bg-white/40'}`} />
              {agentOnline ? strings.onlineStatus : strings.offlineStatus}
            </div>
          </div>
        </div>
        <div className="flex gap-0.5">
          <button onClick={toggleMute} aria-label={muted ? strings.muteOff : strings.muteOn} className="hover:bg-white/20 p-2 rounded-full transition">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <button onClick={() => setMinimized((m) => !m)} aria-label={strings.minimize} className="hover:bg-white/20 p-2 rounded-full transition">
            <Minimize2 className="w-4 h-4" />
          </button>
          <button onClick={handleClose} aria-label={strings.close} className="hover:bg-white/20 p-2 rounded-full transition">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {showPreChat ? (
            <div className="flex-1 overflow-y-auto p-5 bg-gray-50">
              <h4 className="text-base font-semibold text-gray-800 mb-1">{strings.preChatTitle}</h4>
              <p className="text-sm text-gray-600 mb-4">{strings.preChatSubtitle}</p>
              <form onSubmit={handlePreChatSubmit} className="space-y-3">
                {(config?.pre_chat_fields ?? []).map((field: PreChatField) => (
                  <div key={field.name}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {field.label}
                      {field.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    <input
                      type={field.type}
                      value={preChat[field.name] || ''}
                      onChange={(e) => setPreChat((p) => ({ ...p, [field.name]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-2xl text-sm outline-none transition focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                    />
                    {preChatErrors[field.name] && (
                      <p className="text-xs text-red-500 mt-1">{preChatErrors[field.name]}</p>
                    )}
                  </div>
                ))}
                <button type="submit" className="w-full py-3 text-white rounded-2xl font-semibold shadow-md hover:opacity-90 active:scale-[0.98] transition" style={{ backgroundColor: primaryColor }}>
                  {strings.preChatStart}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPreChat(false);
                    void ensureConversation();
                  }}
                  className="w-full py-2.5 text-gray-500 rounded-2xl text-sm font-medium hover:bg-gray-100 transition"
                >
                  {strings.preChatSkip}
                </button>
              </form>
            </div>
          ) : showLeaveMessage ? (
            <div className="flex-1 overflow-y-auto p-5 bg-gray-50">
              {leaveSent ? (
                <div className="text-center text-gray-700 py-10">{strings.leaveMessageThanks}</div>
              ) : (
                <>
                  <h4 className="text-base font-semibold text-gray-800 mb-1">{strings.leaveMessageTitle}</h4>
                  <p className="text-sm text-gray-600 mb-4">{strings.leaveMessageSubtitle}</p>
                  <form onSubmit={handleLeaveSubmit} className="space-y-3">
                    <div>
                      <input
                        type="email"
                        value={leaveEmail}
                        onChange={(e) => setLeaveEmail(e.target.value)}
                        placeholder={strings.emailPlaceholder}
                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-2xl text-sm outline-none transition focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                      />
                      {leaveErrors.email && <p className="text-xs text-red-500 mt-1">{leaveErrors.email}</p>}
                    </div>
                    <div>
                      <textarea
                        value={leaveMessage}
                        onChange={(e) => setLeaveMessage(e.target.value)}
                        placeholder={strings.messagePlaceholder}
                        rows={4}
                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-2xl text-sm outline-none transition focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                      />
                      {leaveErrors.message && <p className="text-xs text-red-500 mt-1">{leaveErrors.message}</p>}
                    </div>
                    <button type="submit" className="w-full py-3 text-white rounded-2xl font-semibold shadow-md hover:opacity-90 active:scale-[0.98] transition" style={{ backgroundColor: primaryColor }}>
                      {strings.leaveMessageSubmit}
                    </button>
                  </form>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
                {messages.length === 0 && (
                  <div className="pt-3 pb-1">
                    <div className="flex flex-col items-center text-center mb-4">
                      {config?.widget_avatar_url ? (
                        <img src={config.widget_avatar_url} alt="" className="w-16 h-16 rounded-full object-cover shadow-md" />
                      ) : (
                        <span
                          className="w-16 h-16 rounded-full flex items-center justify-center text-white shadow-md"
                          style={{ background: headerGradient(primaryColor) }}
                        >
                          <MessageCircle className="w-7 h-7" />
                        </span>
                      )}
                      <p className="mt-3 text-base font-bold text-gray-800">Hi there 👋</p>
                      <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${agentOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                        {agentOnline ? strings.onlineStatus : strings.offlineStatus}
                      </p>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[85%] bg-white shadow-sm rounded-3xl rounded-bl-md px-4 py-3 text-sm text-gray-700">
                        {config?.welcome_message || strings.welcomeFallback}
                      </div>
                    </div>
                  </div>
                )}
                {triggerMessage && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] bg-white shadow-sm rounded-3xl rounded-bl-md px-4 py-3 text-sm text-gray-800">
                      <p className="whitespace-pre-wrap break-words">{triggerMessage}</p>
                    </div>
                  </div>
                )}
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} primaryColor={primaryColor} token={conversation?.token ?? ''} />
                ))}
                {agentTyping && (
                  <div className="flex justify-start">
                    <div className="bg-white shadow-sm rounded-3xl rounded-bl-md px-4 py-3.5">
                      <div className="flex gap-1">
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.15s' }} />
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {attachError && (
                <div className="px-4 py-1.5 text-xs text-red-600 bg-red-50 border-t border-red-100">{attachError}</div>
              )}

              <form onSubmit={handleSend} className="p-3 bg-white border-t border-gray-100 flex items-center gap-2">
                <input ref={fileInputRef} type="file" onChange={handleFile} className="hidden"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" />
                <button type="button" onClick={() => fileInputRef.current?.click()} aria-label={strings.attach}
                  className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition shrink-0" disabled={sending}>
                  <Paperclip className="w-5 h-5" />
                </button>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => handleInputChange(e.target.value)}
                  placeholder={strings.inputPlaceholder}
                  className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-full text-sm outline-none transition focus:bg-white focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                />
                <button type="submit" disabled={!input.trim() || sending} aria-label={strings.send}
                  className="w-11 h-11 shrink-0 flex items-center justify-center text-white rounded-full shadow-md transition active:scale-95 disabled:opacity-40 disabled:shadow-none" style={{ backgroundColor: primaryColor }}>
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MessageBubble({ message, primaryColor, token }: { message: WidgetMessage; primaryColor: string; token: string }) {
  const isVisitor = message.sender_type === 'visitor';
  const attachment = message.metadata?.attachment;
  return (
    <div className={`flex flex-col ${isVisitor ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[82%] px-3.5 py-2.5 text-sm shadow-sm ${
          isVisitor ? 'text-white rounded-3xl rounded-br-md' : 'bg-white text-gray-800 rounded-3xl rounded-bl-md'
        }`}
        style={isVisitor ? { backgroundColor: primaryColor } : undefined}
      >
        {message.sender_type === 'ai' && <div className="text-[11px] text-gray-500 mb-1">🤖 {strings.aiLabel}</div>}
        {message.sender_type === 'agent' && (
          <div className="flex items-center gap-1.5 mb-1">
            {message.metadata?.agent?.avatar_url ? (
              <img
                src={`${apiBase()}${message.metadata.agent.avatar_url}`}
                alt=""
                className="w-4 h-4 rounded-full object-cover"
              />
            ) : (
              <span className="text-[11px]">👤</span>
            )}
            <span className="text-[11px] text-gray-500">{message.metadata?.agent?.name || strings.agentLabel}</span>
          </div>
        )}
        {attachment ? (
          attachment.kind === 'image' ? (
            <a href={attachmentUrl(attachment.url, token)} target="_blank" rel="noreferrer">
              <img src={attachmentUrl(attachment.url, token)} alt={attachment.filename} className="rounded max-h-48 object-cover" />
            </a>
          ) : (
            <a href={attachmentUrl(attachment.url, token)} target="_blank" rel="noreferrer"
              className={`flex items-center gap-2 underline ${isVisitor ? 'text-white' : 'text-blue-600'}`}>
              <FileText className="w-4 h-4 shrink-0" />
              <span className="truncate">{attachment.filename}</span>
            </a>
          )
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
      </div>
      <span className="text-[10px] text-gray-400 mt-1 px-2">{fmtTime(message.created_at)}</span>
    </div>
  );
}
