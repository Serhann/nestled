import crypto from 'node:crypto';
// The second factor is checked during LOGIN, before any workspace is known, and
// managed from /me, which is also workspace-agnostic. There is no scoped client for
// either, exactly as with the rest of the identity plane.
// eslint-disable-next-line no-restricted-imports -- pre-tenant identity flow
import { unscopedPrisma } from '../db/unscoped.js';
import { hashToken } from '../auth/tokens.js';
import { verifyTotpStep } from '../lib/totp.js';

/**
 * Second-factor checking and recovery codes for customer accounts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a separate module from the routes because the same check runs in two
 * places that must not drift: the login gate, and the confirmation required before
 * removing the factor. A second factor that a different code path verifies slightly
 * differently is not a second factor.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RECOVERY_CODE_COUNT = 10;

/**
 * Codes people can read off a screen and type back.
 *
 * Crockford's base32 alphabet: no I, L, O or U, so there is no 1/l, 0/O confusion to
 * misread, and no accidental words. Five characters times two groups is ~50 bits,
 * which is far beyond brute-forcing at ten codes per account behind a rate limit.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(): string {
  const pick = (n: number): string => {
    let out = '';
    // Rejection-free because 32 divides 256 exactly — every byte maps to one symbol
    // with no modulo bias.
    for (const byte of crypto.randomBytes(n)) out += CODE_ALPHABET[byte & 31];
    return out;
  };
  return `${pick(5)}-${pick(5)}`;
}

/** Codes are matched case- and dash-insensitively, so the hash is of a canonical form. */
function canonical(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

/**
 * Issue a fresh set, invalidating whatever came before.
 *
 * Regenerating REPLACES rather than adds: someone who regenerates because they think
 * their old list leaked has to end up with the old list dead, and "adds ten more"
 * would quietly do the opposite of what they asked for.
 *
 * Returns the plaintext, which is the only time it exists — nothing but the hash is
 * stored, so a customer who loses the list regenerates rather than re-reads it.
 */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, randomCode);
  await unscopedPrisma.$transaction([
    unscopedPrisma.user_recovery_codes.deleteMany({ where: { user_id: userId } }),
    unscopedPrisma.user_recovery_codes.createMany({
      data: codes.map((code) => ({ user_id: userId, code_hash: hashToken(canonical(code)) })),
    }),
  ]);
  return codes;
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return unscopedPrisma.user_recovery_codes.count({ where: { user_id: userId, used_at: null } });
}

export interface SecondFactorInput {
  totp?: string | null;
  recovery_code?: string | null;
}

export type SecondFactorResult =
  | { ok: true; usedRecoveryCode: boolean }
  | { ok: false; reason: 'missing' | 'invalid' | 'replayed' };

/**
 * Check a presented second factor against a user's enrolment.
 *
 * The caller must have already verified the password. Both accepted forms are
 * checked here so that neither the login route nor the disable route can support one
 * and forget the other.
 */
export async function checkSecondFactor(
  user: { id: string; totp_secret: string | null; totp_last_step: bigint | null },
  input: SecondFactorInput,
): Promise<SecondFactorResult> {
  const recovery = input.recovery_code?.trim();
  if (recovery) {
    /*
      Spending a recovery code is a conditional UPDATE, not a read followed by a
      write. Two simultaneous attempts with the same code both find an unused row if
      you look first; only one of them can win a `used_at IS NULL` update, and the
      count it returns is the answer.
    */
    const spent = await unscopedPrisma.user_recovery_codes.updateMany({
      where: { user_id: user.id, code_hash: hashToken(canonical(recovery)), used_at: null },
      data: { used_at: new Date() },
    });
    return spent.count === 1
      ? { ok: true, usedRecoveryCode: true }
      : { ok: false, reason: 'invalid' };
  }

  const code = input.totp?.trim();
  if (!code) return { ok: false, reason: 'missing' };
  if (!user.totp_secret) return { ok: false, reason: 'invalid' };

  const step = verifyTotpStep(user.totp_secret, code);
  if (step === null) return { ok: false, reason: 'invalid' };

  /*
    Replay: the same code is valid for the whole ±1-step window, so a code already
    spent is refused even though it still verifies. Reported distinctly from a wrong
    code because the two need different advice — "wait for the next code" versus
    "check the app".
  */
  if (user.totp_last_step !== null && step <= user.totp_last_step) {
    return { ok: false, reason: 'replayed' };
  }
  await unscopedPrisma.users.update({
    where: { id: user.id },
    data: { totp_last_step: step },
  });
  return { ok: true, usedRecoveryCode: false };
}
