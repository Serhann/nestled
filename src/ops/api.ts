/**
 * The ops panel's API client and token store.
 *
 * Self-contained on purpose. This surface shares NOTHING with the customer app —
 * not a token, not a query cache, not a helper module. In production it is a
 * separate origin (ops.nestled.chat), so a customer-side XSS cannot reach a staff
 * session even in principle; importing `src/lib/api.ts` here would quietly undo
 * half of that by coupling the two surfaces' behaviour.
 */

/**
 * A distinct storage key from the customer app's, so the two never collide when a
 * developer runs both on localhost:5173. Versioned because a shape change should
 * log staff out rather than crash on a stale object.
 */
const TOKEN_KEY = 'nestled.ops.v1';

/**
 * In dev the panel is served by Vite on :5173, which proxies only `/api` and `/ws`
 * to the backend — `/platform/*` is not in that list, so requests must go directly
 * to :4000. CORS already allows http://localhost:5173. In production the panel and
 * the API share an origin behind nginx, so the base is empty.
 */
const API_BASE = import.meta.env.DEV ? 'http://localhost:4000' : '';

export interface StoredSession {
  token: string;
  expires_at: string;
  user: PlatformUser;
}

export interface PlatformUser {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'support' | 'billing' | 'readonly';
  totp_enabled: boolean;
  /** False until a TOTP factor is enrolled — the panel renders read-only. */
  can_write: boolean;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    // An expired token is worse than no token: it produces a 401 on first paint
    // and a login screen that looks like a bug.
    if (new Date(parsed.expires_at).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the bearer header — only the login call needs this. */
  anonymous?: boolean;
}

/**
 * One request function for the whole panel.
 *
 * A 401 clears the stored session and reloads rather than trying to refresh:
 * there is no refresh token on this plane by design (see server auth/tokens.ts),
 * so "expired" and "revoked" both mean "log in again", and pretending otherwise
 * produces a panel that spins instead of telling you what happened.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (!opts.anonymous && session) headers.authorization = `Bearer ${session.token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401 && !opts.anonymous) {
    clearSession();
    window.location.assign('/ops');
    throw new ApiError(401, 'Session expired');
  }

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string };
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.code);
  }
  return payload as T;
}

/** Update the cached user after enrollment, so the read-only banner disappears. */
export function patchStoredUser(patch: Partial<PlatformUser>): void {
  const session = loadSession();
  if (!session) return;
  saveSession({ ...session, user: { ...session.user, ...patch } });
}

// ── Small shared formatters ──────────────────────────────────────────────────
// Local to the panel rather than imported from src/lib, per the note at the top.

export function money(cents: number, currency: string | null): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
  }).format(cents / 100);
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 3 days" / "6 days ago" — the form a worklist is read in. */
export function relativeDays(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
}
