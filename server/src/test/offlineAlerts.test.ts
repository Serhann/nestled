import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleData,
  emailBody,
  hasSomethingToReport,
  humanizeKey,
  isOffline,
  smsBody,
} from '../services/offlineAlerts/data.js';

/**
 * The alert somebody reads at 3am.
 *
 * Every test here is a pure function call, and that is the reason the assembly and the
 * gating were written as pure functions in the first place: this text IS the product for its
 * reader, and it is built from four differently-shaped JSON blobs — a bot run's `collected`,
 * a pre-chat form, the host site's signed attributes, and a handoff summary. A wrong merge
 * is an alert that names the wrong person or omits the phone number, and neither is
 * something a test needing Postgres and a socket hub would ever be run often enough to catch.
 */

const EMPTY = { visitorName: null, visitorEmail: null, collected: {}, prechat: {}, attributes: {}, summary: null, lastMessage: null };

// ── Offline is EITHER condition ──────────────────────────────────────────────

test('offline means nobody connected OR outside business hours', () => {
  assert.equal(isOffline(false, true), true, 'nobody connected, inside hours');
  assert.equal(isOffline(true, false), true, 'someone connected, outside hours');
  assert.equal(isOffline(false, false), true);
  // The only case that is not offline: somebody is there AND the shop is open.
  assert.equal(isOffline(true, true), false);
});

// ── Assembly ─────────────────────────────────────────────────────────────────

test('identity is lifted out of whichever blob carried it', () => {
  const data = assembleData({
    ...EMPTY,
    collected: { name: 'Ayşe Yılmaz', email: 'ayse@example.com', order_number: 'A-4417' },
  });
  assert.equal(data.name, 'Ayşe Yılmaz');
  assert.equal(data.email, 'ayse@example.com');
  // And not repeated in the field list, which would print the name twice.
  assert.deepEqual(data.fields, [{ label: 'Order number', value: 'A-4417' }]);
});

test('the conversation own columns win over a collected field', () => {
  // `visitor_email` is what the rest of the product treats as the address, so an alert that
  // named a different one would send somebody chasing the wrong person.
  const data = assembleData({
    ...EMPTY,
    visitorEmail: 'real@example.com',
    collected: { email: 'typo@example' },
  });
  assert.equal(data.email, 'real@example.com');
});

test('signed host attributes are marked as verified', () => {
  const data = assembleData({
    ...EMPTY,
    attributes: { plan: 'pro', customer: { name: 'Ada', email: 'ada@example.com' } },
  });
  assert.deepEqual(data.fields, [{ label: 'Verified · Plan', value: 'pro' }]);
  // The reserved `customer` object is identity, not a field to print as JSON.
  assert.equal(data.name, 'Ada');
  assert.equal(data.email, 'ada@example.com');
  assert.ok(!data.fields.some((f) => f.value.includes('{')));
});

test('what the visitor typed is listed before what the site asserted', () => {
  const data = assembleData({
    ...EMPTY,
    collected: { question: 'Where is my order?' },
    prechat: { company: 'Acme' },
    attributes: { plan: 'pro' },
  });
  assert.deepEqual(
    data.fields.map((f) => f.label),
    ['Question', 'Company', 'Verified · Plan'],
  );
});

test('a field is not printed twice when two blobs carry it', () => {
  const data = assembleData({ ...EMPTY, collected: { topic: 'billing' }, prechat: { topic: 'other' } });
  assert.equal(data.fields.length, 1);
  assert.equal(data.fields[0]?.value, 'billing', 'the visitor-typed value wins');
});

test('empty values are dropped rather than printed as blanks', () => {
  const data = assembleData({ ...EMPTY, collected: { a: '', b: null, c: undefined, d: 'kept' } });
  assert.deepEqual(data.fields, [{ label: 'D', value: 'kept' }]);
});

test('a long value is truncated, not sent whole', () => {
  const data = assembleData({ ...EMPTY, collected: { note: 'x'.repeat(1000) } });
  assert.ok((data.fields[0]?.value.length ?? 0) <= 300);
});

test('field names become readable labels', () => {
  assert.equal(humanizeKey('order_number'), 'Order number');
  assert.equal(humanizeKey('orderNumber'), 'Order number');
  assert.equal(humanizeKey('vat-id'), 'Vat id');
  assert.equal(humanizeKey(''), '');
});

// ── Nothing to say means nothing is sent ─────────────────────────────────────

test('a conversation with no details collected is not an alert', () => {
  // The service also declines to CLAIM in this case, so a field arriving later still
  // produces the real alert. An empty "somebody visited" email is how a team learns to
  // filter these to a folder they never open.
  assert.equal(hasSomethingToReport(assembleData(EMPTY)), false);
  assert.equal(
    hasSomethingToReport(assembleData({ ...EMPTY, lastMessage: 'hello?', summary: 'They said hello' })),
    false,
    'a message alone is not collected data',
  );
  assert.equal(hasSomethingToReport(assembleData({ ...EMPTY, collected: { size: 'L' } })), true);
  assert.equal(hasSomethingToReport(assembleData({ ...EMPTY, visitorEmail: 'a@b.com' })), true);
});

// ── The two bodies ───────────────────────────────────────────────────────────

test('the SMS says who, how to reach them, and where — and stays short', () => {
  const data = assembleData({
    ...EMPTY,
    collected: { name: 'Ayşe', email: 'ayse@example.com', phone: '+905551112233', order_number: 'A-4417' },
  });
  const text = smsBody(data, 'Kahve A.Ş.', 'https://app.example/w/kahve/inbox/abc');
  assert.match(text, /Ayşe/);
  assert.match(text, /ayse@example\.com/);
  assert.match(text, /inbox\/abc/);
  // The detail belongs in the email. An SMS is 70 characters per segment the moment a
  // Turkish "ş" appears, so a chatty alert is three messages every time.
  assert.doesNotMatch(text, /A-4417/);
});

test('the SMS still names somebody when there is no name', () => {
  const data = assembleData({ ...EMPTY, collected: { size: 'L' } });
  assert.match(smsBody(data, 'Shop', 'https://u'), /A visitor left details/);
});

test('the email carries everything, in a fixed order', () => {
  const data = assembleData({
    ...EMPTY,
    collected: { name: 'Ada', email: 'ada@example.com', order_number: 'A-1' },
    attributes: { plan: 'pro' },
    summary: 'Wants a refund on order A-1.',
    lastMessage: 'Can I get a refund?',
  });
  const body = emailBody(data);
  const lines = body.split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    'Name: Ada',
    'Email: ada@example.com',
    'Order number: A-1',
    'Verified · Plan: pro',
    'Summary: Wants a refund on order A-1.',
    'Last message: Can I get a refund?',
  ]);
});

test('the email omits lines it has nothing for', () => {
  const body = emailBody(assembleData({ ...EMPTY, collected: { size: 'L' } }));
  assert.equal(body, 'Size: L');
});
