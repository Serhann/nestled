/*
 * JetChat embed (Phase 4). Loads asynchronously and never blocks or style-leaks
 * into the host page.
 *
 * THE FIX for the old click-swallowing bug: instead of a full-viewport
 * transparent iframe with pointer-events hacks, the iframe is sized to exactly
 * what's visible. Closed → a ~76×76 launcher that covers only the button; open →
 * resized to the chat panel. The widget inside postMessages its desired size, so
 * the rest of the host page's bottom-right corner is always clickable.
 *
 * Configure via the script tag:
 *   <script src="https://widget.jetfood.com/embed.js"
 *           data-api-base="https://api.jetfood.com"
 *           data-position="right"></script>
 * `data-api-base` is the backend (REST + WS). The widget app is served from the
 * embed's own origin unless `data-widget-origin` overrides it.
 */
(function () {
  'use strict';
  if (window.__jetchatLoaded) return;
  window.__jetchatLoaded = true;

  var self = document.currentScript;
  var scriptOrigin = self ? new URL(self.src).origin : window.location.origin;
  var apiBase = (self && self.getAttribute('data-api-base')) || scriptOrigin;
  var widgetOrigin = (self && self.getAttribute('data-widget-origin')) || scriptOrigin;
  var position = (self && self.getAttribute('data-position')) === 'left' ? 'left' : 'right';
  // Scenario pack for this site: 'food' (default) or 'saas' (tryjet.io).
  var mode = (self && self.getAttribute('data-mode')) === 'saas' ? 'saas' : 'food';

  var LAUNCHER = 76;

  // Persistent visitor id — the same id feeds presence (host page) and the
  // widget (iframe). Namespaced by mode so two of our sites sharing one origin
  // (e.g. the local demo host at /demo and /tryjet) don't collapse into one
  // visitor. In production the sites are separate origins anyway.
  var VISITOR_KEY = 'jetchat_visitor_id_' + mode;
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
      ctx.fillText('JetChat 🚀 fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('JetChat 🚀 fp', 4, 17);
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

  // Visitor identity (Crisp's user:email / user:nickname equivalent). Sources,
  // in order: script data attributes, host URL params, and the JetChat() API.
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
    var orderId = pick('data-order-id', 'order_id');
    if (email) id.email = email;
    if (name) id.name = name;
    if (phone) id.phone = phone;
    if (userId) id.user_id = userId;
    if (orderId) id.order_id = orderId;
    return id;
  }
  var identity = readIdentity();

  // The visitor's current order context (JetFood-specific). The host site feeds
  // this so the widget can show order-aware quick actions (track / late / issue
  // with a delivered order, etc.). Sources: data-order-* attributes / URL params
  // at load, then live updates via JetChat('order', {...}).
  function readOrder() {
    var o = {};
    var params = new URLSearchParams(window.location.search);
    var pick = function (attr, param) {
      var v = (self && self.getAttribute(attr)) || params.get(param);
      return v || null;
    };
    var id = pick('data-order-id', 'order_id');
    var status = pick('data-order-status', 'order_status');
    var eta = pick('data-order-eta', 'order_eta');
    var restaurant = pick('data-order-restaurant', 'order_restaurant');
    var url = pick('data-order-url', 'order_url');
    var total = pick('data-order-total', 'order_total');
    if (id) o.id = id;
    if (status) o.status = status;
    if (eta) o.eta = eta;
    if (restaurant) o.restaurant = restaurant;
    if (url) o.url = url;
    if (total) o.total = total;
    return o;
  }
  var order = readOrder();

  // Signed visitor context (JWT) — the host's server (e.g. JetFood PHP) signs the
  // logged-in customer + orders and hands us the token. It is verified server-side
  // with the site's shared secret, so the data is trusted (not spoofable). Sources:
  // data-context attribute, window.JetChatContext global, or JetChat('context', token).
  function readContextToken() {
    var t = (self && self.getAttribute('data-context')) || window.JetChatContext || '';
    return typeof t === 'string' ? t : '';
  }
  var contextToken = readContextToken();

  function identityParams() {
    var p = '';
    if (identity.email) p += '&ue=' + encodeURIComponent(identity.email);
    if (identity.name) p += '&un=' + encodeURIComponent(identity.name);
    if (identity.phone) p += '&up=' + encodeURIComponent(identity.phone);
    if (identity.user_id) p += '&uid=' + encodeURIComponent(identity.user_id);
    if (identity.order_id) p += '&oid=' + encodeURIComponent(identity.order_id);
    if (order.id) p += '&o_id=' + encodeURIComponent(order.id);
    if (order.status) p += '&o_status=' + encodeURIComponent(order.status);
    if (order.eta) p += '&o_eta=' + encodeURIComponent(order.eta);
    if (order.restaurant) p += '&o_rest=' + encodeURIComponent(order.restaurant);
    if (order.url) p += '&o_url=' + encodeURIComponent(order.url);
    if (order.total) p += '&o_total=' + encodeURIComponent(order.total);
    return p;
  }

  function build() {
    var container = document.createElement('div');
    container.id = 'jetchat-container';
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
    iframe.id = 'jetchat-iframe';
    iframe.title = 'Chat';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.src =
      widgetOrigin +
      '/chat?api=' +
      encodeURIComponent(apiBase) +
      '&vid=' +
      encodeURIComponent(visitorId) +
      '&fp=' +
      encodeURIComponent(fingerprint) +
      '&pos=' +
      position +
      '&mode=' +
      mode +
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

  function loadPresence(onProactive) {
    var apply = function () {
      if (window.JetChatPresence) {
        window.JetChatPresence.init({
          apiBase: apiBase,
          visitorId: visitorId,
          fingerprint: fingerprint,
          mode: mode,
          onProactive: onProactive,
          // rrweb recorder is served from the widget origin (host-page context).
          recordScriptUrl: widgetOrigin + '/vendor/rrweb-record.min.js',
        });
      }
    };
    if (window.JetChatPresence) return apply();
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
      if (data && data.type === 'jetchat:resize') resize(built, data);
    });

    // Public JS API: JetChat('identify', { email, name, user_id, order_id, ... })
    // — the runtime equivalent of Crisp's user:email push, for post-login apps.
    function handle(cmd, payload) {
      if (cmd === 'identify' && payload && typeof payload === 'object') {
        for (var k in payload) if (payload[k] != null) identity[k] = payload[k];
        built.iframe.contentWindow.postMessage({ type: 'jetchat:identify', traits: payload }, '*');
      } else if (cmd === 'order' && payload && typeof payload === 'object') {
        // Live order update from the host site (status changed, delivered, …).
        for (var ok in payload) if (payload[ok] != null) order[ok] = payload[ok];
        built.iframe.contentWindow.postMessage({ type: 'jetchat:order', order: payload }, '*');
      } else if (cmd === 'orders' && Array.isArray(payload)) {
        // Full list of the visitor's recent orders (drives the order picker).
        built.iframe.contentWindow.postMessage({ type: 'jetchat:orders', orders: payload }, '*');
      } else if (cmd === 'context' && typeof payload === 'string') {
        // Signed context token issued/refreshed at runtime (e.g. after login).
        contextToken = payload;
        built.iframe.contentWindow.postMessage({ type: 'jetchat:context', token: payload }, '*');
      }
    }
    var queued = window.JetChat && window.JetChat.q ? window.JetChat.q : [];
    window.JetChat = function () {
      handle.apply(null, arguments);
    };
    for (var i = 0; i < queued.length; i++) handle.apply(null, queued[i]);

    // Presence (host page) → forward a proactive chat into the widget iframe so
    // it can adopt the conversation (with its token) and open.
    loadPresence(function (payload) {
      built.iframe.contentWindow.postMessage(
        {
          type: 'jetchat:proactive',
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
