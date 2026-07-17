import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export type AgentRole = 'admin' | 'agent';

export interface AccessTokenPayload {
  sub: string; // agent id
  role: AgentRole;
  email: string;
}

/** Short-lived access token used on every agent/admin request. */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === 'string') throw new Error('Malformed access token');
  return {
    sub: String(decoded.sub),
    role: decoded.role as AgentRole,
    email: String(decoded.email),
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

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashToken(token));
  const stored = Buffer.from(storedHash);
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}
