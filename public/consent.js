/**
 * Cookie consent for the marketing site.
 *
 * ── Why this file exists at all, and only here ────────────────────────────────
 *
 * It is loaded by scripts/analytics-runtime.sh, in the same injection that adds the Google
 * tag, so the banner and the thing it asks about cannot come apart. An environment with no
 * GA_MEASUREMENT_ID gets neither — which is the correct behaviour and not an oversight: a
 * cookie notice on a site that sets no cookies is theatre, and asking for permission you do
 * not need teaches people to click through the ones that matter.
 *
 * ── Why plain JS in public/ rather than a React island ────────────────────────
 *
 * Five of the six marketing pages never load React. scripts/prerender.mjs even strips the
 * modulepreload hints from them, because 3.4 KB of framework runtime that never executes was
 * most of the reason to prerender in the first place. Mounting a component for a banner would
 * hand that back, on the page people arrive on, to render two buttons. So: no framework, no
 * Tailwind (this file is outside the content globs in tailwind.config.js, so its classes would
 * be purged), and the design tokens are repeated as literals below.
 *
 * ── The choices that are legal requirements, not taste ────────────────────────
 *
 * Analytics storage defaults to DENIED, and nothing is granted until somebody says so. That
 * default is set in the inline snippet rather than here, because it has to be in place before
 * `gtag('config', …)` runs and this file is deferred — see analytics-runtime.sh.
 *
 * "Decline" is the same size, weight and colour as "Accept". Consent has to be as easy to
 * refuse as to give, and a greyed-out reject button next to a bright accept one is the
 * specific pattern regulators have been fining people for.
 *
 * Withdrawal is equally easy: any element with `data-consent-reopen` (the privacy page has
 * one) is revealed and wired up to bring the banner back.
 */
(function () {
  'use strict';

  var STORE_KEY = 'nestled.consent';
  var PANEL_ID = 'nestled-consent';

  /**
   * localStorage throws rather than returning null in a handful of real configurations —
   * Safari with cookies blocked, an iframe with third-party storage denied, a browser with
   * storage full. Every access is wrapped, and the fallback is to behave as though no
   * decision has been recorded: the banner shows again, which is the honest outcome. Better
   * to ask twice than to assume a consent nobody gave.
   */
  function read() {
    try {
      return window.localStorage.getItem(STORE_KEY);
    } catch (e) {
      return null;
    }
  }

  function write(value) {
    try {
      window.localStorage.setItem(STORE_KEY, value);
    } catch (e) {
      /* Not fatal. The decision applies to this page load and we ask again next time. */
    }
  }

  /**
   * Tell Consent Mode what was decided.
   *
   * `denied` is sent explicitly rather than skipped. It matters for the visitor who accepted
   * last month and is declining now: the default at the top of the page was `granted` from
   * storage, and only an update walks that back.
   *
   * Ad storage stays denied in both branches. We run no advertising, and declaring the v2
   * signals rather than omitting them is what stops the tag from inferring anything.
   */
  function apply(granted) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: granted ? 'granted' : 'denied',
    });
  }

  function decide(granted) {
    write(granted ? 'granted' : 'denied');
    apply(granted);
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  var STYLES = [
    /* Fixed, so the banner cannot contribute to layout shift on the page it covers. */
    '#' + PANEL_ID + '{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;',
    'background:#fffcf7;border-top:1px solid #dcd3c4;',
    'box-shadow:0 -4px 24px rgba(32,30,29,.10);',
    "font-family:Figtree,ui-rounded,'Segoe UI',system-ui,-apple-system,sans-serif;",
    'padding:16px 20px;',
    /* Respect a phone's home-bar inset; without it the buttons sit under it on iOS. */
    'padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));}',

    '#' + PANEL_ID + ' .nc-in{max-width:72rem;margin:0 auto;display:flex;flex-wrap:wrap;',
    'align-items:center;gap:12px 20px;}',

    '#' + PANEL_ID + ' p{margin:0;flex:1 1 20rem;font-size:13.5px;line-height:1.55;color:#474238;}',
    '#' + PANEL_ID + ' a{color:#8c491a;text-decoration:underline;}',

    '#' + PANEL_ID + ' .nc-btns{display:flex;gap:10px;flex:0 0 auto;}',

    /* Identical geometry and typography for both buttons. Only the fill differs, and both
       fills are brand colours at full strength — neither is a de-emphasised outline. */
    '#' + PANEL_ID + ' button{font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;',
    'border-radius:9999px;padding:9px 20px;border:1px solid transparent;',
    'transition:background-color .15s,border-color .15s;}',
    '#' + PANEL_ID + ' button:focus-visible{outline:2px solid #c67139;outline-offset:2px;}',

    '#' + PANEL_ID + ' .nc-yes{background:#c67139;color:#fffcf7;}',
    '#' + PANEL_ID + ' .nc-yes:hover{background:#8c491a;}',
    '#' + PANEL_ID + ' .nc-no{background:#eee7db;color:#474238;border-color:#dcd3c4;}',
    '#' + PANEL_ID + ' .nc-no:hover{background:#dcd3c4;}',

    '@media (prefers-reduced-motion:reduce){#' + PANEL_ID + ' button{transition:none;}}',
  ].join('');

  function show() {
    if (document.getElementById(PANEL_ID)) return;

    if (!document.getElementById(PANEL_ID + '-css')) {
      var style = document.createElement('style');
      style.id = PANEL_ID + '-css';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    /* `region`, not `dialog`: this does not trap focus and the page stays usable behind it.
       A modal dialog would be a stronger claim than the situation warrants. */
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Cookie notice');

    var inner = document.createElement('div');
    inner.className = 'nc-in';

    var text = document.createElement('p');
    /* Kept to two sentences deliberately. At five lines it covered a quarter of a phone
       screen, and a wall of text in front of a decision is how people learn to click the
       nearest button without reading. The full explanation is on the page linked below. */
    text.appendChild(
      document.createTextNode(
        'We count visits to this website with Google Analytics, which sets one cookie. ' +
          'Nothing is used for advertising, and declining changes nothing. ',
      ),
    );
    var link = document.createElement('a');
    link.href = '/privacy';
    link.textContent = 'What we collect';
    text.appendChild(link);
    text.appendChild(document.createTextNode('.'));

    var buttons = document.createElement('div');
    buttons.className = 'nc-btns';

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'nc-no';
    no.textContent = 'Decline';
    no.addEventListener('click', function () {
      decide(false);
    });

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'nc-yes';
    yes.textContent = 'Accept';
    yes.addEventListener('click', function () {
      decide(true);
    });

    /* Decline first in the DOM, so it is also first in the tab order. */
    buttons.appendChild(no);
    buttons.appendChild(yes);
    inner.appendChild(text);
    inner.appendChild(buttons);
    panel.appendChild(inner);
    document.body.appendChild(panel);
  }

  /**
   * The withdrawal path. The control is rendered hidden and revealed here, so a page served
   * by an environment WITHOUT analytics — where this file is never loaded — does not offer a
   * button that would do nothing.
   */
  function wireReopen() {
    var controls = document.querySelectorAll('[data-consent-reopen]');
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      control.removeAttribute('hidden');
      /* The marked element is a wrapper carrying the surrounding sentence punctuation; the
         clickable thing is the button inside it. Falling back to the wrapper keeps this
         working if a future page marks a bare button directly. */
      var target = control.querySelector('button') || control;
      target.addEventListener('click', function (event) {
        event.preventDefault();
        show();
      });
    }
  }

  wireReopen();

  /* A recorded decision of either kind means no banner. The inline snippet has already
     applied a stored `granted` as the Consent Mode default, so there is nothing to re-send. */
  if (read() === null) show();
})();
