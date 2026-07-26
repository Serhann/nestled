/*
 * Nestled embed. Loads asynchronously and never blocks or style-leaks into the
 * host page.
 *
 * THE FIX for the old click-swallowing bug: instead of a full-viewport
 * transparent iframe with pointer-events hacks, the iframe is sized to exactly
 * what's visible. Closed → a ~76×76 launcher that covers only the button; open →
 * resized to the chat panel. The widget inside postMessages its desired size, so
 * the rest of the host page's bottom-right corner is always clickable.
 *
 * The snippet a customer pastes:
 *   <script>
 *     window.Nestled = window.Nestled || function(){(Nestled.q=Nestled.q||[]).push(arguments)};
 *     window.NestledId = "nst_xxxxxxxxxxxxxxxxxxxxxxxx";
 *   </script>
 *   <script async src="https://widget.nestled.chat/embed.js"></script>
 *
 * `window.NestledId` (or `data-website`) is the website's public key — unguessable
 * by design, since a readable tenant selector would let any visitor enumerate other
 * customers' widget config. `data-api-base` is the backend (REST + WS); the widget
 * app is served from the embed's own origin unless `data-widget-origin` overrides it.
 */
(function () {
  'use strict';
  if (window.__nestledLoaded) return;
  window.__nestledLoaded = true;

  var self = document.currentScript;
  var scriptOrigin = self ? new URL(self.src).origin : window.location.origin;
  var apiBase = (self && self.getAttribute('data-api-base')) || scriptOrigin;
  var widgetOrigin = (self && self.getAttribute('data-widget-origin')) || scriptOrigin;
  var position = (self && self.getAttribute('data-position')) === 'left' ? 'left' : 'right';
  // The website's public key. Without one there is no tenant to serve, so bail out
  // loudly rather than silently rendering a launcher that can never open a chat.
  var website = (self && self.getAttribute('data-website')) || window.NestledId || '';
  if (!website) {
    if (window.console && console.warn) {
      console.warn('[nestled] no website key — set window.NestledId or data-website on the embed script.');
    }
    return;
  }

  var LAUNCHER = 76;

  // Persistent visitor id — the same id feeds presence (host page) and the widget
  // (iframe). Namespaced by website key so two widgets sharing one origin (a
  // staging host, our sandbox page) don't collapse into one visitor.
  var VISITOR_KEY = 'nestled_vid_' + website;
  function getVisitorId() {
    try {
      var id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch (e) {
      return 'v_ephemeral_' + Math.random().toString(36).slice(2, 12);
    }
  }
  var visitorId = getVisitorId();

  // ── Cross-site device fingerprint ──────────────────────────────────────────
  // The visitor id lives in this site's first-party localStorage, so the same
  // human on another of our customer sites (different origin) mints a brand-new
  // id. To pool them we compute a device-level fingerprint that is identical
  // across origins (UA, languages, platform, screen, timezone, canvas, WebGL)
  // and hand it to the backend, which fuses matching visitors into one person.
  // Kept lightweight and synchronous; the server only ever sees the hash.
  function cyrb53(str) {
    var h1 = 0xdeadbeef,
      h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
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
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      var renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return String(vendor) + '~' + String(renderer);
    } catch (e) {
      return '';
    }
  }
  function computeFingerprint() {
    try {
      var n = navigator;
      var s = window.screen;
      var tz = '';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch (e) {}
      var parts = [
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
      ];
      return cyrb53(parts.join('||'));
    } catch (e) {
      return '';
    }
  }
  var fingerprint = computeFingerprint();

  // Visitor identity (Crisp's user:email / user:nickname equivalent). Sources, in
  // order: script data attributes, host URL params, and the Nestled() API.
  function readIdentity() {
    var id = {};
    var params = new URLSearchParams(window.location.search);
    var pick = function (attr, param) {
      var v = (self && self.getAttribute(attr)) || params.get(param);
      return v || null;
    };
    var email = pick('data-user-email', 'user_email');
    var name = pick('data-user-name', 'user_name');
    var phone = pick('data-user-phone', 'user_phone');
    var userId = pick('data-user-id', 'user_id');
    if (email) id.email = email;
    if (name) id.name = name;
    if (phone) id.phone = phone;
    if (userId) id.user_id = userId;
    return id;
  }
  var identity = readIdentity();

  // Signed visitor context (JWT) — the host's own server signs whatever it knows
  // about the logged-in visitor and hands us the token. It is verified server-side
  // with the website's shared secret, so the data is trusted (not spoofable).
  // Sources: data-context attribute, window.NestledContext, Nestled('context', t).
  function readContextToken() {
    var t = (self && self.getAttribute('data-context')) || window.NestledContext || '';
    return typeof t === 'string' ? t : '';
  }
  var contextToken = readContextToken();

  function identityParams() {
    var p = '';
    if (identity.email) p += '&ue=' + encodeURIComponent(identity.email);
    if (identity.name) p += '&un=' + encodeURIComponent(identity.name);
    if (identity.phone) p += '&up=' + encodeURIComponent(identity.phone);
    if (identity.user_id) p += '&uid=' + encodeURIComponent(identity.user_id);
    return p;
  }

  function build() {
    var container = document.createElement('div');
    container.id = 'nestled-root';
    var s = container.style;
    s.position = 'fixed';
    s.bottom = '16px';
    s[position] = '16px';
    s.width = LAUNCHER + 'px';
    s.height = LAUNCHER + 'px';
    s.maxWidth = 'calc(100vw - 32px)';
    s.maxHeight = 'calc(100vh - 32px)';
    s.zIndex = '2147483647';
    s.border = 'none';
    s.background = 'transparent';
    s.transition = 'width 0.25s ease, height 0.25s ease';
    // No pointer-events hacks: the container only occupies the launcher when
    // closed, so it can't swallow clicks elsewhere.

    var iframe = document.createElement('iframe');
    iframe.id = 'nestled-frame';
    iframe.title = 'Chat';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.src =
      widgetOrigin +
      '/widget?api=' +
      encodeURIComponent(apiBase) +
      '&vid=' +
      encodeURIComponent(visitorId) +
      '&fp=' +
      encodeURIComponent(fingerprint) +
      '&pos=' +
      position +
      '&site=' +
      encodeURIComponent(website) +
      // Host page URL, so the widget can evaluate page-based triggers.
      '&href=' +
      encodeURIComponent(window.location.href) +
      (contextToken ? '&ctx=' + encodeURIComponent(contextToken) : '') +
      identityParams();
    var is = iframe.style;
    is.width = '100%';
    is.height = '100%';
    is.border = 'none';
    is.background = 'transparent';
    is.colorScheme = 'normal';

    container.appendChild(iframe);
    document.body.appendChild(container);
    return { container: container, iframe: iframe };
  }

  // On mobile the open chat should be true full-screen AND track the visual
  // viewport so it shrinks above the on-screen keyboard (100vh/dvh don't shrink
  // when the keyboard opens, which otherwise hides the composer).
  var vvHandler = null;

  function applyMobileFull(container) {
    var vv = window.visualViewport;
    var s = container.style;
    s.transition = 'none'; // no animation while following the keyboard
    s.top = (vv ? vv.offsetTop : 0) + 'px';
    s.left = (vv ? vv.offsetLeft : 0) + 'px';
    s.right = 'auto';
    s.bottom = 'auto';
    s.width = (vv ? vv.width : window.innerWidth) + 'px';
    s.height = (vv ? vv.height : window.innerHeight) + 'px';
    s.maxWidth = 'none';
    s.maxHeight = 'none';
    s.borderRadius = '0';
  }

  function restoreDefault(container, msg) {
    var s = container.style;
    s.transition = 'width 0.25s ease, height 0.25s ease';
    s.top = 'auto';
    s.left = 'auto';
    s.right = 'auto';
    s.bottom = '16px';
    s[position] = '16px';
    s.width = (msg.width || LAUNCHER) + 'px';
    s.height = (msg.height || LAUNCHER) + 'px';
    s.maxWidth = 'calc(100vw - 32px)';
    s.maxHeight = 'calc(100vh - 32px)';
    s.borderRadius = '';
  }

  function resize(built, msg) {
    var container = built.container;
    var iframe = built.iframe;
    var mobileFull = window.innerWidth <= 480 && msg.state === 'open';
    if (mobileFull) {
      applyMobileFull(container);
      // True full-screen: no rounding/shadow on mobile.
      container.style.boxShadow = 'none';
      iframe.style.borderRadius = '0';
      if (!vvHandler && window.visualViewport) {
        vvHandler = function () {
          if (window.innerWidth <= 480) applyMobileFull(container);
        };
        window.visualViewport.addEventListener('resize', vvHandler);
        window.visualViewport.addEventListener('scroll', vvHandler);
      }
    } else {
      if (vvHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', vvHandler);
        window.visualViewport.removeEventListener('scroll', vvHandler);
        vvHandler = null;
      }
      restoreDefault(container, msg);
      // The open/minimized panel is a rounded floating card. border-radius on the
      // iframe clips its (square) content to rounded corners; the shadow sits on
      // the (transparent) container so it hugs that rounded shape. The closed
      // launcher stays unrounded/shadowless — the round button carries its own.
      var panel = msg.state === 'open' || msg.state === 'minimized';
      iframe.style.borderRadius = panel ? '16px' : '0';
      container.style.borderRadius = panel ? '16px' : '0';
      container.style.boxShadow = panel ? '0 12px 48px rgba(0,0,0,0.18)' : 'none';
    }
  }

  var presence = null; // the live NestledPresence instance (host-page context)

  function loadPresence(onProactive) {
    var apply = function () {
      if (window.NestledPresence) {
        presence = window.NestledPresence.init({
          apiBase: apiBase,
          visitorId: visitorId,
          fingerprint: fingerprint,
          contextToken: contextToken,
          site: website,
          onProactive: onProactive,
          // rrweb recorder is served from the widget origin (host-page context).
          recordScriptUrl: widgetOrigin + '/vendor/rrweb-record.min.js',
        });
      }
    };
    if (window.NestledPresence) return apply();
    var ps = document.createElement('script');
    ps.src = widgetOrigin + '/presence.js';
    ps.async = true;
    ps.onload = apply;
    document.head.appendChild(ps);
  }

  function start() {
    var built = build();

    // The widget tells us how big it wants to be.
    window.addEventListener('message', function (event) {
      if (event.source !== built.iframe.contentWindow) return;
      var data = event.data;
      if (data && data.type === 'nestled:resize') resize(built, data);
    });

    // Public JS API. The old order/orders commands are gone: `data` (arbitrary
    // unsigned session attributes) plus `context` (HMAC-signed) cover every real
    // use case without the product knowing what a customer's records are.
    //
    //   Nestled('identify', { email, name, user_id })
    //   Nestled('data', { plan: 'pro', seats: 12 })
    //   Nestled('context', '<signed jwt>')
    //   Nestled('open' | 'close' | 'toggle')
    function post(type, extra) {
      var msg = { type: type };
      for (var k in extra) msg[k] = extra[k];
      built.iframe.contentWindow.postMessage(msg, '*');
    }
    function handle(cmd, payload) {
      if (cmd === 'identify' && payload && typeof payload === 'object') {
        for (var k in payload) if (payload[k] != null) identity[k] = payload[k];
        post('nestled:identify', { traits: payload });
      } else if (cmd === 'data' && payload && typeof payload === 'object') {
        post('nestled:data', { attributes: payload });
        if (presence && presence.setData) presence.setData(payload);
      } else if (cmd === 'context' && typeof payload === 'string') {
        // Signed context token issued/refreshed at runtime (e.g. after login).
        // Goes to the widget (conversation context) AND to presence (the Live
        // Visitors card / identified visitor).
        contextToken = payload;
        post('nestled:context', { token: payload });
        if (presence && presence.setContext) presence.setContext(payload);
      } else if (cmd === 'open' || cmd === 'close' || cmd === 'toggle') {
        post('nestled:' + cmd);
      }
    }
    var queued = window.Nestled && window.Nestled.q ? window.Nestled.q : [];
    window.Nestled = function () {
      handle.apply(null, arguments);
    };
    for (var i = 0; i < queued.length; i++) handle.apply(null, queued[i]);

    // Presence (host page) → forward a proactive chat into the widget iframe so
    // it can adopt the conversation (with its token) and open.
    loadPresence(function (payload) {
      built.iframe.contentWindow.postMessage(
        {
          type: 'nestled:proactive',
          conversation_id: payload.conversation_id,
          visitor_token: payload.visitor_token,
          message: payload.message,
          agent_name: payload.agent_name,
        },
        '*',
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
