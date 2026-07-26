import crypto from 'node:crypto';

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), implemented on `node:crypto` alone.
 *
 * Hand-rolled rather than taken from npm, and the justification is entirely in
 * test/totp.test.ts: the algorithm is ~40 lines of HMAC and modular arithmetic, and
 * it is verified against the RFC's own published test vectors. A three-line
 * unaudited dependency sitting in the second-factor path of the one account type
 * that can reach every customer buys nothing and adds a supply-chain surface. If
 * those vectors are ever removed, replace this file with a maintained library —
 * unverified hand-rolled crypto is strictly worse than either option.
 *
 * Defaults are the ones every authenticator app assumes: SHA-1, 6 digits, a
 * 30-second step. They are configurable only because the RFC vectors exercise
 * 8 digits and the wider hash family.
 */

/** RFC 4648 base32, the encoding authenticator apps expect in an otpauth URI. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32, tolerating the shapes humans produce: lowercase, `=` padding and
 * the spaces authenticator apps insert when they display a secret in groups of
 * four. Rejecting a secret because the user pasted it with spaces is a support
 * ticket, not a security control.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  digits?: number;
  stepSeconds?: number;
  algorithm?: TotpAlgorithm;
}

const DEFAULTS = { digits: 6, stepSeconds: 30, algorithm: 'sha1' as TotpAlgorithm };

/**
 * HOTP (RFC 4226 §5.3): HMAC the counter, then dynamic-truncate.
 *
 * The counter is an unsigned 64-bit big-endian integer, so it is built with a
 * BigInt — at a 30s step, Number stays exact for ~285 million years, but the RFC
 * vectors include counters that only make sense read as 64-bit, and a silent
 * precision cliff in an auth primitive is not worth the saved line.
 */
export function hotp(key: Buffer, counter: bigint, opts: TotpOptions = {}): string {
  const { digits, algorithm } = { ...DEFAULTS, ...opts };
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);

  const mac = crypto.createHmac(algorithm, key).update(buf).digest();
  // Dynamic truncation: the low nibble of the LAST byte selects a 4-byte window,
  // and the top bit of that window is masked off so the result is sign-agnostic
  // across languages.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The counter for a moment in time. Exposed so tests can pin a step boundary. */
export function counterAt(unixSeconds: number, stepSeconds = DEFAULTS.stepSeconds): bigint {
  return BigInt(Math.floor(unixSeconds / stepSeconds));
}

/** TOTP for a raw key. `unixSeconds`, not milliseconds — the RFC counts seconds. */
export function totp(key: Buffer, unixSeconds: number, opts: TotpOptions = {}): string {
  const { stepSeconds } = { ...DEFAULTS, ...opts };
  return hotp(key, counterAt(unixSeconds, stepSeconds), opts);
}

/** A fresh 160-bit secret, base32-encoded. 160 bits is the RFC 4226 recommendation. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** The current code for a stored base32 secret — what the enrollment page shows. */
export function currentCode(secretBase32: string, at: Date = new Date()): string {
  return totp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000));
}

export interface VerifyOptions extends TotpOptions {
  at?: Date;
  /**
   * Steps accepted either side of now. ±1 (the default) covers clock skew and the
   * user typing a code as it rolls over. Widening this multiplies the window an
   * attacker has to brute-force a 6-digit code in, so it stays at 1.
   */
  window?: number;
}

/**
 * Verify a presented code.
 *
 * Every candidate step is compared even after a match, so the time this takes does
 * not reveal WHICH step matched. Within a step the comparison is constant-time.
 * Returns false rather than throwing on a malformed secret or code — a caller in an
 * auth path should treat "unparseable" and "wrong" identically.
 */
export function verifyTotp(secretBase32: string, code: string, opts: VerifyOptions = {}): boolean {
  const { digits, stepSeconds } = { ...DEFAULTS, ...opts };
  const window = opts.window ?? 1;
  const presented = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(presented)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const now = Math.floor((opts.at ?? new Date()).getTime() / 1000);
  const base = counterAt(now, stepSeconds);
  const presentedBuf = Buffer.from(presented);

  let matched = false;
  for (let drift = -window; drift <= window; drift++) {
    const candidate = Buffer.from(hotp(key, base + BigInt(drift), opts));
    if (
      candidate.length === presentedBuf.length &&
      crypto.timingSafeEqual(candidate, presentedBuf)
    ) {
      matched = true;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label carries the issuer as a prefix AND as a parameter: older apps read the
 * prefix, newer ones the parameter, and an app that shows a bare email address is
 * useless to someone holding twenty codes.
 */
export function otpauthUri(opts: {
  secret: string;
  account: string;
  issuer?: string;
  digits?: number;
  stepSeconds?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const issuer = opts.issuer ?? 'Nestled Ops';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: (opts.algorithm ?? DEFAULTS.algorithm).toUpperCase(),
    digits: String(opts.digits ?? DEFAULTS.digits),
    period: String(opts.stepSeconds ?? DEFAULTS.stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
