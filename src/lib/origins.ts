/**
 * Where each surface lives.
 *
 * In production the four surfaces are separate origins:
 *
 *   nestled.chat          marketing
 *   app.nestled.chat      the customer panel
 *   ops.nestled.chat      the platform panel
 *   widget.nestled.chat   the visitor widget
 *
 * Putting the widget on its own origin is a security decision, not a deployment
 * preference: the app's tokens live in the app origin's storage, so a widget
 * running inside a customer's page physically cannot read them.
 *
 * In development everything collapses onto localhost:5173 behind path prefixes
 * (`/app`, `/ops`, `/widget`), which is why no other module may hardcode a path —
 * one wrong literal and a link works locally and 404s in production.
 */

const dev = import.meta.env.DEV;

/** Same-origin in production (nginx proxies /api); Vite proxies it in dev. */
export const API_BASE = '';

/** Absolute base of each surface, usable in an href from any other surface. */
export const ORIGINS = {
  marketing: dev ? '/' : 'https://nestled.chat',
  app: dev ? '/app' : 'https://app.nestled.chat',
  ops: dev ? '/ops' : 'https://ops.nestled.chat',
  widget: dev ? '/widget' : 'https://widget.nestled.chat',
} as const;

/**
 * The app's router basename. react-router needs to know that `/app` is not part
 * of any route — in production it is a bare origin and the basename is empty.
 */
export const APP_BASENAME = dev ? '/app' : '';
export const OPS_BASENAME = dev ? '/ops' : '';

/** A path inside the customer app, absolute enough to use across surfaces. */
export function appUrl(path: string): string {
  const base = ORIGINS.app.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The embed snippet we show customers, pointing at wherever the widget is served. */
export function embedScriptUrl(): string {
  return dev ? `${window.location.origin}/embed.js` : `${ORIGINS.widget}/embed.js`;
}

/** The WebSocket origin. Same host as the API, ws:// or wss:// to match the page. */
export function wsOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}
