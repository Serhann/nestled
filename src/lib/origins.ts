/**
 * Where each surface lives — worked out at runtime, from the URL in the address
 * bar.
 *
 * Nestled has four surfaces and two ways to serve them:
 *
 *   SUBDOMAIN   app.example.com   ops.example.com   widget.example.com   example.com
 *   PATH        example.com/app   example.com/ops   example.com/widget   example.com
 *
 * Both are legitimate. Subdomains are the safer layout — the widget runs inside
 * a customer's page, and a separate origin means it physically cannot read the
 * agent tokens in the app's localStorage. The path layout needs only ONE domain,
 * which is what most people have when they first deploy.
 *
 * Deciding between them at runtime rather than at build time is what lets one
 * image serve either. The alternative — baking the origins in with build args —
 * means the container is wrong the moment somebody moves it, and wrong in a way
 * that shows up as a broken link in an email days later.
 *
 * The detection is the leading DNS label, so no configuration is needed and any
 * domain works: `app.` anything is the app, `ops.` anything is the ops panel.
 */

const dev = import.meta.env.DEV;

/** Same-origin: nginx proxies /api and /ws to the backend. */
export const API_BASE = '';

type Surface = 'marketing' | 'app' | 'ops' | 'widget';

/** Which surface the current document is, from its own hostname or path. */
function currentSurface(): { surface: Surface; subdomain: boolean; base: string } {
  if (typeof window === 'undefined') {
    // Prerendering the marketing site: there is no address bar. The links it
    // emits are relative, so the path layout is the correct assumption.
    return { surface: 'marketing', subdomain: false, base: '' };
  }

  const { hostname, pathname, origin } = window.location;
  const label = hostname.split('.')[0];

  if ((label === 'app' || label === 'ops' || label === 'widget') && hostname.includes('.')) {
    return {
      surface: label as Surface,
      subdomain: true,
      // Everything after the leading label — the domain the surfaces share.
      base: hostname.slice(label.length + 1),
    };
  }

  const prefix = pathname.split('/')[1];
  if (prefix === 'app' || prefix === 'ops' || prefix === 'widget') {
    return { surface: prefix as Surface, subdomain: false, base: origin };
  }
  return { surface: 'marketing', subdomain: false, base: origin };
}

const current = currentSurface();

/**
 * Absolute-enough bases for the other surfaces, usable in an href from any of
 * them. In the path layout these stay relative, which keeps them correct on
 * localhost, behind a tunnel, and on whatever domain someone actually used.
 */
export const ORIGINS: Record<Surface, string> = current.subdomain
  ? {
      marketing: `${window.location.protocol}//${current.base}`,
      app: `${window.location.protocol}//app.${current.base}`,
      ops: `${window.location.protocol}//ops.${current.base}`,
      widget: `${window.location.protocol}//widget.${current.base}`,
    }
  : { marketing: '/', app: '/app', ops: '/ops', widget: '/widget' };

/**
 * The router basename.
 *
 * On a subdomain the app owns `/`, so there is none. Under a path prefix the
 * router has to be told that `/app` is not part of any route — get this wrong
 * and every deep link renders the not-found page while nginx happily returns
 * 200, which is a confusing afternoon.
 */
export const APP_BASENAME = current.subdomain ? '' : '/app';
export const OPS_BASENAME = current.subdomain ? '' : '/ops';

/** A path inside the customer app, absolute enough to use across surfaces. */
export function appUrl(path: string): string {
  const base = ORIGINS.app.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The embed snippet's script URL.
 *
 * Always absolute: it is pasted into someone else's HTML, where a relative path
 * would resolve against THEIR domain and 404.
 */
export function embedScriptUrl(): string {
  if (typeof window === 'undefined') return 'https://widget.nestled.chat/embed.js';
  return current.subdomain
    ? `${ORIGINS.widget}/embed.js`
    : `${window.location.origin}/embed.js`;
}

/** The WebSocket origin. Same host as the API, ws:// or wss:// to match the page. */
export function wsOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/** True in `npm run dev`, where Vite serves every surface under one port. */
export const IS_DEV = dev;
