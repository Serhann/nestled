import { api, get, patch } from '../http';
import { getSession, setSession } from '../tokens';
import type { Me } from './types';

/**
 * Authentication and the account itself.
 *
 * Signup is open. The gate that keeps that safe is `requireVerified` on the
 * server: an unverified account can look around the panel but cannot send
 * outbound email or serve a widget, so the abuse surface is closed without
 * putting a wall in front of the product.
 */

interface Tokens {
  access_token: string;
  refresh_token: string;
}

const anon = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body, anonymous: true });

export async function login(email: string, password: string): Promise<Tokens> {
  const tokens = await anon<Tokens>('/api/v1/auth/login', { email, password });
  setSession(tokens);
  return tokens;
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  /** Optional: the wizard asks for it on a later step, so most signups omit it. */
  workspace_name?: string;
}): Promise<Tokens> {
  const tokens = await anon<Tokens>('/api/v1/auth/signup', input);
  setSession(tokens);
  return tokens;
}

export const requestPasswordReset = (email: string): Promise<{ ok: true }> =>
  anon('/api/v1/auth/forgot-password', { email });

export const resetPassword = (token: string, password: string): Promise<{ ok: true }> =>
  anon('/api/v1/auth/reset-password', { token, password });

export const verifyEmail = (token: string): Promise<{ ok: true; already_verified?: boolean }> =>
  anon('/api/v1/auth/verify-email', { token });

export const resendVerification = (): Promise<{ ok: true }> =>
  api('/api/v1/auth/resend-verification', { method: 'POST' });

export const changePassword = (current_password: string, new_password: string): Promise<Tokens> =>
  api('/api/v1/auth/change-password', { method: 'POST', body: { current_password, new_password } });

export async function logout(everywhere = false): Promise<void> {
  try {
    await api('/api/v1/auth/logout', { method: 'POST', body: { all: everywhere } });
  } finally {
    // Local sign-out happens even if the request fails — otherwise a network
    // blip leaves the user apparently still signed in with a dead session.
    setSession(null);
  }
}

export const slugAvailable = (slug: string): Promise<{ slug: string; available: boolean }> =>
  api(`/api/v1/auth/slug-available?slug=${encodeURIComponent(slug)}`, { anonymous: true });

export const me = (): Promise<Me> => get<Me>('/api/v1/me');

export const updateProfile = (input: {
  name?: string;
  timezone?: string;
  default_workspace_id?: string | null;
}): Promise<{ user: Me['user'] }> => patch('/api/v1/me', input);

// ── Invitations ────────────────────────────────────────────────────────────
export const readInvite = (
  token: string,
): Promise<{
  invite: { email: string; role: string; workspace_name: string; inviter_name: string | null };
}> => api(`/api/v1/invites/${encodeURIComponent(token)}`, { anonymous: true });

export const acceptInvite = (
  token: string,
  input: { name?: string; password?: string },
): Promise<{ ok: true; workspace_id: string; had_account: boolean }> =>
  api(`/api/v1/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: input,
    // An invitee may already be signed in (an existing user joining a second
    // workspace) or may not exist yet. The server handles both, so the
    // Authorization header is attached only when there is genuinely a session —
    // demanding one would break the more common path.
    anonymous: !getSession(),
  });
