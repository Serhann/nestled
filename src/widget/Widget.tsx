import { useCallback, useEffect, useRef, useState } from 'react';
import type { BootPayload, Starter } from '../types/chat';
import type { WidgetApi } from './api';
import type { EmbedParams } from './boot';
import type { Copy } from './copy';
import type { ThemeState } from './theme/applyTheme';
import { chime } from './sound';
import { useAgentAvailability } from './state/useAgentAvailability';
import { useConversation } from './state/useConversation';
import { useHostBridge, type HostState } from './state/useHostBridge';
import { useTriggers } from './state/useTriggers';
import { useUnread } from './state/useUnread';
import { Composer } from './ui/Composer';
import { ConfirmClose } from './ui/ConfirmClose';
import { Launcher } from './ui/Launcher';
import { Panel } from './ui/Panel';
import { Screen, type View } from './ui/Screen';

/** Iframe sizes the embed resizes to. Closed leaves room for the launcher's shadow. */
const SIZES = { closed: [96, 96], minimized: [384, 68], open: [384, 640] } as const;
/** Breathing room around the closed launcher so its drop shadow is not clipped square. */
const SHADOW_ROOM = 18;

export function Widget({
  params,
  previewDevice,
  api,
  boot,
  copy,
  theme,
}: {
  params: EmbedParams;
  /** Only meaningful in the appearance editor; 'desktop' everywhere else. */
  previewDevice?: 'desktop' | 'mobile';
  api: WidgetApi;
  boot: BootPayload;
  copy: Copy;
  theme: ThemeState;
}) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [view, setView] = useState<View>('auto');
  const [intake, setIntake] = useState<Starter | null>(null);
  const [ratingSent, setRatingSent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [plainChat, setPlainChat] = useState(false);

  const host = useRef<HostState>({ identity: {}, data: {}, contextToken: null, triggerId: null, prechat: {} });
  const { unread, bump, clear } = useUnread(open && !minimized);

  const chat = useConversation({
    api,
    params,
    boot,
    host,
    onIncoming: () => {
      bump();
      if (boot.behavior?.sound_enabled !== false) chime();
    },
    onAgentStatus: (online) => availability.setOnline(online),
    onResolved: () => {
      // Ask for a rating if they are looking; otherwise wipe silently rather than
      // ambushing them with a review screen the next time they open the widget.
      if (open) setView('rating');
      else if (boot.behavior?.reset_after_resolve !== false) chat.reset();
    },
  });

  const availability = useAgentAvailability(boot, params, {
    panelOpen: open,
    hasSocket: Boolean(chat.conversation),
  });

  const show = useCallback(() => {
    setOpen(true);
    setMinimized(false);
    clear();
    if (!chat.conversation && boot.behavior?.pre_chat_enabled) setView('prechat');
  }, [boot.behavior?.pre_chat_enabled, chat.conversation, clear]);

  const bridge = useHostBridge(host, {
    open: show,
    close: () => setOpen(false),
    toggle: () => (open ? setOpen(false) : show()),
    reset: () => {
      chat.reset();
      setView('auto');
      setPlainChat(false);
    },
    sendMessage: (text) => {
      show();
      void chat.send(text);
    },
    // Bot flows run server-side and there is no "start flow" endpoint, so this
    // resolves against the configured starters instead of inventing a call.
    startBot: (flow) => {
      const starter = (boot.starters ?? []).find((s) => s.id === flow);
      show();
      if (starter) void runStarter(starter);
    },
    proactive: ({ conversation_id, claim_token }) => {
      void chat.adopt(conversation_id, claim_token).then(show).catch(() => undefined);
    },
    context: (token) => chat.pushContext(token),
  });

  const nudge = useTriggers({
    boot,
    params,
    api,
    agentOnline: availability.online,
    onAttribute: (id) => {
      host.current.triggerId = id;
    },
    onOpen: show,
    onSound: () => boot.behavior?.sound_enabled !== false && chime(),
  });

  /**
   * Tell the embed how large to be. The two-state sizing is what keeps the host page's
   * bottom-right corner clickable while the widget is closed.
   *
   * The CLOSED size is measured, not assumed. A `pill` launcher is as wide as its label,
   * and the label is a string the customer writes — so there is no constant that fits
   * it. The fixed 96px box clipped every pill launcher on every real page: 105px of
   * button in a 96px frame, with the end of the customer's own words cut off. A bubble
   * still lands on 96 because that is what it measures.
   */
  const launcherRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const state = !open ? 'closed' : minimized ? 'minimized' : 'open';
    if (state !== 'closed') {
      const [, height] = SIZES[state];
      // The customer's width, not the constant. The IFRAME is what has to be this
      // wide — a panel styled wider inside a 384px frame is a panel with its right
      // edge cut off, which is how every frame-sized setting on this screen has
      // failed so far.
      const width = Math.max(320, Math.min(520, boot.theme?.panel_width ?? SIZES.open[0]));
      bridge.resize(state, width, height);
      bridge.emit('open');
      return;
    }
    // A frame, so the launcher has been laid out with its final label and size.
    const frame = requestAnimationFrame(() => {
      const el = launcherRef.current;
      const [fallbackW, fallbackH] = SIZES.closed;
      const rect = el?.getBoundingClientRect();
      // Room on each side for what the button draws OUTSIDE its own box: a drop shadow
      // always, and the attention ring when it is on. The ring reaches 1.55x, so at the
      // large launcher size a fixed 18px would clip it into a square — the same
      // mistake as sizing the frame to the button and cropping the shadow.
      const pulsing = boot.theme?.launcher_pulse === true;
      const room = pulsing
        ? Math.max(SHADOW_ROOM, Math.ceil((rect?.height ?? 60) * 0.3))
        : SHADOW_ROOM;
      const width = rect && rect.width > 0 ? Math.ceil(rect.width) + room * 2 : fallbackW;
      const height = rect && rect.height > 0 ? Math.ceil(rect.height) + room * 2 : fallbackH;
      bridge.resize('closed', Math.max(width, 48), Math.max(height, 48));
    });
    bridge.emit('close');
    return () => cancelAnimationFrame(frame);
  }, [
    bridge,
    open,
    minimized,
    boot.theme?.launcher_style,
    boot.theme?.launcher_size,
    boot.theme?.panel_width,
    boot.theme?.launcher_pulse,
    // A PILL launcher's width includes whatever sits beside the label, and a logo is given
    // a larger box than a glyph — so gaining or losing the picture changes the box the host
    // frame is sized from. A bubble is unaffected (its size is set inline), but the
    // dependency has to cover the case that is not.
    boot.theme?.brand_avatar_url,
    copy.launcherLabel,
  ]);

  useEffect(() => {
    if (unread > 0) bridge.emit('unread', { count: unread });
  }, [bridge, unread]);

  // Minted eagerly rather than on first message: the host page's presence socket
  // needs it, and it is the same session the conversation will use — one visitor
  // identity across both, which is what makes a proactive claim redeemable here.
  //
  // NOT in preview. The appearance editor frames this widget, so `embedded` is true
  // there too — and without this guard the editor minted a widget session against the
  // customer's live website on every mount, purely because somebody was choosing a
  // colour. Caught by counting the preview iframe's own network requests rather than
  // by reading this file, which is why the check is worth keeping in the test above.
  const ensureSession = chat.ensureSession;
  /*
    Whether presence.js should record the host page for live view.

    This flag has been travelling from the database to `/boot` to this component for
    as long as live view has existed, and stopping here — because the recorder does
    not run in this iframe. It runs in presence.js, on the host page, where the DOM
    an agent wants to watch actually is. So the flag has to cross the frame boundary
    too, or "Enable live view" is a switch wired to nothing: every part of the
    feature existed except the one that turns the camera on.
  */
  const recordForLiveView = boot.behavior?.live_view_enabled === true;
  useEffect(() => {
    if (!params.embedded || params.preview) return;
    void ensureSession()
      .then((token) => bridge.session(token, recordForLiveView))
      .catch(() => undefined);
  }, [bridge, ensureSession, params.embedded, params.preview, recordForLiveView]);

  /**
   * Tell embed.js where the customer wants the launcher.
   *
   * The snippet is pasted once and never touched again, so it cannot know a placement
   * changed in the dashboard afterwards — it only has whatever `data-position` said on
   * the day it was copied. Until this existed, the side and the two distance fields on
   * the appearance screen were dead controls: a customer moved them, saved, and their
   * bubble did not move.
   */
  const placement = bridge.placement;
  const savedPlacement = boot.theme;
  useEffect(() => {
    if (!params.embedded || params.preview || !savedPlacement) return;
    placement(
      savedPlacement.position ?? 'right',
      savedPlacement.offset_x ?? 16,
      savedPlacement.offset_y ?? 16,
      // The corner radius belongs to the iframe, not to this document — see embed.js.
      savedPlacement.radius_px ?? 16,
    );
  }, [placement, params.embedded, params.preview, savedPlacement]);

  async function runStarter(starter: Starter, values?: Record<string, string>): Promise<void> {
    setIntake(null);
    setView('auto');
    const detail = Object.entries(values ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    await chat.send([starter.message || starter.label, detail].filter(Boolean).join('\n'));
  }

  const finishRating = () => {
    setView('auto');
    setRatingSent(false);
    chat.reset();
    setPlainChat(false);
    setOpen(false);
  };

  if (!open) {
    return (
      <div
        className="n-root"
        data-embedded={params.embedded}
        data-preview={params.preview}
        data-preview-device={previewDevice}
        data-position={boot.theme?.position ?? params.position}
        style={previewOffsets(params, boot)}
      >
        <Launcher
          ref={launcherRef}
          theme={boot.theme}
          label={copy.launcherLabel}
          unread={unread}
          onOpen={show}
        />
      </div>
    );
  }

  const starters = boot.starters ?? [];
  const offline =
    !chat.conversation && !availability.online && boot.behavior?.ai_enabled === false;
  /**
   * The starter-chip home screen.
   *
   * `!nudge` is load-bearing, and its absence is why campaigns did not appear to work. A
   * fired campaign produces a nudge that only `Thread` draws, but `Screen` returns Home
   * before it ever reaches Thread — so on any website with starters configured (the
   * default) a campaign would fire, meter itself, open the panel, and show the visitor the
   * ordinary starter chips. Indistinguishable from nothing having happened.
   *
   * A proactive message outranks the home screen because it IS the more specific thing to
   * say: the campaign was written for this visitor on this page, and the chips are what we
   * show when we have nothing particular to offer.
   */
  const atHome =
    !chat.conversation && chat.messages.length === 0 && !plainChat && !nudge && starters.length > 0;
  const wantsComposer = view === 'auto' && !offline && !atHome;

  const body = (
    <Screen
      view={view}
      boot={boot}
      copy={copy}
      chat={chat}
      availability={availability}
      starters={starters}
      intake={intake}
      nudge={nudge?.message ?? null}
      ratingSent={ratingSent}
      offline={offline}
      atHome={atHome}
      onPreChat={(values) => {
        host.current.prechat = values;
        setView('auto');
        void chat.ensureConversation({ name: values.name, email: values.email }).catch(() => undefined);
      }}
      onIntakeSubmit={(starter, values) => void runStarter(starter, values)}
      onIntakeCancel={() => {
        setIntake(null);
        setView('auto');
      }}
      onStarter={(starter) => {
        if (starter.fields?.length) {
          setIntake(starter);
          setView('intake');
        } else void runStarter(starter);
      }}
      onPlainChat={() => setPlainChat(true)}
      onOfflineSubmit={(email, message) =>
        chat
          .ensureSession()
          .then((token) => api.offlineMessage(token, email, message))
          .then(() => true)
          .catch(() => false)
      }
      onRate={(value) => void chat.rate(value).then(() => setRatingSent(true)).catch(() => undefined)}
      onRatingDone={finishRating}
    />
  );

  return (
    <div
      className="n-root"
      data-embedded={params.embedded}
      data-preview={params.preview}
      data-preview-device={previewDevice}
      data-position={boot.theme?.position ?? params.position}
      style={previewOffsets(params, boot)}
    >
      <Panel
        copy={copy}
        theme={boot.theme}
        online={availability.online}
        contrastWarning={theme.contrastWarning}
        showBranding={boot.theme?.show_branding !== false}
        notice={chat.error ? copy.genericError : null}
        onMinimize={() => setMinimized((m) => !m)}
        onClose={() => (chat.conversation ? setConfirming(true) : setOpen(false))}
        overlay={
          confirming ? (
            <ConfirmClose
              copy={copy}
              onKeep={() => setConfirming(false)}
              onClose={() => {
                setConfirming(false);
                if (chat.messages.length > 0) setView('rating');
                else finishRating();
              }}
            />
          ) : null
        }
        composer={
          wantsComposer ? (
            <Composer
              placeholder={copy.composerPlaceholder}
              sendLabel={copy.sendLabel}
              disabled={chat.sending}
              autoFocus={plainChat}
              onSend={(text) => void chat.send(text)}
              onTyping={chat.setTyping}
              preview={params.preview}
            />
          ) : null
        }
      >
        {minimized ? <div /> : body}
      </Panel>
    </div>
  );
}

/**
 * The launcher offsets, as inline custom properties, in preview only.
 *
 * On a real page these are applied by embed.js to the iframe it owns; the widget
 * document never needs them. In the editor there is no embed.js, so the preview reads
 * them here to stand in for it — see the `[data-preview]` rules in widget.css.
 */
function previewOffsets(
  params: { preview: boolean },
  boot: BootPayload,
): React.CSSProperties | undefined {
  if (!params.preview) return undefined;
  return {
    '--n-preview-offset-x': `${boot.theme?.offset_x ?? 20}px`,
    '--n-preview-offset-y': `${boot.theme?.offset_y ?? 20}px`,
    // The panel width too: on a real page the iframe carries it, and the preview has
    // to stand in for the iframe.
    '--n-preview-panel-w': `${boot.theme?.panel_width ?? 384}px`,
  } as React.CSSProperties;
}
