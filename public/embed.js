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

  var LAUNCHER = 76;

  // Persistent, shared visitor id — the same id feeds presence (host page) and
  // the widget (iframe), so identity is consistent across origins.
  function getVisitorId() {
    try {
      var id = localStorage.getItem('jetchat_visitor_id');
      if (!id) {
        id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('jetchat_visitor_id', id);
      }
      return id;
    } catch (e) {
      return 'v_ephemeral_' + Math.random().toString(36).slice(2, 12);
    }
  }
  var visitorId = getVisitorId();

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
      '&pos=' +
      position +
      // Host page URL, so the widget can evaluate page-based triggers.
      '&href=' +
      encodeURIComponent(window.location.href) +
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

  function resize(container, msg) {
    var mobileFull = window.innerWidth <= 480 && msg.state === 'open';
    if (mobileFull) {
      container.style.width = 'calc(100vw - 24px)';
      container.style.height = 'calc(100vh - 24px)';
    } else {
      container.style.width = (msg.width || LAUNCHER) + 'px';
      container.style.height = (msg.height || LAUNCHER) + 'px';
    }
  }

  function loadPresence(onProactive) {
    var apply = function () {
      if (window.JetChatPresence) {
        window.JetChatPresence.init({
          apiBase: apiBase,
          visitorId: visitorId,
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
      if (data && data.type === 'jetchat:resize') resize(built.container, data);
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
