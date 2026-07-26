/**
 * Token storage for the customer app.
 *
 * One key, one shape, one place that knows the storage format — so a future
 * change to how sessions are held (a cookie, a worker, an in-memory-only mode)
 * touches this file and nothing else.
 *
 * The ops panel deliberately uses a DIFFERENT key. A staff member logged into
 * both surfaces in one browser must not have the two sessions bleed into each
 * other, and keeping the keys apart makes that structural rather than careful.
 */

const KEY = 'nestled.auth.v1';

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Epoch ms, decoded from the access token — not sent by the server. */
  expires_at: number;
}

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

let cached: Session | null | undefined;

/**
 * Read `exp` out of a JWT without verifying it.
 *
 * The client is not the authority on whether a token is valid — the server is.
 * All this buys is knowing when to refresh *before* a request fails, which turns
 * the common case from "401, refresh, retry" into a single request.
 */
function expiryOf(accessToken: string): number {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function getSession(): Session | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setSession(tokens: { access_token: string; refresh_token: string } | null): void {
  if (!tokens) {
    cached = null;
    localStorage.removeItem(KEY);
  } else {
    cached = { ...tokens, expires_at: expiryOf(tokens.access_token) };
    localStorage.setItem(KEY, JSON.stringify(cached));
  }
  for (const fn of listeners) fn(cached);
}

/** Subscribe to sign-in / sign-out, including from another tab. */
export function onSessionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Cross-tab sync. Signing out in one tab must sign out the others, or the second
 * tab keeps making requests with a revoked refresh token and produces a stream of
 * 401s the user cannot explain.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    cached = undefined;
    const next = getSession();
    for (const fn of listeners) fn(next);
  });
}

/** True when the access token is within `skewMs` of expiring (or already has). */
export function isExpiring(session: Session, skewMs = 60_000): boolean {
  return !session.expires_at || session.expires_at - Date.now() < skewMs;
}
