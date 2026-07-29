/*
 * Nestled host-page presence client.
 *
 * Runs in the HOST PAGE context (the customer's own site), not inside the widget iframe, so
 * it can report every visitor — including anonymous ones who never open the
 * chat. It opens a WebSocket to the backend, announces the visitor, heartbeats,
 * tracks SPA navigation, and listens for a proactive "open the chat" push from
 * an agent.
 *
 * AUTHENTICATION. The socket takes a signed WIDGET SESSION token, minted by
 * embed.js from the website's public key, and the server reads the visitor id
 * and website OUT OF THAT TOKEN. It used to accept `?visitor_id=` from anyone,
 * which combined with the proactive frame's payload was a full conversation
 * takeover — see server/src/test/presenceSecurity.test.ts.
 *
 * Usage (embed.js does this):
 *   NestledPresence.init({
 *     apiBase: 'https://api.nestled.chat',
 *     sessionToken: '<signed widget session>',
 *     onProactive: ({ conversation_id, claim_token, message, agent_name }) => { ... },
 *   });
 */
(function () {
  'use strict';

  var HEARTBEAT_MS = 25000;
  var RETURNING_KEY = 'nestled_returning';

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

  function timezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  function wsBaseFrom(apiBase) {
    return apiBase.replace(/^http/, 'ws');
  }

  function init(options) {
    options = options || {};
    var apiBase = (options.apiBase || '').replace(/\/$/, '');
    var sessionToken = options.sessionToken || '';
    if (!apiBase || !sessionToken) {
      console.error('NestledPresence: apiBase and sessionToken are required');
      return;
    }
    var onProactive = typeof options.onProactive === 'function' ? options.onProactive : null;
    var recordScriptUrl = options.recordScriptUrl || null; // rrweb-record UMD, host origin
    // Session replay is expensive to buffer and is plan-gated server-side; until
    // /boot exposes `live_view_enabled` there is nothing here to switch it on.
    var record = options.record === true;

    var fingerprint = options.fingerprint || ''; // cross-site device hash (embed-supplied)
    var contextToken = options.contextToken || ''; // signed host context (embed-supplied)
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
        fingerprint: fingerprint,
        context_token: contextToken,
        // Client hints so the Live Visitors card matches the conversation
        // sidebar (browser · OS, language, timezone) with no chat needed.
        user_agent: navigator.userAgent,
        language: navigator.language || null,
        timezone: timezone(),
      });
    }

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    // ── Live Assist overlay ──────────────────────────────────────────────────
    // Renders the agent's guiding pointer/click on this page (view-only; never
    // runs host code). Coordinates are viewport (fixed) positions matching what
    // the agent sees. A watchdog tears the overlay down if the agent goes quiet.
    var assist = { root: null, cursor: null, banner: null, watchdog: null };
    // Set once rrweb is actually running; null means "not recording", which is the
    // normal state for every website that has not switched live view on.
    var onSnapshotRequest = null;

    function assistTeardown() {
      if (assist.watchdog) { clearTimeout(assist.watchdog); assist.watchdog = null; }
      if (assist.root && assist.root.parentNode) assist.root.parentNode.removeChild(assist.root);
      assist.root = assist.cursor = assist.banner = null;
    }

    function assistEnsure(agentName) {
      if (assist.root) return;
      var root = document.createElement('div');
      root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden');

      var banner = document.createElement('div');
      banner.setAttribute('style', 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#c67139;color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:9px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;align-items:center;gap:8px;white-space:nowrap');
      banner.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#a7f3d0;box-shadow:0 0 0 3px rgba(167,243,208,.35);display:inline-block"></span>' +
        (agentName ? String(agentName).replace(/[<>&]/g, '') : 'An agent') + ' is helping you';

      var cursor = document.createElement('div');
      cursor.setAttribute('style', 'position:fixed;left:0;top:0;transform:translate(-4px,-2px);transition:left .08s linear,top .08s linear;opacity:0;will-change:left,top');
      cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M4 2l6 15 2.3-6.2L18.5 8 4 2z" fill="#c67139" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
        '<span style="position:absolute;left:22px;top:14px;background:#c67139;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:3px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2)">' +
        (agentName ? String(agentName).replace(/[<>&]/g, '') : 'Agent') + '</span>';

      root.appendChild(banner);
      root.appendChild(cursor);
      document.body.appendChild(root);
      assist.root = root; assist.cursor = cursor; assist.banner = banner;
    }

    function assistBump() {
      if (assist.watchdog) clearTimeout(assist.watchdog);
      assist.watchdog = setTimeout(assistTeardown, 15000);
    }

    function assistRipple(x, y) {
      if (!assist.root) return;
      var r = document.createElement('div');
      r.setAttribute('style', 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #c67139;background:rgba(198,113,57,.25);pointer-events:none;animation:jc-assist-ripple .6s ease-out forwards');
      assist.root.appendChild(r);
      setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 650);
    }

    // Normalised (0..1) coords → this window's live viewport pixels. Using
    // innerWidth/innerHeight (not the recorded size) keeps the pointer aligned
    // regardless of any record-time vs now viewport difference.
    function denorm(data) {
      var nx = typeof data.nx === 'number' ? data.nx : 0;
      var ny = typeof data.ny === 'number' ? data.ny : 0;
      return { x: Math.round(nx * window.innerWidth), y: Math.round(ny * window.innerHeight) };
    }

    function handleAssist(data) {
      var kind = data.kind;
      if (kind === 'stop') { assistTeardown(); return; }
      assistEnsure(data.agent);
      assistBump();
      if (kind === 'pointer') {
        if (!assist.cursor) return;
        var p = denorm(data);
        assist.cursor.style.opacity = '1';
        assist.cursor.style.left = p.x + 'px';
        assist.cursor.style.top = p.y + 'px';
      } else if (kind === 'click') {
        var c = denorm(data);
        if (assist.cursor) { assist.cursor.style.opacity = '1'; assist.cursor.style.left = c.x + 'px'; assist.cursor.style.top = c.y + 'px'; }
        assistRipple(c.x, c.y);
      } else if (kind === 'hide') {
        if (assist.cursor) assist.cursor.style.opacity = '0';
      }
    }

    // Ripple keyframes (injected once).
    if (!document.getElementById('jc-assist-style')) {
      var st = document.createElement('style');
      st.id = 'jc-assist-style';
      st.textContent = '@keyframes jc-assist-ripple{from{transform:scale(1);opacity:1}to{transform:scale(3.4);opacity:0}}';
      document.head.appendChild(st);
    }

    function sendNavigation() {
      send({ type: 'update', url: window.location.href, utm: collectUtm() });
    }

    function connect() {
      if (closed) return;
      ws = new WebSocket(wsBaseFrom(apiBase) + '/ws/presence?token=' + encodeURIComponent(sessionToken));

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
          window.dispatchEvent(new CustomEvent('nestled:proactive', { detail: data }));
        } else if (data && data.type === 'assist') {
          // Live Assist: an agent is guiding this visitor's screen.
          handleAssist(data);
        } else if (data && data.type === 'replay:snapshot') {
          // An agent just started watching. No-op unless we are recording.
          if (onSnapshotRequest) onSnapshotRequest();
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

    // ── Live view: record the HOST page (off unless explicitly enabled). ──
    function maybeStartRecording() {
      if (recordScriptUrl && record) startRecording();
    }

    function startRecording() {
      var run = function () {
        var recorder = window.rrwebRecord;
        if (typeof recorder !== 'function') return;
        var buffer = [];
        var flush = function () {
          if (buffer.length === 0) return;
          send({ type: 'rrweb', events: buffer.splice(0, buffer.length) });
        };
        // Privacy: mask every input, and block payment/PII containers, our own
        // iframe, and anything the site marks data-nestled-block.
        recorder({
          emit: function (event) { buffer.push(event); },
          maskAllInputs: true,
          blockSelector: 'iframe,[data-nestled-block],.nestled-block,[data-cc],[autocomplete*="cc-"]',
          maskTextSelector: '[data-nestled-mask],[name*="card"],[name*="cvc"],[name*="cvv"],[name*="ssn"]',
          checkoutEveryNms: 5000, // periodic full snapshot for late viewers
        });
        // Batch flush every 3s to budget bandwidth.
        setInterval(flush, 3000);

        /*
         * The server asks for this the moment an agent clicks Watch.
         *
         * Nothing is buffered server-side until then, so the first frames an agent
         * would otherwise receive are mutations against a DOM their replayer has
         * never seen — a blank screen until the 5s periodic checkout happens to
         * come round. Taking a snapshot on demand and flushing it immediately makes
         * Watch show the page straight away instead of a rectangle that looks broken.
         */
        onSnapshotRequest = function () {
          try {
            if (typeof recorder.takeFullSnapshot === 'function') recorder.takeFullSnapshot(true);
          } catch (e) {
            /* the periodic checkout still covers us */
          }
          flush();
        };
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
      /* A freshly signed host context (post-login, or any state change). Keeps
         the Live Visitors card + identified name/email current without a reload;
         the stored token is also what the next hello/reconnect carries. */
      setContext: function (token) {
        if (!token || typeof token !== 'string') return;
        contextToken = token;
        send({ type: 'context', context_token: token });
      },
      /* Unsigned session attributes — Nestled('data', {...}). Display-only on the
         agent side; anything that must be trusted goes through setContext. */
      setData: function (attributes) {
        if (!attributes || typeof attributes !== 'object') return;
        send({ type: 'data', attributes: attributes });
      },
    };
  }

  // No auto-init from data attributes any more: a session token can only be
  // minted from the website's public key, so embed.js is the only caller that
  // can supply one. A script tag on its own has nothing to authenticate with.
  window.NestledPresence = { init: init };
})();
