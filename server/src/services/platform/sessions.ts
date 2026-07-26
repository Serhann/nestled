// The vendor plane is cross-tenant by definition, and platform_users /
// platform_sessions are not tenant data at all — there is no scoped client that
// could reach them.
// eslint-disable-next-line no-restricted-imports -- vendor plane, no tenant scope exists
import { unscopedPrisma } from '../../db/unscoped.js';
import { generateOpaqueToken, hashToken } from '../../auth/tokens.js';
import { env } from '../../env.js';

/**
 * Staff sessions.
 *
 * Opaque bearer tokens, stored only as a SHA-256 hash and verified against the
 * database on every request (see requirePlatform in plugins/auth.ts). This is a
 * different MECHANISM from the customer JWT, not a different secret, and the reason
 * is revocation: platform traffic is a rounding error next to the widget plane, so
 * the per-request lookup costs nothing and buys the ability to kill a staff session
 * the instant someone loses a laptop. A JWT cannot offer that without a denylist,
 * which is the same lookup with extra steps and a worse failure mode.
 *
 * The hashing helpers are the same ones behind refresh tokens, invites and
 * password resets (auth/tokens.ts) — one place to reason about entropy, one
 * comparison routine.
 */

export interface IssuedSession {
  /** Returned to the client exactly once; only its hash is stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.PLATFORM_SESSION_TTL_HOURS * 3600_000);
}

export async function createSession(
  platformUserId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<IssuedSession> {
  const { token, hash } = generateOpaqueToken(32);
  const expiresAt = sessionExpiry();
  const row = await unscopedPrisma.platform_sessions.create({
    data: {
      platform_user_id: platformUserId,
      token_hash: hash,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 400) ?? null,
      expires_at: expiresAt,
    },
    select: { id: true },
  });
  return { token, sessionId: row.id, expiresAt };
}

/** Revoke by presented token. Idempotent — logging out twice is not an error. */
export async function revokeSessionByToken(token: string): Promise<void> {
  await unscopedPrisma.platform_sessions.updateMany({
    where: { token_hash: hashToken(token), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/** Revoke every live session for a staff account. Used on password/role change. */
export async function revokeAllSessions(platformUserId: string): Promise<number> {
  const res = await unscopedPrisma.platform_sessions.updateMany({
    where: { platform_user_id: platformUserId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return res.count;
}

/**
 * Does this staff account have a verified second factor?
 *
 * requirePlatform authenticates; this is the separate question that gates WRITES.
 * A staff session without TOTP is read-only whatever the role says, so a stolen
 * password alone can look but never change anything — including the plan a
 * customer is on, or who can impersonate them.
 */
export async function hasVerifiedFactor(platformUserId: string): Promise<boolean> {
  const row = await unscopedPrisma.platform_users.findUnique({
    where: { id: platformUserId },
    select: { totp_enabled: true, totp_secret: true },
  });
  return Boolean(row?.totp_enabled && row.totp_secret);
}
