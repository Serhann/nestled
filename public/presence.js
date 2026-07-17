/*
 * JetChat host-page presence client (Phase 3).
 *
 * Runs in the HOST PAGE context (jetfood.com), not inside the widget iframe, so
 * it can report every visitor — including anonymous ones who never open the
 * chat. It opens a WebSocket to the backend, announces the visitor, heartbeats,
 * tracks SPA navigation, and listens for a proactive "open the chat" push from
 * an agent.
 *
 * Usage (Phase 4's embed will call this):
 *   JetChatPresence.init({
 *     apiBase: 'https://api.jetfood.com',
 *     onProactive: ({ conversation_id, visitor_token, message, agent_name }) => {  ...open widget... },
 *   });
 * Or drop it in with data attributes:
 *   <script src="/presence.js" data-api-base="https://api.jetfood.com"></script>
 */
(function () {
  'use strict';

  var HEARTBEAT_MS = 25000;
  var VISITOR_KEY = 'jetchat_visitor_id';
  var RETURNING_KEY = 'jetchat_returning';

  function getVisitorId() {
    try {
      var id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id =
          'v_' +
          Date.now().toString(36) +
          '_' +
          Math.random().toString(36).slice(2, 10);
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch (e) {
      // Private mode / storage blocked — fall back to a per-session id.
      return 'v_ephemeral_' + Math.random().toString(36).slice(2, 12);
    }
  }

  function isReturning() {
    try {
      var was = localStorage.getItem(RETURNING_KEY) === '1';
      localStorage.setItem(RETURNING_KEY, '1');
      return was;
    } catch (e) {
      return false;
    }
  }

  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
  }

  function collectUtm() {
    var utm = {};
    try {
      var params = new URLSearchParams(window.location.search);
      params.forEach(function (value, key) {
        if (key.indexOf('utm_') === 0) utm[key] = value;
      });
    } catch (e) {
      /* ignore */
    }
    return utm;
  }

  function wsBaseFrom(apiBase) {
    return apiBase.replace(/^http/, 'ws');
  }

  function init(options) {
    options = options || {};
    var apiBase = (options.apiBase || '').replace(/\/$/, '');
    if (!apiBase) {
      console.error('JetChatPresence: apiBase is required');
      return;
    }
    var onProactive = typeof options.onProactive === 'function' ? options.onProactive : null;
    var recordScriptUrl = options.recordScriptUrl || null; // rrweb-record UMD, host origin

    // Prefer a shared visitor id (the embed passes the same one to the widget
    // iframe) so presence, conversations, and proactive all agree on identity.
    var visitorId = options.visitorId || getVisitorId();
    var sessionStart = Date.now();
    var returning = isReturning();
    var ws = null;
    var heartbeatTimer = null;
    var reconnectDelay = 1000;
    var closed = false;

    function hello() {
      return JSON.stringify({
        type: 'hello',
        url: window.location.href,
        referrer: document.referrer || null,
        utm: collectUtm(),
        device: isMobile() ? 'mobile' : 'desktop',
        screen: { w: window.screen.width, h: window.screen.height },
        returning: returning,
        sessionStart: sessionStart,
      });
    }

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function sendNavigation() {
      send({ type: 'update', url: window.location.href, utm: collectUtm() });
    }

    function connect() {
      if (closed) return;
      ws = new WebSocket(wsBaseFrom(apiBase) + '/ws/presence?visitor_id=' + encodeURIComponent(visitorId));

      ws.onopen = function () {
        reconnectDelay = 1000;
        ws.send(hello());
        heartbeatTimer = setInterval(function () {
          send({ type: 'ping' });
        }, HEARTBEAT_MS);
      };

      ws.onmessage = function (event) {
        var data;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (data && data.type === 'proactive') {
          // Let the widget adopt the conversation and open itself.
          if (onProactive) onProactive(data);
          window.dispatchEvent(new CustomEvent('jetchat:proactive', { detail: data }));
        }
      };

      ws.onclose = function () {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (closed) return;
        // Reconnect with capped backoff so a brief drop doesn't lose presence.
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };

      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      };
    }

    // Track SPA navigation: patch pushState/replaceState + listen to popstate.
    function patchHistory() {
      var wrap = function (method) {
        var original = history[method];
        history[method] = function () {
          var result = original.apply(this, arguments);
          sendNavigation();
          return result;
        };
      };
      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', sendNavigation);
    }

    connect();
    patchHistory();
    maybeStartRecording();

    // ── MagicBrowse: record the HOST page (off by default; server-gated). ──
    function maybeStartRecording() {
      if (!recordScriptUrl) return;
      fetch(apiBase + '/api/widget-config')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.settings && d.settings.magic_browse_enabled) startRecording();
        })
        .catch(function () {});
    }

    function startRecording() {
      var run = function () {
        var record = window.rrwebRecord;
        if (typeof record !== 'function') return;
        var buffer = [];
        // Privacy: mask every input, and block payment/PII containers, our own
        // iframe, and anything the site marks data-jetchat-block.
        record({
          emit: function (event) { buffer.push(event); },
          maskAllInputs: true,
          blockSelector: 'iframe,[data-jetchat-block],.jetchat-block,[data-cc],[autocomplete*="cc-"]',
          maskTextSelector: '[data-jetchat-mask],[name*="card"],[name*="cvc"],[name*="cvv"],[name*="ssn"]',
          checkoutEveryNms: 5000, // periodic full snapshot for late viewers
        });
        // Batch flush every 3s to budget bandwidth.
        setInterval(function () {
          if (buffer.length === 0) return;
          var batch = buffer.splice(0, buffer.length);
          send({ type: 'rrweb', events: batch });
        }, 3000);
      };
      if (window.rrwebRecord) return run();
      var s = document.createElement('script');
      s.src = recordScriptUrl;
      s.async = true;
      s.onload = run;
      document.head.appendChild(s);
    }

    return {
      stop: function () {
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (ws) ws.close();
      },
      visitorId: visitorId,
    };
  }

  var api = { init: init };
  window.JetChatPresence = api;

  // Auto-init from the script tag's data attributes, if present.
  var self = document.currentScript;
  if (self && self.getAttribute('data-api-base')) {
    init({ apiBase: self.getAttribute('data-api-base') });
  }
})();
