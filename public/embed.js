/*
 * Nestled embed.
 *
 * Loads asynchronously, never blocks the host page, and leaks no styles into it.
 * The snippet a customer pastes:
 *
 *   <script>
 *     window.Nestled = window.Nestled || function(){(Nestled.q=Nestled.q||[]).push(arguments)};
 *     window.NestledId = "nst_xxxxxxxxxxxxxxxxxxxxxxxx";
 *   </script>
 *   <script async src="https://widget.nestled.chat/embed.js"></script>
 *
 * `window.NestledId` (or `data-website-id`) is the website's public key. It is
 * unguessable by design: a readable tenant selector — the pre-tenant build used
 * `mode=food` — lets any visitor enumerate other customers' widget config, copy,
 * starters and domain lists.
 *
 * Two behaviours in here are load-bearing and have been broken before:
 *
 *  1. TWO-STATE IFRAME SIZING. The container is exactly launcher-sized while
 *     closed and expands to the panel when open. The obvious alternative — a
 *     full-viewport transparent iframe with pointer-events juggling — swallows
 *     clicks in the host page's bottom-right corner, which is where sites put
 *     their cookie banners and back-to-top buttons.
 *
 *  2. visualViewport TRACKING ON MOBILE. When the on-screen keyboard opens,
 *     100vh and even 100dvh do not shrink, so the composer ends up underneath
 *     the keyboard. Following visualViewport's offset/size is the only thing
 *     that keeps the input visible while someone is typing into it.
 */
(function () {
  'use strict';
  if (window.__nestledLoaded) return;
  window.__nestledLoaded = true;

  var self = document.currentScript;
  var attr = function (name) {
    return (self && self.getAttribute(name)) || '';
  };
  var scriptOrigin = self ? new URL(self.src).origin : window.location.origin;
  var apiBase = attr('data-api-base') || scriptOrigin;
  var widgetOrigin = attr('data-widget-origin') || scriptOrigin;
  var websiteKey = attr('data-website-id') || window.NestledId || '';

  if (!websiteKey) {
    if (window.console && console.warn) {
      console.warn('[nestled] no website key — set window.NestledId or data-website-id on the embed script.');
    }
    return;
  }

  var LAUNCHER = 96;
  var MOBILE_MAX = 480;
  var position = attr('data-position') === 'left' ? 'left' : 'right';
  /*
   * Placement, and where it comes from.
   *
   * These are DEFAULTS. The real values live in the customer's website settings and
   * arrive from the widget as `nestled:placement` once /boot has answered — because
   * the snippet is pasted once and never edited again, while the dashboard is edited
   * whenever somebody wants the bubble somewhere else.
   *
   * Before that message this was hardcoded at 16 with no way in, which meant the
   * "side" and "distance" controls on the appearance screen did nothing at all: a
   * customer moved the sliders, saved, and their bubble stayed exactly where it was.
   *
   * `data-position` on the script tag still wins as the pre-boot guess, so the
   * launcher does not visibly jump corners on a slow connection.
   */
  var offsetX = 16;
  var offsetY = 16;

  /*
   * ONE storage key, not one per website.
   *
   * The pre-tenant embed namespaced this by website key while presence.js used
   * the bare name, so the host page and the iframe were two different visitors
   * and a proactive chat never reached the widget. Sharing it is also correct:
   * the server keys presence and conversations by (website, visitor), so two
   * customers on one origin cannot collide even with the same id.
   */
  var VISITOR_KEY = 'nestled_vid';

  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      /* private mode */
    }
    return null;
  }

  function newVisitorId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  var visitorId = storage(VISITOR_KEY) || newVisitorId();
  storage(VISITOR_KEY, visitorId);

  // ── Cross-site device fingerprint ────────────────────────────────────────
  // The visitor id lives in first-party storage, so the same human on another of
  // our customers' sites mints a fresh id. A device-level hash that is identical
  // across origins lets the server fuse those into one person. Only the hash
  // ever leaves the browser.
  function cyrb53(str) {
    var h1 = 0xdeadbeef;
    var h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function canvasSignal() {
    try {
      var c = document.createElement('canvas');
      c.width = 240;
      c.height = 60;
      var ctx = c.getContext('2d');
      if (!ctx) return '';
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Nestled fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('Nestled fp', 4, 17);
      return c.toDataURL();
    } catch (e) {
      return '';
    }
  }

  function webglSignal() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg
        ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) + '~' + String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.VENDOR));
    } catch (e) {
      return '';
    }
  }

  function fingerprintOf() {
    try {
      var n = navigator;
      var s = window.screen;
      var tz = '';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch (e) {
        /* ignore */
      }
      return cyrb53(
        [
          n.userAgent || '',
          (n.languages || [n.language]).join(','),
          n.platform || '',
          n.hardwareConcurrency || '',
          n.deviceMemory || '',
          n.maxTouchPoints || '',
          s ? s.width + 'x' + s.height + 'x' + s.colorDepth : '',
          window.devicePixelRatio || '',
          tz,
          new Date().getTimezoneOffset(),
          canvasSignal(),
          webglSignal(),
        ].join('||'),
      );
    } catch (e) {
      return '';
    }
  }

  var fingerprint = fingerprintOf();
  var contextToken = attr('data-context') || window.NestledContext || '';
  if (typeof contextToken !== 'string') contextToken = '';

  // ── Frame ────────────────────────────────────────────────────────────────

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    /* ignore */
  }
  var TRANSITION = reduceMotion ? 'none' : 'width 0.25s ease, height 0.25s ease';

  var container = null;
  var iframe = null;
  var ready = false;
  var pending = [];
  var listeners = {};

  // No identity in the URL. Name, email and phone arrive over postMessage once
  // the widget announces itself ready; a URL keeps them for the page's lifetime.
  // `reset` is a marker, not data: the widget's stored conversation lives in the
  // widget origin's localStorage, which this page cannot reach cross-origin.
  function frameSrc(reset) {
    return (
      widgetOrigin +
      '/widget?key=' + encodeURIComponent(websiteKey) +
      '&api=' + encodeURIComponent(apiBase) +
      '&vid=' + encodeURIComponent(visitorId) +
      '&fp=' + encodeURIComponent(fingerprint) +
      '&pos=' + position +
      '&href=' + encodeURIComponent(window.location.href) +
      (reset ? '&reset=1' : '')
    );
  }

  function build() {
    container = document.createElement('div');
    container.id = 'nestled-root';
    var s = container.style;
    s.position = 'fixed';
    s.bottom = offsetY + 'px';
    s[position] = offsetX + 'px';
    s.width = LAUNCHER + 'px';
    s.height = LAUNCHER + 'px';
    s.maxWidth = 'calc(100vw - ' + offsetX * 2 + 'px)';
    s.maxHeight = 'calc(100vh - ' + offsetY * 2 + 'px)';
    s.zIndex = '2147483647';
    s.border = 'none';
    s.background = 'transparent';
    s.transition = TRANSITION;
    // No pointer-events tricks needed: while closed the container occupies only
    // the launcher, so it cannot swallow clicks anywhere else.

    iframe = document.createElement('iframe');
    iframe.id = 'nestled-frame';
    iframe.title = 'Chat';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.src = frameSrc(false);
    var is = iframe.style;
    is.width = '100%';
    is.height = '100%';
    is.border = 'none';
    is.background = 'transparent';
    is.colorScheme = 'normal';

    container.appendChild(iframe);
    document.body.appendChild(container);
  }

  // ── Sizing ───────────────────────────────────────────────────────────────

  var viewportHandler = null;

  /*
   * Full-screen on a phone, following the visual viewport.
   *
   * The transition is switched off here: this runs on every keyboard resize and
   * scroll event, and animating those makes the panel lag behind the keyboard.
   */
  function applyMobileFull() {
    var vv = window.visualViewport;
    var s = container.style;
    s.transition = 'none';
    s.top = (vv ? vv.offsetTop : 0) + 'px';
    s.left = (vv ? vv.offsetLeft : 0) + 'px';
    s.right = 'auto';
    s.bottom = 'auto';
    s.width = (vv ? vv.width : window.innerWidth) + 'px';
    s.height = (vv ? vv.height : window.innerHeight) + 'px';
    s.maxWidth = 'none';
    s.maxHeight = 'none';
    s.borderRadius = '0';
    s.boxShadow = 'none';
    iframe.style.borderRadius = '0';
  }

  function trackViewport(on) {
    var vv = window.visualViewport;
    if (!vv) return;
    if (on && !viewportHandler) {
      viewportHandler = function () {
        if (window.innerWidth <= MOBILE_MAX) applyMobileFull();
      };
      vv.addEventListener('resize', viewportHandler);
      vv.addEventListener('scroll', viewportHandler);
    } else if (!on && viewportHandler) {
      vv.removeEventListener('resize', viewportHandler);
      vv.removeEventListener('scroll', viewportHandler);
      viewportHandler = null;
    }
  }

  function resize(msg) {
    if (!container) return;
    if (window.innerWidth <= MOBILE_MAX && msg.state === 'open') {
      applyMobileFull();
      trackViewport(true);
      return;
    }
    trackViewport(false);

    var s = container.style;
    s.transition = TRANSITION;
    s.top = 'auto';
    s.left = 'auto';
    s.right = 'auto';
    s.bottom = offsetY + 'px';
    s[position] = offsetX + 'px';
    s.width = (msg.width || LAUNCHER) + 'px';
    s.height = (msg.height || LAUNCHER) + 'px';
    s.maxWidth = 'calc(100vw - ' + offsetX * 2 + 'px)';
    s.maxHeight = 'calc(100vh - ' + offsetY * 2 + 'px)';

    // The panel is a rounded floating card: border-radius on the iframe clips its
    // square content, and the shadow sits on the transparent container so it hugs
    // that rounded shape. The closed launcher keeps neither — the round button
    // draws its own shadow, and a shadow on the box would show as a square.
    var panel = msg.state === 'open' || msg.state === 'minimized';
    iframe.style.borderRadius = panel ? '16px' : '0';
    s.borderRadius = panel ? '16px' : '0';
    s.boxShadow = panel ? '0 12px 48px rgba(0,0,0,0.18)' : 'none';
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function post(type, extra) {
    var msg = { type: type };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    if (!ready) {
      pending.push(msg);
      return;
    }
    iframe.contentWindow.postMessage(msg, '*');
  }

  function flush() {
    for (var i = 0; i < pending.length; i++) iframe.contentWindow.postMessage(pending[i], '*');
    pending = [];
  }

  function emit(name, payload) {
    var subs = listeners[name] || [];
    for (var i = 0; i < subs.length; i++) {
      try {
        subs[i](payload);
      } catch (e) {
        /* a host callback must never break the widget */
      }
    }
  }

  var presence = null;

  function handle(cmd, payload, extra) {
    switch (cmd) {
      case 'identify':
        if (payload && typeof payload === 'object') post('nestled:identify', { traits: payload });
        break;
      case 'data':
        if (payload && typeof payload === 'object') {
          post('nestled:data', { attributes: payload });
          if (presence) presence.setData(payload);
        }
        break;
      case 'context':
        // A freshly signed host context (a login, or any state change). It goes
        // to the widget for the conversation's verified attributes AND to
        // presence for the agent's Live Visitors card.
        if (typeof payload === 'string' && payload) {
          contextToken = payload;
          post('nestled:context', { token: payload });
          if (presence) presence.setContext(payload);
        }
        break;
      case 'config':
        // Placement only. Everything else is website settings, served by /boot —
        // letting a host page override copy or behaviour from JavaScript would
        // put the customer's dashboard and their own snippet in disagreement.
        if (payload && typeof payload === 'object') {
          if (payload.position === 'left' || payload.position === 'right') position = payload.position;
          // `offset` sets both axes, and is kept because it is the shape older cached
          // copies of this file and any customer already calling Nestled('config') use.
          if (typeof payload.offset === 'number') {
            offsetX = offsetY = Math.max(0, payload.offset);
          }
          if (typeof payload.offsetX === 'number') offsetX = Math.max(0, payload.offsetX);
          if (typeof payload.offsetY === 'number') offsetY = Math.max(0, payload.offsetY);
          resize({ state: 'closed' });
        }
        break;
      case 'reset':
        // A new visitor as far as this browser is concerned: new id, no stored
        // conversation, a fresh presence session and a reloaded iframe.
        visitorId = newVisitorId();
        storage(VISITOR_KEY, visitorId);
        if (presence) presence.stop();
        presence = null;
        ready = false;
        pending = [];
        iframe.src = frameSrc(true);
        break;
      case 'open':
      case 'close':
      case 'toggle':
        post('nestled:' + cmd);
        break;
      case 'show':
        if (container) container.style.display = '';
        break;
      case 'hide':
        if (container) container.style.display = 'none';
        break;
      case 'sendMessage':
        if (typeof payload === 'string' && payload.trim()) post('nestled:send', { text: payload });
        break;
      case 'startBot':
        if (typeof payload === 'string' && payload) post('nestled:bot', { flow: payload });
        break;
      case 'on':
        if (typeof payload === 'string' && typeof extra === 'function') {
          (listeners[payload] = listeners[payload] || []).push(extra);
        }
        break;
      default:
        break;
    }
  }

  /*
   * Presence needs a SIGNED session token: /ws/presence reads the visitor id and
   * website out of it and refuses a bare visitor_id outright.
   *
   * The token is minted by the WIDGET IFRAME and handed to us, not fetched from
   * here. `POST /widget/session` from this page would be a cross-origin request
   * from a customer's own domain, and a CORS allowlist can never enumerate every
   * customer's website; the widget's origin is one known host. It also means one
   * session, so the presence socket and the conversation agree on who this
   * visitor is — which is what makes a proactive claim redeemable.
   */
  function loadPresence(sessionToken) {
    if (presence || !sessionToken) return;
    var start = function () {
      if (!window.NestledPresence) return;
      presence = window.NestledPresence.init({
        apiBase: apiBase,
        sessionToken: sessionToken,
        fingerprint: fingerprint,
        contextToken: contextToken,
        recordScriptUrl: widgetOrigin + '/vendor/rrweb-record.min.js',
        onProactive: function (data) {
          /*
           * A proactive chat carries a single-use CLAIM token, never the
           * conversation's visitor token. The widget exchanges it — with its own
           * session — for the real credential. Putting the visitor token on this
           * wire is exactly the takeover that presenceSecurity.test.ts pins shut.
           */
          post('nestled:proactive', {
            conversation_id: data.conversation_id,
            claim_token: data.claim_token,
            message: data.message,
            agent_name: data.agent_name,
          });
          emit('proactive', { message: data.message, agent_name: data.agent_name });
        },
      });
    };
    if (window.NestledPresence) return start();
    var script = document.createElement('script');
    script.src = widgetOrigin + '/presence.js';
    script.async = true;
    script.onload = start;
    document.head.appendChild(script);
  }

  function start() {
    build();

    window.addEventListener('message', function (event) {
      if (!iframe || event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'nestled:resize') resize(data);
      else if (data.type === 'nestled:ready') {
        ready = true;
        flush();
        emit('ready');
      } else if (data.type === 'nestled:placement') {
        /*
         * The saved placement, arriving from the widget after /boot.
         *
         * Applied without an animation on the first message: the launcher is already
         * painted in the pre-boot corner, and sliding it across the screen on every
         * page load looks like a bug rather than a setting.
         */
        if (data.position === 'left' || data.position === 'right') position = data.position;
        if (typeof data.offsetX === 'number') offsetX = Math.max(0, data.offsetX);
        if (typeof data.offsetY === 'number') offsetY = Math.max(0, data.offsetY);
        if (container) {
          var previous = container.style.transition;
          container.style.transition = 'none';
          resize({ state: 'closed' });
          // Read back to flush the style change before restoring the transition,
          // otherwise the browser coalesces both and animates anyway.
          void container.offsetWidth;
          container.style.transition = previous;
        }
      } else if (data.type === 'nestled:session') loadPresence(data.token);
      else if (data.type === 'nestled:event') emit(data.name, data.payload);
    });

    var queued = window.Nestled && window.Nestled.q ? window.Nestled.q : [];
    window.Nestled = function (cmd, payload, extra) {
      handle(cmd, payload, extra);
    };
    for (var i = 0; i < queued.length; i++) {
      handle(queued[i][0], queued[i][1], queued[i][2]);
    }
    // Presence starts when the widget hands us its session — see loadPresence.
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
