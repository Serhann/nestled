import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/**
 * The access token is deliberately WORKSPACE-AGNOSTIC. The workspace comes from
 * the request path (`/api/v1/w/:workspaceId/...`), and membership is verified per
 * request from a short-TTL cache.
 *
 * The alternative — minting a workspace-scoped token on switch — fails in exactly
 * the ways that hurt: two browser tabs on two workspaces share one token slot, so
 * one tab silently starts writing to the wrong tenant; switching becomes an async
 * network hop with a loading state; and refresh becomes stateful ("refresh into
 * which workspace?"). Path-scoping also makes React Query cache keys naturally
 * tenant-scoped on the client.
 */
export interface AccessTokenPayload {
  sub: string; // user id
  /** Checked explicitly, so a platform token can never be mistaken for a user's. */
  typ: 'user';
  email: string;
  /** Present only for an impersonated session. See permissions.ts. */
  act?: {
    pu: string; // platform_users.id
    sid: string; // impersonation_sessions.id
    ws: string; // the workspace this session may touch — and ONLY this one
    scope: 'read_only' | 'full';
  };
}

/**
 * Short-lived access token used on every authenticated request.
 *
 * `expiresIn` overrides the install default in exactly one place: an impersonation
 * token, whose lifetime is the staff member's declared TTL (<= 30 minutes) rather
 * than the 15-minute default. Without the override the JWT would die before the
 * impersonation_sessions row it belongs to, and support would silently lose access
 * mid-investigation with no refresh token to recover from — see routes/platform.
 */
export function signAccessToken(payload: AccessTokenPayload, expiresIn?: string | number): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: (expiresIn ?? env.ACCESS_TOKEN_TTL) as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === 'string') throw new Error('Malformed access token');
  if (decoded.typ !== 'user') throw new Error('Wrong token type');
  const act = decoded.act as AccessTokenPayload['act'];
  return {
    sub: String(decoded.sub),
    typ: 'user',
    email: String(decoded.email),
    ...(act ? { act } : {}),
  };
}

/**
 * Refresh tokens are opaque random strings, not JWTs — we store only their
 * SHA-256 hash server-side and rotate on every use. This keeps revocation
 * simple and means a DB dump can't be replayed against the API.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshExpiryDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return d;
}

/** Per-conversation visitor token. Opaque, stored hashed on the conversation. */
export function generateVisitorToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/**
 * A generic opaque token, hashed at rest. One pattern now backs five things —
 * refresh tokens, email verification, password reset, team invites and the
 * proactive claim token — so there is a single place to reason about entropy and
 * a single comparison routine (tokenMatchesHash) for all of them.
 */
export function generateOpaqueToken(bytes = 32): { token: string; hash: string } {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashToken(token));
  const stored = Buffer.from(storedHash);
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}
