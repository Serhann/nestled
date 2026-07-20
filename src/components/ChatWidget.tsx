import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, X, Send, Minimize2, Paperclip, Volume2, VolumeX, FileText, Smile, ShoppingBag, Loader2, Check, ChevronRight, Star, Clock, MessageSquareText } from 'lucide-react';
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
  quickAction as apiQuickAction,
  type WidgetConfig,
  type WidgetMessage,
  type PreChatField,
  type QuickIntent,
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

/**
 * The visitor's current order context, fed by the host site (JetFood) so the
 * widget can show order-aware quick actions. Initial values arrive as embed URL
 * params (o_id/o_status/…); live updates arrive via the `jetchat:order` message
 * the embed forwards from `JetChat('order', {...})`.
 */
export interface OrderContext {
  id?: string;
  status?: string;
  eta?: string;
  restaurant?: string;
  url?: string;
  total?: string;
  items?: string; // short line, e.g. "Margherita, garlic bread"
  placed?: string; // human time, e.g. "Yesterday, 8:12 PM"
}

function readOrder(): OrderContext {
  const p = new URLSearchParams(window.location.search);
  const o: OrderContext = {};
  const get = (k: string) => p.get(k) || undefined;
  o.id = get('o_id');
  o.status = get('o_status');
  o.eta = get('o_eta');
  o.restaurant = get('o_rest');
  o.url = get('o_url');
  o.total = get('o_total');
  return o;
}

type OrderPhase = 'in_progress' | 'delivered' | 'other';
function orderPhase(status?: string): OrderPhase {
  const s = (status || '').toLowerCase();
  if (/deliver|complete|arrived|received|done/.test(s)) return 'delivered';
  if (/prepar|cook|way|transit|out for|pick|route|assign|accept|confirm|process|delay|late/.test(s)) return 'in_progress';
  return 'other';
}

/** Human label + tone for the order status badge. */
function orderStatusMeta(order: OrderContext): { label: string; tone: 'in' | 'done' | 'other' } {
  const phase = orderPhase(order.status);
  const label = order.status || (phase === 'delivered' ? 'Delivered' : phase === 'in_progress' ? 'On the way' : 'Order');
  return { label, tone: phase === 'delivered' ? 'done' : phase === 'in_progress' ? 'in' : 'other' };
}

/**
 * Order-aware quick actions. Informational intents ('where', 'status') are
 * answered automatically by the server; problem intents escalate to a human.
 * Empty when there is no order in context.
 */
function orderQuickActions(order: OrderContext): { label: string; intent: QuickIntent }[] {
  if (!order.id) return [];
  switch (orderPhase(order.status)) {
    case 'in_progress':
      return [
        { label: "Where's my order?", intent: 'where' },
        { label: 'Running late?', intent: 'late' },
        { label: 'Change address', intent: 'change_address' },
      ];
    case 'delivered':
      return [
        { label: 'Missing item', intent: 'missing_item' },
        { label: 'Something was wrong', intent: 'wrong' },
        { label: 'Request a refund', intent: 'refund' },
      ];
    default:
      return [
        { label: 'Order status', intent: 'status' },
        { label: 'Talk to an agent', intent: 'human' },
      ];
  }
}

/** The four delivery stages shown in the order progress tracker. */
const ORDER_STEPS = ['Placed', 'Preparing', 'On the way', 'Delivered'] as const;

/**
 * Map a free-form order status to a 0-3 progress step so the widget can draw the
 * delivery tracker (design 2a/2c). Unknown/other statuses default to step 0.
 */
function orderStep(status?: string): number {
  const s = (status || '').toLowerCase();
  if (/deliver|complete|arrived|received at|dropped|done/.test(s)) return 3;
  if (/way|transit|out for|pick|route|en route|dispatch|rider|driver|courier|delay|late/.test(s)) return 2;
  if (/prepar|cook|accept|confirm|process|kitchen|making/.test(s)) return 1;
  return 0;
}

/** Quick tags offered on the rate-your-delivery screen (design 2d). */
const RATING_TAGS = ['Support was quick', 'Fair refund', 'On-time rider', 'Food quality', 'Packaging'] as const;

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
  const [order, setOrder] = useState<OrderContext>(readOrder);
  // The visitor's recent orders, fed by the host via JetChat('orders', [...]).
  // Drives the order picker (design 2b) when there's more than one.
  const [orders, setOrders] = useState<OrderContext[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  // "Waiting for an agent" hold: after an escalation the visitor can't type
  // until an agent takes the chat (joins/assigns, or sends the first reply).
  const [waiting, setWaiting] = useState(false);
  // Rate-your-delivery end state (design 2d). Null = not rating.
  const [rating, setRating] = useState<{ stars: number; tags: string[]; comment: string; sent: boolean } | null>(null);

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
  const orderRef = useRef(order);
  orderRef.current = order;

  const primaryColor = config?.primary_color || '#c67139';
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
        // A real agent replied → they've taken the chat; release the hold.
        if (m.sender_type === 'agent') setWaiting(false);
      },
      onTyping: (t) => setAgentTyping(t),
      onAgentStatus: (o) => setAgentOnline(o),
      onAgentJoined: () => setWaiting(false),
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
        if (data.traits.order && typeof data.traits.order === 'object') {
          setOrder((prev) => ({ ...prev, ...data.traits.order }));
        }
      } else if (data && data.type === 'jetchat:order' && data.order && typeof data.order === 'object') {
        // Live order update from the host site (status changed, delivered, …).
        setOrder((prev) => ({ ...prev, ...data.order }));
      } else if (data && data.type === 'jetchat:orders' && Array.isArray(data.orders)) {
        // Full list of the visitor's recent orders (for the picker).
        const list = (data.orders as OrderContext[]).filter((o) => o && o.id);
        setOrders(list);
        // Adopt the active (in-progress) order as the current context if none set.
        setOrder((prev) => {
          if (prev.id) return prev;
          const active = list.find((o) => orderPhase(o.status) === 'in_progress') || list[0];
          return active ? { ...prev, ...active } : prev;
        });
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
    // The visitor's current order, so agents see the context in the profile.
    ...(orderRef.current.id ? { order: orderRef.current } : {}),
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

  // Run an order quick action. Informational intents get an instant automated
  // reply; problem intents escalate to a human — the server decides and returns
  // both the visitor request and the bot reply.
  const handleQuickAction = async (intent: QuickIntent) => {
    if (sending) return;
    setShowPreChat(false);
    setSending(true);
    try {
      const conv = await ensureConversation();
      const { messages: msgs, needs_human } = await apiQuickAction(conv.id, conv.token, intent, orderRef.current);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...msgs.filter((m) => m && !seen.has(m.id))];
      });
      // Escalated to an agent → hold the composer until an agent takes the chat.
      if (needs_human) setWaiting(true);
    } catch {
      setAttachError(strings.genericError);
    } finally {
      setSending(false);
    }
  };

  // Start a plain chat from the intent home ("Something else — just chat").
  const startPlainChat = async () => {
    setShowPreChat(false);
    await ensureConversation().catch(() => undefined);
  };

  // Submit the delivery rating (design 2d). Sent as a normal visitor message so
  // it lands in the agent inbox with no backend schema change.
  const submitRating = async () => {
    if (!rating || rating.stars === 0) return;
    const stars = '★'.repeat(rating.stars) + '☆'.repeat(5 - rating.stars);
    const parts = [
      `${stars} (${rating.stars}/5)${order.id ? ` — order #${order.id}` : ''}`,
      rating.tags.length ? `What stood out: ${rating.tags.join(', ')}.` : '',
      rating.comment.trim(),
    ].filter(Boolean);
    setSending(true);
    try {
      const conv = await ensureConversation();
      const { message } = await apiSendMessage(conv.id, conv.token, parts.join('\n'));
      setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
      setRating((r) => (r ? { ...r, sent: true } : r));
    } catch {
      setAttachError(strings.genericError);
    } finally {
      setSending(false);
    }
  };

  const quickActions = orderQuickActions(order);
  // Offer the rating flow once an order looks delivered.
  const canRate = order.id != null && orderPhase(order.status) === 'delivered';

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
      <div className="px-4 py-4 text-white flex items-center justify-between shrink-0" style={{ backgroundColor: primaryColor }}>
        <div className="flex items-center gap-3 min-w-0">
          {config?.widget_avatar_url ? (
            <img src={config.widget_avatar_url} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-white/40" />
          ) : (
            <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="font-display text-lg truncate leading-tight">{config?.widget_title || strings.headerDefaultTitle}</h3>
            <div className="flex items-center gap-1.5 text-xs text-white/90 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${agentOnline ? 'bg-green-300 ring-2 ring-green-300/30' : 'bg-white/40'}`} />
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
          {rating ? (
            <div className="flex-1 overflow-y-auto bg-cream flex flex-col">
              {rating.sent ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
                  <span className="w-16 h-16 rounded-full flex items-center justify-center text-white shadow-md" style={{ backgroundColor: '#7a8a5e' }}>
                    <Check className="w-8 h-8" />
                  </span>
                  <p className="font-display text-2xl text-gray-800">Thank you!</p>
                  <p className="text-sm text-gray-600">Your feedback helps us make every delivery better.</p>
                  <button onClick={() => setRating(null)} className="mt-2 text-sm font-semibold" style={{ color: primaryColor }}>
                    Back to chat
                  </button>
                </div>
              ) : (
                <>
                  <div className="px-6 pt-6 pb-5 text-white" style={{ backgroundColor: '#6f7f54' }}>
                    <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center mb-3">
                      <Check className="w-6 h-6" />
                    </span>
                    <h4 className="font-display text-2xl">All sorted!</h4>
                    <p className="text-sm text-white/90 mt-1">One last thing — how was your delivery?</p>
                  </div>
                  <div className="flex-1 p-5 space-y-5">
                    {order.id && (
                      <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
                        <div className="text-sm font-semibold text-gray-800">
                          {order.restaurant ? `${order.restaurant} · ` : ''}#{order.id}
                        </div>
                        <div className="text-xs text-gray-500">Delivered{order.total ? ` · ${order.total}` : ''}</div>
                      </div>
                    )}
                    {/* Star rating */}
                    <div className="flex justify-center gap-2">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} onClick={() => setRating((r) => (r ? { ...r, stars: n } : r))} aria-label={`${n} stars`} className="active:scale-90 transition">
                          <Star className="w-9 h-9" style={{ fill: n <= rating.stars ? primaryColor : 'transparent', color: n <= rating.stars ? primaryColor : '#c9c1b3' }} />
                        </button>
                      ))}
                    </div>
                    {/* Tags */}
                    <div>
                      <p className="text-[11px] font-bold tracking-wider text-gray-500 mb-2">WHAT STOOD OUT?</p>
                      <div className="flex flex-wrap gap-2">
                        {RATING_TAGS.map((tag) => {
                          const on = rating.tags.includes(tag);
                          return (
                            <button
                              key={tag}
                              onClick={() =>
                                setRating((r) => (r ? { ...r, tags: on ? r.tags.filter((t) => t !== tag) : [...r.tags, tag] } : r))
                              }
                              className="rounded-full border-[1.5px] px-3 py-1.5 text-xs font-semibold transition active:scale-95"
                              style={on ? { borderColor: '#7a8a5e', background: '#e1eecc', color: '#3d472b' } : { borderColor: '#d8d0c2', color: '#645c50' }}
                            >
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <textarea
                      value={rating.comment}
                      onChange={(e) => setRating((r) => (r ? { ...r, comment: e.target.value } : r))}
                      placeholder="Anything else we should know? (optional)"
                      rows={3}
                      className="w-full px-4 py-3 bg-white border border-gray-200 rounded-2xl text-sm outline-none transition focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                    />
                  </div>
                  <div className="p-4 space-y-2">
                    <button
                      onClick={submitRating}
                      disabled={rating.stars === 0 || sending}
                      className="w-full py-3 text-white rounded-full font-semibold shadow-md hover:opacity-90 active:scale-[0.98] transition disabled:opacity-40"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Send rating
                    </button>
                    <button onClick={() => setRating(null)} className="w-full py-2 text-gray-500 rounded-full text-sm font-medium hover:bg-gray-100 transition">
                      Skip for now
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : showPicker ? (
            <div className="flex-1 overflow-y-auto bg-cream flex flex-col">
              <div className="px-5 pt-5 pb-4">
                <h4 className="font-display text-xl text-gray-800">Which order?</h4>
                <p className="text-sm text-gray-600 mt-0.5">We'll pull up the details for you.</p>
              </div>
              <div className="flex-1 px-4 pb-4 space-y-2.5">
                {orders.map((o) => {
                  const { label, tone } = orderStatusMeta(o);
                  const active = orderPhase(o.status) === 'in_progress';
                  const badge =
                    tone === 'done'
                      ? { bg: '#e1eecc', fg: '#3d472b' }
                      : tone === 'in'
                        ? { bg: `color-mix(in srgb, ${primaryColor} 16%, #fff)`, fg: primaryColor }
                        : { bg: '#eee7db', fg: '#645c50' };
                  return (
                    <button
                      key={o.id}
                      onClick={() => {
                        setOrder(o);
                        setShowPicker(false);
                      }}
                      className="w-full text-left rounded-2xl bg-white px-4 py-3 transition hover:border-gray-300 active:scale-[0.99]"
                      style={{ border: active ? '2px solid #7a8a5e' : '1.5px solid #e5ded0' }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-800 flex-1 truncate">{o.restaurant || `Order #${o.id}`}</span>
                        <span className="text-[9px] font-bold rounded-full px-2 py-0.5 shrink-0" style={{ background: badge.bg, color: badge.fg }}>
                          {label.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1 truncate">
                        #{o.id}
                        {o.items ? ` · ${o.items}` : ''}
                        {o.total ? ` · ${o.total}` : ''}
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: active ? '#6f7f54' : '#9c9484' }}>
                        {active ? `Arriving in ~${o.eta || 'soon'}` : o.placed || 'Delivered'}
                      </div>
                    </button>
                  );
                })}
                <button
                  onClick={() => {
                    setShowPicker(false);
                    void startPlainChat();
                  }}
                  className="w-full flex items-center gap-2.5 rounded-2xl px-4 py-3 mt-1"
                  style={{ background: `color-mix(in srgb, ${primaryColor} 8%, #fff)`, border: `1px solid color-mix(in srgb, ${primaryColor} 22%, #fff)` }}
                >
                  <span className="text-xs text-left" style={{ color: primaryColor }}>
                    Can't find it? Just describe the order and we'll look it up.
                  </span>
                </button>
              </div>
            </div>
          ) : showPreChat ? (
            <div className="flex-1 overflow-y-auto p-5 bg-cream">
              <h4 className="font-display text-xl text-gray-800 mb-1">{strings.preChatTitle}</h4>
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
            <div className="flex-1 overflow-y-auto p-5 bg-cream">
              {leaveSent ? (
                <div className="text-center text-gray-700 py-10">{strings.leaveMessageThanks}</div>
              ) : (
                <>
                  <h4 className="font-display text-xl text-gray-800 mb-1">{strings.leaveMessageTitle}</h4>
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
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-cream">
                {/* Order context card with delivery progress (fed by the host site). */}
                {order.id && <OrderCard order={order} primaryColor={primaryColor} />}

                {/* Order-aware intent home (design 2a): the visitor picks what they
                    need before a conversation exists. */}
                {messages.length === 0 && order.id && (
                  <div className="pt-1">
                    <p className="text-[11px] font-bold tracking-wider text-gray-500 mb-2 px-1">WHAT DO YOU NEED?</p>
                    <div className="flex flex-col gap-2">
                      {quickActions.map((a) => (
                        <button
                          key={a.label}
                          onClick={() => handleQuickAction(a.intent)}
                          disabled={sending}
                          className="flex items-center gap-3 bg-white border-[1.5px] border-gray-200 rounded-full px-4 py-3 text-left transition hover:border-gray-300 active:scale-[0.99] disabled:opacity-50"
                        >
                          <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
                            <Clock className="w-4 h-4" style={{ color: primaryColor }} />
                          </span>
                          <span className="flex-1 text-sm font-semibold text-gray-800">{a.label}</span>
                          <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                        </button>
                      ))}
                      {orders.length > 1 && (
                        <button
                          onClick={() => setShowPicker(true)}
                          className="flex items-center gap-3 bg-white border-[1.5px] border-gray-200 rounded-full px-4 py-3 text-left transition hover:border-gray-300 active:scale-[0.99]"
                        >
                          <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
                            <ShoppingBag className="w-4 h-4" style={{ color: primaryColor }} />
                          </span>
                          <span className="flex-1 text-sm font-semibold text-gray-800">A different order</span>
                          <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                        </button>
                      )}
                      {canRate && (
                        <button
                          onClick={() => setRating({ stars: 0, tags: [], comment: '', sent: false })}
                          className="flex items-center gap-3 bg-white border-[1.5px] border-gray-200 rounded-full px-4 py-3 text-left transition hover:border-gray-300 active:scale-[0.99]"
                        >
                          <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'color-mix(in srgb, #7a8a5e 16%, #fff)' }}>
                            <Star className="w-4 h-4" style={{ color: '#6f7f54' }} />
                          </span>
                          <span className="flex-1 text-sm font-semibold text-gray-800">Rate your delivery</span>
                          <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                        </button>
                      )}
                      <button
                        onClick={startPlainChat}
                        disabled={sending}
                        className="flex items-center gap-3 bg-white border-[1.5px] border-gray-200 rounded-full px-4 py-3 text-left transition hover:border-gray-300 active:scale-[0.99] disabled:opacity-50"
                      >
                        <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
                          <MessageSquareText className="w-4 h-4" style={{ color: primaryColor }} />
                        </span>
                        <span className="flex-1 text-sm font-semibold text-gray-800">Something else — just chat</span>
                        <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                      </button>
                    </div>
                  </div>
                )}

                {messages.length === 0 && !order.id && (
                  <div className="pt-1 pb-1">
                    <div className="flex flex-col items-center text-center mb-4">
                      {config?.widget_avatar_url ? (
                        <img src={config.widget_avatar_url} alt="" className="w-16 h-16 rounded-full object-cover shadow-md" />
                      ) : (
                        <span
                          className="w-16 h-16 rounded-full flex items-center justify-center text-white shadow-md"
                          style={{ backgroundColor: primaryColor }}
                        >
                          <MessageCircle className="w-7 h-7" />
                        </span>
                      )}
                      <p className="mt-3 font-display text-2xl text-gray-800">Hi there!</p>
                      <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${agentOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                        {agentOnline ? strings.onlineStatus : strings.offlineStatus}
                      </p>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[85%] bg-white border border-gray-200 rounded-[18px] rounded-bl-[6px] px-4 py-3 text-sm text-gray-700">
                        {config?.welcome_message || strings.welcomeFallback}
                      </div>
                    </div>
                  </div>
                )}

                {messages.length > 0 && (
                  <div className="flex justify-center">
                    <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 rounded-full px-3 py-1">Today</span>
                  </div>
                )}

                {triggerMessage && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] bg-white border border-gray-200 rounded-[18px] rounded-bl-[6px] px-4 py-3 text-sm text-gray-800">
                      <p className="whitespace-pre-wrap break-words">{triggerMessage}</p>
                    </div>
                  </div>
                )}
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} primaryColor={primaryColor} token={conversation?.token ?? ''} />
                ))}
                {agentTyping && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-gray-200 rounded-[18px] rounded-bl-[6px] px-4 py-3.5">
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

              {waiting ? (
                /* Waiting-for-an-agent hold: the composer is locked until an
                   agent takes the chat (joins / assigns / sends the first reply). */
                <div className="p-3.5 bg-white border-t border-gray-100 flex items-center gap-3">
                  <Loader2 className="w-5 h-5 animate-spin shrink-0" style={{ color: primaryColor }} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800">Connecting you with an agent…</p>
                    <p className="text-xs text-gray-500">
                      {agentOnline ? "You'll be able to reply as soon as an agent joins." : "We'll be with you shortly."}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Order-aware quick actions (fed by the host). Right-aligned pill
                      chips, matching the design's suggested-reply row. */}
                  {(quickActions.length > 0 || canRate) && messages.length > 0 && (
                    <div className="flex gap-2 px-3 pt-2 pb-1 bg-white overflow-x-auto justify-end [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {canRate && (
                        <button
                          onClick={() => setRating({ stars: 0, tags: [], comment: '', sent: false })}
                          disabled={sending}
                          className="shrink-0 rounded-full border-[1.5px] px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          style={{ borderColor: '#7a8a5e', color: '#3d472b', background: '#eef3e2' }}
                        >
                          <Star className="w-3 h-3" style={{ color: '#6f7f54' }} /> Rate delivery
                        </button>
                      )}
                      {quickActions.map((a) => (
                        <button
                          key={a.label}
                          onClick={() => handleQuickAction(a.intent)}
                          disabled={sending}
                          className="shrink-0 rounded-full border-[1.5px] px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition active:scale-95 disabled:opacity-50"
                          style={{
                            borderColor: primaryColor,
                            color: primaryColor,
                            background: `color-mix(in srgb, ${primaryColor} 9%, #fff)`,
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <form onSubmit={handleSend} className="p-3 bg-white border-t border-gray-100 flex items-center gap-1.5">
                    <input ref={fileInputRef} type="file" onChange={handleFile} className="hidden"
                      accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" />
                    <button type="button" onClick={() => setInput((v) => `${v}🙂`)} aria-label="Add emoji"
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition shrink-0" disabled={sending}>
                      <Smile className="w-5 h-5" />
                    </button>
                    <button type="button" onClick={() => fileInputRef.current?.click()} aria-label={strings.attach}
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition shrink-0" disabled={sending}>
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
              <div className="text-center text-[10px] font-semibold tracking-wide text-gray-500 pb-2 -mt-1 bg-white">
                Powered by JetChat
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MessageBubble({ message, primaryColor, token }: { message: WidgetMessage; primaryColor: string; token: string }) {
  const isVisitor = message.sender_type === 'visitor';
  const isAI = message.sender_type === 'ai';
  const attachment = message.metadata?.attachment;
  const time = fmtTime(message.created_at);
  const senderName = message.metadata?.agent?.name || (isAI ? strings.aiLabel : strings.agentLabel);
  const avatarUrl = message.metadata?.agent?.avatar_url;

  // The bubble / attachment content, styled per sender.
  let content: React.ReactNode;
  if (attachment?.kind === 'image') {
    content = (
      <a href={attachmentUrl(attachment.url, token)} target="_blank" rel="noreferrer"
        className="block rounded-[18px] overflow-hidden border border-gray-200 max-w-[220px]">
        <img src={attachmentUrl(attachment.url, token)} alt={attachment.filename} className="max-h-52 object-cover" />
      </a>
    );
  } else if (attachment) {
    content = (
      <a href={attachmentUrl(attachment.url, token)} target="_blank" rel="noreferrer"
        className="flex items-center gap-2.5 rounded-[16px] bg-white border-[1.5px] border-dashed px-3 py-2"
        style={{ borderColor: `color-mix(in srgb, ${primaryColor} 45%, transparent)` }}>
        <span className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
          <FileText className="w-4 h-4" style={{ color: primaryColor }} />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-gray-800 truncate">{attachment.filename}</span>
          <span className="block text-[10px] text-gray-500">{(attachment.size / 1024 / 1024).toFixed(1)} MB</span>
        </span>
      </a>
    );
  } else if (isVisitor) {
    content = (
      <div className="px-3.5 py-2.5 text-sm text-white rounded-[18px] rounded-br-[6px] shadow-sm" style={{ backgroundColor: primaryColor }}>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    );
  } else {
    content = (
      <div className="px-3.5 py-2.5 text-sm bg-white text-gray-800 rounded-[18px] rounded-bl-[6px] border border-gray-200">
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    );
  }

  if (isVisitor) {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[82%]">{content}</div>
        <span className="text-[10px] text-gray-400 mt-1 px-2">{time}</span>
      </div>
    );
  }
  // agent / ai — avatar to the left, name · time below (matches the design).
  return (
    <div className="flex gap-2 items-end max-w-[88%]">
      {avatarUrl ? (
        <img src={`${apiBase()}${avatarUrl}`} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
      ) : (
        <span
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
          style={{ background: `color-mix(in srgb, ${primaryColor} 22%, #fff)`, color: primaryColor }}
        >
          {isAI ? '🤖' : senderName.charAt(0).toUpperCase() || 'A'}
        </span>
      )}
      <div className="min-w-0">
        {content}
        <span className="block text-[10px] text-gray-500 mt-1 px-1.5">
          {senderName} · {time}
        </span>
      </div>
    </div>
  );
}

/**
 * Order context card with a live delivery progress tracker (design 2a/2c). Fed
 * by the host site via `JetChat('order', {...})`. The stepper is shown for
 * in-progress / delivered orders; an unknown status falls back to a plain badge.
 */
function OrderCard({ order, primaryColor }: { order: OrderContext; primaryColor: string }) {
  const { label, tone } = orderStatusMeta(order);
  const phase = orderPhase(order.status);
  const olive = '#7a8a5e';
  const showStepper = phase === 'in_progress' || phase === 'delivered';
  const current = orderStep(order.status);
  const badge =
    tone === 'done'
      ? { bg: '#e1eecc', fg: '#3d472b' } // olive
      : tone === 'in'
        ? { bg: `color-mix(in srgb, ${primaryColor} 16%, #fff)`, fg: primaryColor }
        : { bg: '#eee7db', fg: '#645c50' };
  const sub = [order.restaurant, order.total].filter(Boolean).join(' · ');
  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
          <ShoppingBag className="w-5 h-5" style={{ color: primaryColor }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-800 truncate">Order #{order.id}</div>
          <div className="text-xs text-gray-500 truncate">{sub || 'Your JetFood order'}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] font-bold rounded-full px-2.5 py-1 whitespace-nowrap" style={{ background: badge.bg, color: badge.fg }}>
            {label}
          </span>
          {phase === 'in_progress' && order.eta && (
            <span className="text-[10px] font-bold" style={{ color: olive }}>~{order.eta}</span>
          )}
        </div>
      </div>

      {showStepper && (
        <div className="mt-3">
          <div className="flex items-center">
            {ORDER_STEPS.map((_, i) => {
              const done = i < current;
              const isCurrent = i === current;
              const dotColor = done || isCurrent ? olive : '#d8d0c2';
              return (
                <div key={i} className="flex items-center" style={{ flex: i === ORDER_STEPS.length - 1 ? '0 0 auto' : '1 1 0%' }}>
                  <span
                    className="w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0"
                    style={{
                      background: isCurrent ? '#fff' : dotColor,
                      border: isCurrent ? `3px solid ${olive}` : 'none',
                      boxSizing: 'border-box',
                    }}
                  >
                    {done && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                  </span>
                  {i < ORDER_STEPS.length - 1 && (
                    <span className="h-1 flex-1 rounded-full" style={{ background: i < current ? olive : '#e4ddce' }} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1.5">
            {ORDER_STEPS.map((s, i) => (
              <span key={s} className="text-[9px] font-semibold" style={{ color: i === current ? '#3d472b' : '#9c9484' }}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
