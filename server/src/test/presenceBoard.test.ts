import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializePresence, type PresenceEntry } from '../realtime/presence.js';

/**
 * The wire contract of the live-visitor board.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This file exists because of a bug that 301 passing tests did not notice.
 *
 * `snapshot()` spread the in-memory `PresenceEntry` straight onto the wire, so the
 * board received `visitorId` while every line of the client read `visitor_id`.
 * Every field on that screen was `undefined` — and it did not look broken, because
 * each one has a fallback: "Anonymous visitor", "Unknown location", "Unknown page",
 * "Unknown browser". It looked like a board full of visitors we knew nothing about.
 *
 * It surfaced as three unrelated-looking symptoms: Say hello returned 400 for a
 * missing `website_id`, React warned about duplicate keys (every key was
 * `undefined`), and Watch could never start because it was passed two undefineds.
 *
 * Nothing failed because nothing asserted the SHAPE. A test that goes through the
 * route would not have caught it either — it would have read `visitorId` off the
 * response and been satisfied. So this asserts the field names a client depends on,
 * which is the only thing that was ever wrong.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ENTRY: PresenceEntry = {
  visitorId: 'v_abc123',
  workspaceId: 'ws-1',
  websiteId: 'site-1',
  url: 'https://acme.test/pricing',
  referrer: 'https://google.com/',
  utm: { utm_source: 'google' },
  device: 'desktop',
  screen: { w: 1920, h: 1080 },
  returning: true,
  sessionStart: Date.parse('2026-07-28T09:00:00Z'),
  pagesViewed: 4,
  pages: [
    { url: 'https://acme.test/', at: Date.parse('2026-07-28T09:00:00Z') },
    { url: 'https://acme.test/pricing', at: Date.parse('2026-07-28T09:02:00Z') },
  ],
  ip: '203.0.113.7',
  geo: { country: 'Türkiye', country_code: 'TR', city: 'Istanbul', region: 'Istanbul' },
  conversationId: 'conv-1',
  name: 'Ada',
  email: 'ada@acme.test',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  language: 'tr-TR',
  timezone: 'Europe/Istanbul',
  context: null,
  data: { cart_total: '99' },
  lastSeen: Date.parse('2026-07-28T09:05:00Z'),
};

test('every field the board reads is present under the name it reads', () => {
  const row = serializePresence(ENTRY, true);

  // Named one by one rather than compared to a blob, so the failure message points
  // at the field that moved instead of at a diff of the whole object.
  assert.equal(row.visitor_id, 'v_abc123');
  assert.equal(row.website_id, 'site-1');
  assert.equal(row.conversation_id, 'conv-1');
  assert.equal(row.name, 'Ada');
  assert.equal(row.email, 'ada@acme.test');
  assert.equal(row.current_url, 'https://acme.test/pricing');
  assert.equal(row.referrer, 'https://google.com/');
  assert.equal(row.country, 'Türkiye');
  assert.equal(row.city, 'Istanbul');
  assert.equal(row.device, 'desktop');
  assert.equal(row.page_count, 4);
  assert.equal(row.online, true);

  // Timestamps cross the wire as ISO strings; the client hands them to Date.
  assert.equal(row.started_at, '2026-07-28T09:00:00.000Z');
  assert.equal(row.last_seen, '2026-07-28T09:05:00.000Z');

  // Nothing may be undefined. Undefined is precisely how this failed: it renders as
  // a fallback string rather than as an error, so it reaches production looking fine.
  for (const [key, value] of Object.entries(row)) {
    assert.notEqual(value, undefined, `${key} is undefined`);
  }
});

test('the browser is named, not shipped as a user-agent string', () => {
  // 120 characters of which about six matter, and the six are at the end. The board
  // truncates, so the raw string shows "Mozilla/5.0 (Windows NT 10.0; W…" — identical
  // for every Windows visitor and therefore worth nothing.
  assert.equal(serializePresence(ENTRY, true).browser, 'Chrome');

  const edge = {
    ...ENTRY,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126 Safari/537.36 Edg/126',
  };
  // Edge and Opera both claim Chrome, so order of testing is load-bearing.
  assert.equal(serializePresence(edge, true).browser, 'Edge');

  assert.equal(serializePresence({ ...ENTRY, userAgent: null }, true).browser, null);
});

test('internal state does not leave the process', () => {
  // Via `unknown`, because the point is to ask about keys the type says are absent.
  const row = serializePresence(ENTRY, true) as unknown as Record<string, unknown>;
  // The tenant id is not the board's business — it is already implied by the route.
  assert.equal(row.workspaceId, undefined);
  assert.equal(row.workspace_id, undefined);
  // A page COUNT is what the board renders. The full history is a browsing trail,
  // and shipping it to every connected agent on every presence tick is both a
  // privacy question nobody asked for and a payload that grows without bound.
  assert.equal(row.pages, undefined);
  assert.equal(row.ip, undefined);
});

test('an offline visitor is reported as offline rather than omitted', () => {
  // The sweep keeps an entry briefly after the socket drops, and the board dims it.
  // Dropping the row instead would make someone vanish mid-sentence.
  assert.equal(serializePresence(ENTRY, false).online, false);
});
