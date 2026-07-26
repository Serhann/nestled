import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircle, X, Send, Minimize2, Paperclip, Volume2, VolumeX, FileText, Smile, Loader2, Check, ChevronRight, Star, MessageSquareText, Headphones } from 'lucide-react';
import {
  apiBase,
  attachmentUrl,
  createConversation,
  updateConversationContext,
  rateConversation,
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
  websiteKey,
  type WidgetConfig,
  type WidgetMessage,
  type PreChatField,
} from '../lib/api';
import { strings } from '../lib/strings';
import { getFingerprint } from '../lib/fingerprint';
import { playChime } from '../lib/sound';
import { Markdown } from '../lib/markdown';
import { TriggerEngine } from '../utils/triggerEngine';
import type { Trigger } from '../types/chat';

function hostUrl(): string {
  return new URLSearchParams(window.location.search).get('href') || document.referrer || window.location.href;
}

/**
 * True when the widget runs inside the embed iframe (the normal case): the host
 * page sizes the iframe via the `nestled:resize` messages, so the panel should
 * fill it (inset-0). When rendered standalone (the /widget page opened directly)
 * it must instead be a constrained floating card so it doesn't cover the page.
 */
function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent access throws → we are embedded
  }
}

/** Visitor identity from embed params (ue/un/up/uid) or direct URL params. */
function readIdentity(): Record<string, string> {
  const p = new URLSearchParams(window.location.search);
  const id: Record<string, string> = {};
  const map: Array<[string, string, string]> = [
    ['ue', 'user_email', 'email'],
    ['un', 'user_name', 'name'],
    ['up', 'user_phone', 'phone'],
    ['uid', 'user_id', 'user_id'],
  ];
  for (const [short, long, key] of map) {
    const v = p.get(short) || p.get(long);
    if (v) id[key] = v;
  }
  return id;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CONV_KEY = 'nestled_conv';
const MUTE_KEY = 'nestled_muted';

interface StoredConversation {
  id: string;
  token: string;
}

function getVisitorId(): string {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('vid');
  if (fromParam) return fromParam;
  // Standalone (/widget opened directly): namespace by website key so the same
  // origin can preview several websites without sharing one identity.
  const key = `nestled_vid_${params.get('site') || 'default'}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
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
 * A conversation starter: a labelled chip the visitor can tap instead of typing.
 *
 * This replaces the old order-intent packs. Starters are pure configuration —
 * the widget knows a label, an optional icon name and an optional intake form,
 * and nothing about what the customer's business does. Phase 9 builds the
 * management UI; Phase 10 makes them server-driven via the boot payload.
 */
export interface Starter {
  label: string;
  /** Stable id, posted with the visitor's message so reporting can group them. */
  id: string;
  kind?: 'auto' | 'human';
  fields?: { name: string; label: string; required: boolean }[];
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
  // Unsigned session attributes the host set via Nestled('data', {...}). Display
  // and agent-context only — never trusted. The HMAC-verified equivalent travels
  // in `contextToken` and is validated server-side.
  const [sessionData, setSessionData] = useState<Record<string, string>>({});
  // "Waiting for an agent" hold: after an escalation the visitor can't type
  // until an agent takes the chat (joins/assigns, or sends the first reply).
  const [waiting, setWaiting] = useState(false);
  // Once the chat has reached an agent (via an escalating starter or an agent
  // joining/replying), stop offering the starter chips — the visitor is now
  // talking to a person.
  const [escalated, setEscalated] = useState(false);
  // Post-chat review state. Null = not reviewing.
  const [rating, setRating] = useState<{ stars: number; tags: string[]; comment: string; sent: boolean } | null>(null);
  // When true, finishing (or skipping) the review closes the chat & resets it;
  // when false it just returns to the conversation (the old mid-chat rating).
  const [closeAfterReview, setCloseAfterReview] = useState(false);
  // The X-button "close this chat?" confirmation.
  const [confirmClose, setConfirmClose] = useState(false);
  // Starter intake: collect a starter's fields before running it.
  const [intake, setIntake] = useState<{ starter: Starter; values: Record<string, string> } | null>(null);

  // The visitor picked "Something else — just chat" on the intent home: swap the
  // action list for the welcome message + composer, even with no messages yet.
  const [plainChat, setPlainChat] = useState(false);

  // Pre-chat + offline-message forms.
  const [showPreChat, setShowPreChat] = useState(false);
  const [preChat, setPreChat] = useState<Record<string, string>>({});
  const [preChatErrors, setPreChatErrors] = useState<Record<string, string>>({});
  const [leaveEmail, setLeaveEmail] = useState('');
  const [leaveMessage, setLeaveMessage] = useState('');
  const [leaveErrors, setLeaveErrors] = useState<{ email?: string; message?: string }>({});
  const [leaveSent, setLeaveSent] = useState(false);

  const visitorId = useRef(getVisitorId());
  const fingerprint = useRef(getFingerprint());
  // Signed host context (JWT). The embed passes it as `ctx`; the host may refresh
  // it at runtime via nestled:context. Verified server-side on conversation create.
  const contextToken = useRef(new URLSearchParams(window.location.search).get('ctx') || '');
  const identity = useRef<Record<string, string>>(readIdentity());
  const preChatRef = useRef<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const engineRef = useRef<TriggerEngine | null>(null);
  const triggersRan = useRef(false);
  const sessionDataRef = useRef(sessionData);
  sessionDataRef.current = sessionData;
  const convRef = useRef(conversation);
  convRef.current = conversation;

  const primaryColor = config?.primary_color || '#4f46e5';
  const embedded = isEmbedded();
  const side = config?.widget_position === 'left' ? 'left' : 'right';
  // The website this widget belongs to — an unguessable public key from the embed.
  const site = useRef<string | null>(websiteKey()).current;

  // ── Load config + agent status ──────────────────────────────────────────────
  useEffect(() => {
    getWidgetConfig()
      .then((r) => setConfig(r.settings))
      .catch(() => undefined);
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

  // Wipe the current conversation and return to a fresh chat. Used when the agent
  // resolves the chat: the thread is cleared and the next message starts anew.
  const resetToFreshChat = useCallback(() => {
    try {
      localStorage.removeItem(CONV_KEY);
    } catch {
      /* ignore */
    }
    setConversation(null);
    setMessages([]);
    setEscalated(false);
    setWaiting(false);
    setIntake(null);
    setRating(null);
    setCloseAfterReview(false);
    setConfirmClose(false);
    setShowPreChat(false);
    setAgentTyping(false);
    setUnread(0);
    setPlainChat(false); // next visit starts back on the starter home
  }, []);

  // Open the post-chat review screen. `fromClose` = finishing it should close +
  // reset the chat (vs. the old mid-chat rating that returns to the thread).
  const startReview = useCallback((fromClose: boolean) => {
    setConfirmClose(false);
    setCloseAfterReview(fromClose);
    setMinimized(false);
    setOpen(true);
    setRating({ stars: 0, tags: [], comment: '', sent: false });
  }, []);

  // ── Load history + open realtime when a conversation exists ──────────────────
  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    getMessages(conversation.id, conversation.token)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        // If an agent has already spoken in this conversation, keep the quick
        // actions hidden across reloads.
        if (r.messages.some((m) => m.sender_type === 'agent')) setEscalated(true);
      })
      .catch(() => undefined);

    const ws = openConversationWS(conversation.id, conversation.token, {
      onMessage: (m) => {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        if (m.sender_type !== 'visitor') {
          if (!openRef.current) setUnread((u) => u + 1);
          playBlip();
        }
        // A real agent replied → they've taken the chat; release the hold and
        // stop offering quick actions.
        if (m.sender_type === 'agent') {
          setWaiting(false);
          setEscalated(true);
        }
      },
      onTyping: (t) => setAgentTyping(t),
      onAgentStatus: (o) => setAgentOnline(o),
      onAgentJoined: () => {
        setWaiting(false);
        setEscalated(true);
      },
      // The agent resolved the chat. If the visitor is looking, show the review
      // screen (finishing it clears + resets the chat); if the widget is closed,
      // just reset silently so we don't pop an unprompted screen at them.
      onResolved: () => {
        if (openRef.current) startReview(true);
        else resetToFreshChat();
      },
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
        ? { width: 96, height: 96 } // room around the launcher so its shadow isn't clipped
        : state === 'minimized'
          ? { width: 384, height: 68 }
          : { width: 384, height: 640 };
    window.parent.postMessage({ type: 'nestled:resize', state, ...size }, '*');
  }, [open, minimized]);

  // ── Standalone presence ──────────────────────────────────────────────────────
  // When the widget runs on its own (sandbox / opened directly, not inside the
  // embed iframe), open a presence connection so this visitor shows up on the
  // Live Visitors board. In the real embed the host page's presence.js does this
  // (and reports the true host URL), so we skip it there to avoid double-tracking.
  useEffect(() => {
    if (embedded) return;
    const p = openPresenceWS(visitorId.current, {
      fingerprint: fingerprint.current,
      contextToken: contextToken.current,
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

  // ── Host bridge: messages the embed forwards from the host page ──────────────
  //
  // The widget deliberately does NOT decode the signed context token any more.
  // Reading a JWT payload in the client to render data was both a layering
  // mistake (the client learning the customer's domain model) and misleading
  // (unverified in the browser, verified only on the server). Phase 10 replaces it
  // with a server-rendered ContextCard the widget draws without interpreting.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'nestled:proactive' && data.conversation_id && data.visitor_token) {
        setConversation({ id: data.conversation_id, token: data.visitor_token });
        setShowPreChat(false);
        setOpen(true);
        setMinimized(false);
        setUnread(0);
      } else if (data && data.type === 'nestled:identify' && data.traits) {
        // Late identity (e.g. after the visitor logs in on the host site).
        Object.assign(identity.current, data.traits);
      } else if (data && data.type === 'nestled:data' && data.attributes) {
        // Arbitrary unsigned session attributes — Nestled('data', {...}).
        const incoming = data.attributes as Record<string, unknown>;
        setSessionData((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(incoming)) {
            if (v == null) delete next[k];
            else next[k] = String(v);
          }
          return next;
        });
      } else if (data && data.type === 'nestled:context' && typeof data.token === 'string') {
        // Refreshed signed context token (e.g. issued after the visitor logs in).
        contextToken.current = data.token;
        // If a conversation is live, push the fresh token so the agent panel's
        // verified-attributes card updates in real time too.
        const conv = convRef.current;
        if (conv) void updateConversationContext(conv.id, conv.token, data.token);
      } else if (data && data.type === 'nestled:open') {
        setOpen(true);
        setMinimized(false);
        setUnread(0);
      } else if (data && data.type === 'nestled:close') {
        setOpen(false);
      } else if (data && data.type === 'nestled:toggle') {
        setOpen((o) => !o);
        setMinimized(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Ding on an incoming agent/AI reply (respects the mute toggle). Plays even
  // when the widget is open so the visitor always hears a reply land.
  const playBlip = useCallback(() => {
    if (muted) return;
    playChime();
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
    if (t.actions.play_sound && !muted) playChime();
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
    // Which website this chat came from (the embed's public key).
    widget_site: site,
    // Attribute the conversation to the trigger that produced it (analytics).
    ...(activeTriggerId ? { trigger_id: activeTriggerId } : {}),
    // Unsigned host-supplied session attributes, for the agent's visitor card.
    ...(Object.keys(sessionDataRef.current).length ? { attributes: sessionDataRef.current } : {}),
    // Pre-chat answers (site-configured lead capture), shown in the agent profile.
    ...(Object.keys(preChatRef.current).length ? { prechat: preChatRef.current, ...preChatRef.current } : {}),
    // Known visitor identity (user_id and any custom traits).
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
        fingerprint: fingerprint.current,
        context_token: contextToken.current || undefined,
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
    // If there's a live chat, ask before closing (→ review) instead of just
    // dismissing. With nothing going on, X closes straight to the launcher.
    if (conversation) {
      setConfirmClose(true);
    } else {
      setOpen(false);
      setShowPreChat(false);
    }
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

  /**
   * Run a conversation starter: post its message on the visitor's behalf, plus any
   * collected intake values, as a normal visitor message. From there the ordinary
   * pipeline takes over (AI answers, or hands off to a human).
   *
   * This deliberately no longer calls a bespoke server endpoint. The old
   * `/quick-action` route rendered order templates server-side and could flag
   * `needs_human` itself; Phase 11's bot flows own that escalation path, via a
   * `handoff` node, for every channel rather than just this one.
   */
  const runStarter = async (starter: Starter, fields?: Record<string, string>) => {
    if (sending) return;
    setShowPreChat(false);
    setSending(true);
    try {
      const conv = await ensureConversation();
      const detail = fields
        ? Object.entries(fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
        : '';
      const content = [starter.label, detail].filter(Boolean).join('\n');
      const { message } = await apiSendMessage(conv.id, conv.token, content);
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch {
      setAttachError(strings.genericError);
    } finally {
      setSending(false);
    }
  };

  // Route a starter. If it defines intake fields, collect them first, then run it
  // with those values; otherwise run it immediately.
  const startStarter = (starter: Starter) => {
    if (sending) return;
    if (starter.fields && starter.fields.length > 0) setIntake({ starter, values: {} });
    else void runStarter(starter);
  };

  const submitIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!intake) return;
    const missing = intake.starter.fields?.some((f) => f.required && !(intake.values[f.name] ?? '').trim());
    if (missing) return;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(intake.values)) if (v.trim()) values[k] = v.trim();
    const starter = intake.starter;
    setIntake(null);
    await runStarter(starter, values);
  };

  // Start a plain chat from the intent home ("Something else — just chat"). The
  // action list gives way to the greeting + composer immediately (creating the
  // conversation posts no message, so without this the tap looked like a no-op).
  const startPlainChat = async () => {
    setShowPreChat(false);
    setPlainChat(true);
    setTimeout(() => composerRef.current?.focus(), 50);
    await ensureConversation().catch(() => undefined);
  };

  // Submit the post-chat rating. Sent as a normal visitor message so it lands in
  // the agent inbox with no backend schema change.
  const submitRating = async () => {
    if (!rating || rating.stars === 0) return;
    setSending(true);
    try {
      const conv = await ensureConversation();
      await rateConversation(conv.id, conv.token, {
        stars: rating.stars,
        tags: rating.tags,
        comment: rating.comment.trim(),
      });
      setRating((r) => (r ? { ...r, sent: true } : r));
    } catch {
      setAttachError(strings.genericError);
    } finally {
      setSending(false);
    }
  };

  // Leave the review screen. In close mode, wipe the chat and drop to the
  // launcher; otherwise just return to the conversation.
  const finishReview = () => {
    if (closeAfterReview) {
      resetToFreshChat();
      setOpen(false);
    } else {
      setRating(null);
    }
  };

  // Conversation starters are entirely server-driven — the widget ships no
  // built-in pack, because "what a visitor might want" is the customer's domain,
  // not ours. Until Phase 9 configures them the list is empty and the widget shows
  // the plain welcome message.
  const starters: Starter[] = (config?.starters ?? []).map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    fields: s.fields,
  }));
  // The starter home shows before any messages, as long as there is something to
  // pick; otherwise the welcome message + composer is shown directly.
  const showStarterHome = messages.length === 0 && !plainChat && starters.length > 0;
  // Rating chips are per-website configuration, not a fixed list — the old
  // hardcoded set ("On-time rider", "Food quality") only made sense for one
  // customer. Empty hides the block entirely.
  const ratingTags = config?.rating_tags ?? [];

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
    // Keep every answer (trimmed, non-empty) so it lands in the conversation
    // metadata for the agent — not just name/email.
    const answers: Record<string, string> = {};
    for (const f of fields) {
      const v = (preChat[f.name] ?? '').trim();
      if (v) answers[f.name] = v;
    }
    preChatRef.current = answers;
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

  // Domain allowlist enforcement: if this site blocks unlisted domains and the
  // host isn't allowed, render nothing at all (the load is still recorded server
  // side, so the admin sees it in the Site manager).
  if (config && config.enforce_domains && config.authorized === false) return null;

  // ── Render: launcher (closed) ─────────────────────────────────────────────────
  if (!open) {
    // In the embed iframe the launcher is centred within its small (host-sized)
    // iframe so its drop shadow has room on every side and isn't clipped into a
    // square; standalone it anchors to the configured corner.
    const launcherClass = embedded
      ? 'fixed inset-0 m-auto'
      : `fixed bottom-4 ${side === 'left' ? 'left-4' : 'right-4'}`;
    return (
      <button
        onClick={handleOpen}
        aria-label={strings.headerDefaultTitle}
        className={`${launcherClass} group z-[2147483000] w-16 h-16 rounded-full flex items-center justify-center text-white transition-transform duration-200 hover:scale-110 active:scale-95`}
        style={{ backgroundColor: primaryColor, boxShadow: '0 3px 12px rgba(0,0,0,0.22)' }}
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

      {/* "Close this chat?" confirmation (X button on a live chat). */}
      {confirmClose && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-[1px]"
          onClick={() => setConfirmClose(false)}
        >
          <div className="w-full bg-white rounded-t-3xl p-5 shadow-xl animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg text-gray-800 mb-1">Close this chat?</p>
            <p className="text-sm text-gray-500 mb-4">Rate your experience before you go, or just minimize to keep it open.</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => startReview(true)}
                className="w-full py-3 text-white rounded-full font-semibold shadow-md active:scale-[0.98] transition"
                style={{ backgroundColor: primaryColor }}
              >
                Close &amp; rate
              </button>
              <button
                onClick={() => {
                  setConfirmClose(false);
                  setMinimized(true);
                }}
                className="w-full py-2.5 text-gray-600 rounded-full text-sm font-medium hover:bg-gray-100 transition"
              >
                Keep it open (minimize)
              </button>
            </div>
          </div>
        </div>
      )}

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
                  <p className="text-sm text-gray-600">Your feedback helps us do better.</p>
                  <button onClick={finishReview} className="mt-2 text-sm font-semibold" style={{ color: primaryColor }}>
                    {closeAfterReview ? 'Done' : 'Back to chat'}
                  </button>
                </div>
              ) : (
                <>
                  <div className="px-6 pt-6 pb-5 text-white" style={{ backgroundColor: '#6f7f54' }}>
                    <span className="w-11 h-11 rounded-full bg-white/15 flex items-center justify-center mb-3">
                      <Check className="w-6 h-6" />
                    </span>
                    <h4 className="font-display text-2xl">{closeAfterReview ? 'Thanks for chatting!' : 'All sorted!'}</h4>
                    <p className="text-sm text-white/90 mt-1">
                      {closeAfterReview ? 'How was your experience?' : 'One last thing — how did we do?'}
                    </p>
                  </div>
                  <div className="flex-1 p-5 space-y-5">
                    {/* Star rating */}
                    <div className="flex justify-center gap-2">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} onClick={() => setRating((r) => (r ? { ...r, stars: n } : r))} aria-label={`${n} stars`} className="active:scale-90 transition">
                          <Star className="w-9 h-9" style={{ fill: n <= rating.stars ? primaryColor : 'transparent', color: n <= rating.stars ? primaryColor : '#c9c1b3' }} />
                        </button>
                      ))}
                    </div>
                    {/* Tags — configured per website; the block hides when empty. */}
                    {ratingTags.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold tracking-wider text-gray-500 mb-2">WHAT STOOD OUT?</p>
                      <div className="flex flex-wrap gap-2">
                        {ratingTags.map((tag) => {
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
                    )}
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
                    <button onClick={finishReview} className="w-full py-2 text-gray-500 rounded-full text-sm font-medium hover:bg-gray-100 transition">
                      {closeAfterReview ? 'Skip' : 'Skip for now'}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : intake ? (
            <div className="flex-1 overflow-y-auto bg-cream flex flex-col">
              <div className="px-5 pt-5 pb-4">
                <h4 className="font-display text-xl text-gray-800">{intake.starter.label}</h4>
                <p className="text-sm text-gray-600 mt-1">Just a couple of quick details so we can help.</p>
              </div>
              <form onSubmit={submitIntake} className="flex-1 px-5 flex flex-col gap-4">
                {intake.starter.fields?.map((f) => (
                  <div key={f.name}>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      {f.label}
                      {f.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    <input
                      value={intake.values[f.name] ?? ''}
                      onChange={(e) =>
                        setIntake((s) => (s ? { ...s, values: { ...s.values, [f.name]: e.target.value } } : s))
                      }
                      placeholder={f.label}
                      className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-2xl text-sm outline-none transition focus:ring-4 focus:ring-blue-500/15 focus:border-blue-400"
                    />
                  </div>
                ))}
                <div className="flex-1" />
                <div className="pb-5 space-y-2">
                  <button
                    type="submit"
                    disabled={
                      sending ||
                      (intake.starter.fields ?? []).some((f) => f.required && !(intake.values[f.name] ?? '').trim())
                    }
                    className="w-full py-3 text-white rounded-full font-semibold shadow-md hover:opacity-90 active:scale-[0.98] transition disabled:opacity-40"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => setIntake(null)}
                    className="w-full py-2 text-gray-500 rounded-full text-sm font-medium hover:bg-gray-100 transition"
                  >
                    Cancel
                  </button>
                </div>
              </form>
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
                {/* Starter home: the visitor picks what they need before a
                    conversation exists. Entirely config-driven — see `starters`. */}
                {showStarterHome && (
                  <div className="pt-1">
                    <p className="text-[11px] font-bold tracking-wider text-gray-500 mb-2 px-1">
                      HOW CAN WE HELP?
                    </p>
                    <div className="flex flex-col gap-2">
                      {starters.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => startStarter(s)}
                          disabled={sending}
                          className="flex items-center gap-3 bg-white border-[1.5px] border-gray-200 rounded-full px-4 py-3 text-left transition hover:border-gray-300 active:scale-[0.99] disabled:opacity-50"
                        >
                          <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${primaryColor} 12%, #fff)` }}>
                            <Headphones className="w-4 h-4" style={{ color: primaryColor }} />
                          </span>
                          <span className="flex-1 text-sm font-semibold text-gray-800">{s.label}</span>
                          <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                        </button>
                      ))}
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

                {messages.length === 0 && !showStarterHome && (
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
                  {/* Starter chips, right-aligned like a suggested-reply row. */}
                  {starters.length > 0 && messages.length > 0 && !escalated && (
                    <div className="flex gap-2 px-3 pt-2 pb-1 bg-white overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {/* Grows to right-align the chips when they fit, but shrinks
                          to 0 when they overflow so every chip stays scroll-reachable
                          (justify-end alone makes the leading chips unreachable). */}
                      <span aria-hidden className="flex-1 shrink min-w-0" />
                      {starters.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => startStarter(s)}
                          disabled={sending}
                          className="shrink-0 rounded-full border-[1.5px] px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition active:scale-95 disabled:opacity-50"
                          style={{
                            borderColor: primaryColor,
                            color: primaryColor,
                            background: `color-mix(in srgb, ${primaryColor} 9%, #fff)`,
                          }}
                        >
                          {s.label}
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
                      ref={composerRef}
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
                Powered by Nestled
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
      <div className="px-3.5 py-2.5 text-sm text-white rounded-[18px] rounded-br-[6px] shadow-sm [&_a]:text-white" style={{ backgroundColor: primaryColor }}>
        <Markdown text={message.content} />
      </div>
    );
  } else {
    content = (
      <div className="px-3.5 py-2.5 text-sm bg-white text-gray-800 rounded-[18px] rounded-bl-[6px] border border-gray-200">
        <Markdown text={message.content} />
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
