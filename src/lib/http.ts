import { API_BASE } from './origins';
import { getSession, setSession, isExpiring, type Session } from './tokens';

/**
 * The one place the app talks to the API.
 *
 * Two things here are not incidental:
 *
 * 1. **Refresh is single-flight.** Refresh tokens rotate, and presenting a
 *    rotated token twice is treated by the server as theft — it revokes the whole
 *    family and signs the user out. The panel fires four to six requests on
 *    mount, so if the access token has expired they would all 401 at once, all
 *    call /auth/refresh with the same token, and the losers of that race would
 *    log the user out for no reason. One shared promise removes the race
 *    entirely.
 *
 * 2. **Refresh is proactive.** A token within a minute of expiry is renewed
 *    before the request rather than after it fails, so the common case costs one
 *    request instead of three.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable discriminator, e.g. 'plan_limit'. */
  readonly code?: string;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    const c = (body as { code?: unknown } | null)?.code;
    this.code = typeof c === 'string' ? c : undefined;
  }

  /** A 402 carrying which plan limit was hit, so callers can offer an upgrade. */
  get planLimit(): { metric: string; limit: number; used: number } | null {
    if (this.status !== 402 || this.code !== 'plan_limit') return null;
    const b = this.body as { metric?: string; limit?: number; used?: number };
    return { metric: b.metric ?? 'unknown', limit: b.limit ?? 0, used: b.used ?? 0 };
  }
}

/** Fired when the session is gone for good; the router listens and redirects. */
const AUTH_LOST = 'nestled:auth-lost';
export function onAuthLost(fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener(AUTH_LOST, handler);
  return () => window.removeEventListener(AUTH_LOST, handler);
}

function signOut(): void {
  setSession(null);
  window.dispatchEvent(new Event(AUTH_LOST));
}

let inFlightRefresh: Promise<Session | null> | null = null;

/**
 * Exchange the refresh token for a new pair. Concurrent callers share one
 * request; see the note at the top of this file for why that matters.
 */
function refreshSession(): Promise<Session | null> {
  if (inFlightRefresh) return inFlightRefresh;

  const current = getSession();
  if (!current) return Promise.resolve(null);

  inFlightRefresh = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      if (!res.ok) {
        signOut();
        return null;
      }
      const tokens = (await res.json()) as { access_token: string; refresh_token: string };
      setSession(tokens);
      return getSession();
    } catch {
      // A network failure is not proof the session is invalid, so the user stays
      // signed in and the caller sees the error. Signing out on a flaky
      // connection would be a far worse experience than one failed request.
      return current;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the Authorization header (login, signup, password reset, plans). */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** For multipart uploads: pass a FormData body and we leave the headers alone. */
  formData?: FormData;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: opts.signal,
    });
  };

  let token: string | null = null;
  if (!opts.anonymous) {
    let session = getSession();
    if (session && isExpiring(session)) session = await refreshSession();
    if (!session) {
      signOut();
      throw new ApiError(401, 'Not signed in', null);
    }
    token = session.access_token;
  }

  let res = await send(token);

  // A 401 despite a fresh-looking token means the server disagrees — the token
  // was revoked, or our clock is off. One refresh-and-retry, never a loop.
  if (res.status === 401 && !opts.anonymous) {
    const session = await refreshSession();
    if (!session) throw new ApiError(401, 'Session expired', null);
    res = await send(session.access_token);
    if (res.status === 401) {
      signOut();
      throw new ApiError(401, 'Session expired', null);
    }
  }

  const body = await parse(res);
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

/** Convenience wrappers — they read better at the call site than an options bag. */
export const get = <T>(path: string, signal?: AbortSignal): Promise<T> => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'DELETE', body });
