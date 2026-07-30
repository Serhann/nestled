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
 *
 * ── Two stores, because an impersonated session is not the same kind of thing ──
 *
 * A normal session belongs to the BROWSER: localStorage, shared across tabs, surviving a
 * restart. An impersonated one belongs to ONE TAB, and putting it in localStorage would
 * have three consequences nobody asks for — the support agent's own account signed out of
 * every other tab, the borrowed session outliving the tab it was opened in, and a
 * staff-minted credential for somebody else's account left on disk after the window
 * closed.
 *
 * So impersonation writes to sessionStorage, which is per-tab by definition, and the
 * reader prefers it. Closing the tab ends the impersonation locally; the agent's own
 * session in the next tab never noticed.
 */

const KEY = 'nestled.auth.v1';
/** Per-tab, for a borrowed session. See the note above. */
const EPHEMERAL_KEY = 'nestled.auth.impersonation.v1';

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Epoch ms, decoded from the access token — not sent by the server. */
  expires_at: number;
  /**
   * True for a staff-minted impersonated session. Not something the client relies on for
   * anything security-relevant — the server decides that from the token's `act` claim —
   * only for knowing which store to write to and that there is nothing to refresh.
   */
  impersonated?: boolean;
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
    // The tab-scoped one wins. Inside an impersonation tab it is the only session the app
    // should see, even though the agent's own is sitting in localStorage next to it.
    const ephemeral = sessionStorage.getItem(EPHEMERAL_KEY);
    if (ephemeral) {
      cached = JSON.parse(ephemeral) as Session;
      return cached;
    }
    const raw = localStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setSession(
  tokens: { access_token: string; refresh_token: string | null } | null,
  options?: { impersonated?: boolean },
): void {
  if (!tokens) {
    cached = null;
    // Both. Signing out of a borrowed session must not leave it behind, and signing out
    // normally must not leave a borrowed one live.
    sessionStorage.removeItem(EPHEMERAL_KEY);
    localStorage.removeItem(KEY);
  } else {
    cached = {
      access_token: tokens.access_token,
      // An impersonated session has none, by design on the server. Empty string rather
      // than null keeps the stored shape stable for every existing reader.
      refresh_token: tokens.refresh_token ?? '',
      expires_at: expiryOf(tokens.access_token),
      ...(options?.impersonated ? { impersonated: true } : {}),
    };
    if (options?.impersonated) sessionStorage.setItem(EPHEMERAL_KEY, JSON.stringify(cached));
    else localStorage.setItem(KEY, JSON.stringify(cached));
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
    // `storage` never fires for sessionStorage, which is the point — but an impersonation
    // tab must also ignore the agent signing in or out elsewhere, or a borrowed session
    // would be swapped for their own mid-use.
    if (sessionStorage.getItem(EPHEMERAL_KEY)) return;
    cached = undefined;
    const next = getSession();
    for (const fn of listeners) fn(next);
  });
}

/** True when the access token is within `skewMs` of expiring (or already has). */
export function isExpiring(session: Session, skewMs = 60_000): boolean {
  return !session.expires_at || session.expires_at - Date.now() < skewMs;
}
