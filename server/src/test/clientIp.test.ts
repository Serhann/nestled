import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from '../lib/clientIp.js';

/**
 * Who the app thinks is calling, as pure unit tests.
 *
 * The suite runs with CLIENT_IP_HEADER unset, so what is pinned here is the
 * FALLBACK chain — the behaviour every install that is not behind a CDN gets, and
 * the behaviour a misconfigured CDN install falls back to. The configured-header
 * path is a lower-cased lookup in the same table; what needed tests was the
 * normalising, because that is where a header holding `unknown` or `1.2.3.4:5678`
 * quietly becomes a rate-limit key shared by strangers.
 */

const SOCKET = '10.0.0.7';

test('X-Forwarded-For takes the leftmost hop — the one closest to the client', () => {
  // Cloudflare edge and nginx appended themselves to the right of the visitor.
  const ip = resolveClientIp({ 'x-forwarded-for': '203.0.113.9, 172.68.1.1, 10.0.0.3' }, SOCKET);
  assert.equal(ip, '203.0.113.9');
});

test('X-Real-IP is used when there is no forwarded chain', () => {
  assert.equal(resolveClientIp({ 'x-real-ip': '203.0.113.9' }, SOCKET), '203.0.113.9');
});

test('with no proxy headers at all, the socket address IS the client', () => {
  assert.equal(resolveClientIp({}, SOCKET), SOCKET);
});

test('a port suffix is trimmed off, in both address families', () => {
  assert.equal(resolveClientIp({ 'x-real-ip': '203.0.113.9:44321' }, SOCKET), '203.0.113.9');
  assert.equal(resolveClientIp({ 'x-real-ip': '[2001:db8::1]:44321' }, SOCKET), '2001:db8::1');
});

test('an IPv4-mapped IPv6 address is reported as the IPv4 address', () => {
  // Node hands this form to `req.ip` on a dual-stack socket. Left alone, the same
  // visitor gets two different rate-limit buckets and two audit-log spellings.
  assert.equal(resolveClientIp({}, '::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(resolveClientIp({ 'x-real-ip': '::ffff:203.0.113.9' }, SOCKET), '203.0.113.9');
});

test('junk in a header falls through instead of becoming the answer', () => {
  // Some proxies send the literal string `unknown`. Accepting it makes one bucket
  // that every such request shares, which is a self-inflicted outage.
  for (const junk of ['unknown', '-', '', '   ', 'not an ip']) {
    assert.equal(
      resolveClientIp({ 'x-forwarded-for': junk, 'x-real-ip': '203.0.113.9' }, SOCKET),
      '203.0.113.9',
      `${JSON.stringify(junk)} should have been rejected`,
    );
  }
});

test('an empty leftmost entry falls through to the next source', () => {
  assert.equal(
    resolveClientIp({ 'x-forwarded-for': ', 172.68.1.1', 'x-real-ip': '203.0.113.9' }, SOCKET),
    '203.0.113.9',
  );
});

test('a repeated header is read as its first occurrence', () => {
  const ip = resolveClientIp({ 'x-forwarded-for': ['203.0.113.9', '198.51.100.4'] }, SOCKET);
  assert.equal(ip, '203.0.113.9');
});

test('surrounding whitespace never reaches a bucket key or an audit row', () => {
  assert.equal(resolveClientIp({ 'x-real-ip': '  203.0.113.9  ' }, SOCKET), '203.0.113.9');
});
