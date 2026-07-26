import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  currentCode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../lib/totp.js';

/**
 * The justification for hand-rolling TOTP instead of installing a package.
 *
 * lib/totp.ts is only defensible if it is verified against the standards' OWN
 * published vectors, so both are here: RFC 4226 Appendix D (HOTP) and RFC 6238
 * Appendix B (TOTP, all three hash families). If these are ever deleted, delete
 * lib/totp.ts too and take the dependency — unverified hand-rolled crypto in an
 * authentication path is worse than either alternative.
 */

/** RFC 4226 Appendix D: the ASCII secret "12345678901234567890". */
const RFC4226_SECRET = Buffer.from('12345678901234567890', 'ascii');

/**
 * RFC 6238 Appendix B uses the same ASCII seed, extended by repetition to the
 * block size of each hash. The document prints them as hex; they are spelled as
 * ASCII here because that is what makes the "it's the same seed" fact visible.
 */
const RFC6238_SEEDS = {
  sha1: Buffer.from('12345678901234567890', 'ascii'),
  sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  sha512: Buffer.from(
    '1234567890123456789012345678901234567890123456789012345678901234',
    'ascii',
  ),
} as const;

test('HOTP matches every RFC 4226 Appendix D test vector', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  for (let counter = 0; counter < expected.length; counter++) {
    assert.equal(
      hotp(RFC4226_SECRET, BigInt(counter)),
      expected[counter],
      `HOTP counter ${counter}`,
    );
  }
});

test('TOTP matches every RFC 6238 Appendix B test vector', () => {
  // time, then the 8-digit code for SHA-1 / SHA-256 / SHA-512.
  const vectors: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    // Past 2^31 seconds: proves the counter is handled as 64-bit, which is the one
    // place a naive implementation quietly breaks (in the year 2603).
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  for (const [time, sha1, sha256, sha512] of vectors) {
    assert.equal(totp(RFC6238_SEEDS.sha1, time, { digits: 8 }), sha1, `sha1 @ ${time}`);
    assert.equal(
      totp(RFC6238_SEEDS.sha256, time, { digits: 8, algorithm: 'sha256' }),
      sha256,
      `sha256 @ ${time}`,
    );
    assert.equal(
      totp(RFC6238_SEEDS.sha512, time, { digits: 8, algorithm: 'sha512' }),
      sha512,
      `sha512 @ ${time}`,
    );
  }
});

test('base32 round-trips, and decodes what an authenticator app displays', () => {
  // RFC 4648 §10 vectors, which pin the padding behaviour at every offset.
  assert.equal(base32Encode(Buffer.from('f')), 'MY');
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
  assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6');
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');

  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/, '160 bits of base32 is 32 characters');
  assert.equal(base32Decode(secret).length, 20);

  // Apps show secrets grouped and users paste them lowercase; both must work, or
  // enrollment fails for a reason nobody can see.
  assert.deepEqual(base32Decode('MZXW 6YTB OI'), Buffer.from('foobar'));
  assert.deepEqual(base32Decode('mzxw6ytboi'), Buffer.from('foobar'));
});

test('verification accepts the ±1 window and nothing outside it', () => {
  const secret = generateTotpSecret();
  const at = new Date('2026-03-04T05:06:07Z');
  const seconds = Math.floor(at.getTime() / 1000);
  const key = base32Decode(secret);

  for (const drift of [-1, 0, 1]) {
    const code = totp(key, seconds + drift * 30);
    assert.equal(verifyTotp(secret, code, { at }), true, `drift ${drift} must be accepted`);
  }
  for (const drift of [-2, 2, 10]) {
    const code = totp(key, seconds + drift * 30);
    assert.equal(verifyTotp(secret, code, { at }), false, `drift ${drift} must be rejected`);
  }
});

test('verification rejects malformed input instead of throwing', () => {
  const secret = generateTotpSecret();
  // An auth path must treat "unparseable" and "wrong" identically — a thrown error
  // here would surface as a 500 and distinguish the two for an attacker.
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '000000000']) {
    assert.equal(verifyTotp(secret, bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(verifyTotp('not base32!!', '123456'), false);
  assert.equal(verifyTotp('', '123456'), false);
});

test('currentCode is what verifyTotp accepts right now', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, currentCode(secret)), true);
});

test('the otpauth URI carries the issuer twice, for old and new apps alike', () => {
  const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'ops@nestled.chat' });
  const url = new URL(uri);
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/Nestled Ops:ops@nestled.chat');
  assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(url.searchParams.get('issuer'), 'Nestled Ops');
  assert.equal(url.searchParams.get('algorithm'), 'SHA1');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});
