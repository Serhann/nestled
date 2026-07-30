import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDatabaseUrl, redactDatabaseUrl } from '../db/url.js';

/**
 * The connection string, as pure unit tests.
 *
 * This file exists because of a production deploy: POSTGRES_PASSWORD was
 * generated with `openssl rand -base64 48`, the password contained a `/`, and
 * every container in the stack crash-looped on
 * `P1013 … invalid port number in database URL` — an error that names neither
 * the password nor the character. The first two tests below are that outage.
 *
 * The one that matters most for an existing deployment is
 * "a URL that parses is returned untouched": this runs on the boot path of a
 * running install, so it must be incapable of changing a string that works.
 */

test('a URL that parses is returned untouched, byte for byte', () => {
  for (const url of [
    'postgres://nestled:plainpassword@db:5432/nestled',
    'postgres://nestled:has+plus@db:5432/nestled',
    'postgres://nestled:has%2Fencoded@db:5432/nestled',
    'postgres://nestled:colon:inside@db:5432/nestled',
    'postgres://nestled:at@sign@db:5432/nestled',
    'postgres://nestled:pw@db:5432/nestled?sslmode=require&connection_limit=5',
    'postgresql://user@localhost/db',
  ]) {
    const result = normalizeDatabaseUrl(url);
    assert.equal(result.url, url);
    assert.equal(result.repaired, false, `${url} should not need repair`);
  }
});

test('a slash in the password — the outage — is percent-encoded', () => {
  const result = normalizeDatabaseUrl('postgres://nestled:ab/cd@db:5432/nestled');
  assert.equal(result.repaired, true);
  assert.equal(result.url, 'postgres://nestled:ab%2Fcd@db:5432/nestled');
  // And the point of encoding it: the host, port and database survive.
  const parsed = new URL(result.url);
  assert.equal(parsed.hostname, 'db');
  assert.equal(parsed.port, '5432');
  assert.equal(parsed.pathname, '/nestled');
  assert.equal(decodeURIComponent(parsed.password), 'ab/cd');
});

test('?, # and every other authority-ending character survive a round trip', () => {
  for (const password of [
    'ab/cd',
    'ab?cd',
    'ab#cd',
    'ab/cd?ef#gh',
    'sl/sh+pl:co@at%pc',
    '/leading',
    'trailing/',
    'a//b',
    '#hash-first',
  ]) {
    const { url, repaired } = normalizeDatabaseUrl(
      `postgres://nestled:${password}@db:5432/nestled`,
    );
    const parsed = new URL(url);
    assert.equal(repaired, true, `${password} should have been repaired`);
    assert.equal(decodeURIComponent(parsed.password), password);
    assert.equal(parsed.username, 'nestled');
    assert.equal(parsed.hostname, 'db');
    assert.equal(parsed.port, '5432');
    assert.equal(parsed.pathname, '/nestled');
  }
});

test('a password containing BOTH an @ and a / still resolves to the real host', () => {
  // This one is the reason "already parses" is not the test for whether to repair.
  // Every URL parser accepts it, with host "ss" and `@db:5432/nestled` as the path.
  const raw = 'postgres://nestled:p@ss/word@db:5432/nestled';
  assert.equal(new URL(raw).hostname, 'ss');

  const { url, repaired } = normalizeDatabaseUrl(raw);
  const parsed = new URL(url);
  assert.equal(repaired, true);
  assert.equal(parsed.hostname, 'db');
  assert.equal(parsed.port, '5432');
  assert.equal(parsed.pathname, '/nestled');
  assert.equal(decodeURIComponent(parsed.password), 'p@ss/word');
});

test('a leading slash in the password does not turn the username into the host', () => {
  const raw = 'postgres://nestled:/leading@db:5432/nestled';
  assert.equal(new URL(raw).hostname, 'nestled'); // what a parser makes of it

  const { url } = normalizeDatabaseUrl(raw);
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'db');
  assert.equal(parsed.port, '5432');
  assert.equal(decodeURIComponent(parsed.password), '/leading');
});

test('an @ in the query is not mistaken for the credential separator', () => {
  // Repairing right-to-left would read `…=a@b` as the authority and hand Prisma a
  // URL that parses cleanly while pointing at a host called `b`. Connecting to the
  // wrong server is worse than the crash this function prevents.
  const { url } = normalizeDatabaseUrl(
    'postgres://nestled:ab/cd@db:5432/nestled?options=-c%20search_path%3Dx@y',
  );
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'db');
  assert.equal(parsed.port, '5432');
  assert.equal(parsed.pathname, '/nestled');
  assert.equal(decodeURIComponent(parsed.password), 'ab/cd');
});

test('something broken in a way encoding cannot fix throws, and names the cause', () => {
  assert.throws(
    () => normalizeDatabaseUrl('not-a-url-at-all'),
    (err: Error) => {
      assert.match(err.message, /^DATABASE_URL is not a valid connection string/);
      assert.match(err.message, /%2F/); // it says what to do about it
      return true;
    },
  );
});

test('the password never reaches a log line', () => {
  const secret = 'sup3r/s3cret';
  const redacted = redactDatabaseUrl(`postgres://nestled:${secret}@db:5432/nestled`);
  assert.ok(!redacted.includes(secret));
  assert.ok(!redacted.includes('s3cret'));
  assert.equal(redacted, 'postgres://nestled:***@db:5432/nestled');

  // Including when we could not work out where the password ended: with no `@`
  // there is no safe place to cut, so nothing after the scheme is printed.
  const noSeparator = redactDatabaseUrl(`postgres://nestled:${secret}`);
  assert.ok(!noSeparator.includes('s3cret'));
  assert.equal(noSeparator, 'postgres://***');
});
