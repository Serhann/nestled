import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { updateSettings } from '../services/platform/settings.js';
import { stripQuotedReply } from '../services/channels/emailBody.js';
import { isOptOut, smsSegments, verifyTwilioSignature } from '../services/channels/sms.js';
import { bareAddress, displayName } from '../routes/v1/channels.js';
import { channelVisitorId } from '../services/channels/inbound.js';

/**
 * Email and SMS as inbox channels.
 *
 * The inbound webhooks are the only routes in the application where an
 * unauthenticated stranger can put words into a paying customer's inbox, so most of
 * what is pinned here is about refusing to do that: signature required, closed until
 * configured, tenant decided by OUR address rather than by anything the sender
 * controls, and a redelivery that lands once rather than twice.
 */

let app: FastifyInstance;
let adaToken: string;
let bobToken: string;
let adaWs: string;
let bobWs: string;
let adaSite: string;
let bobSite: string;

const PASSWORD = 'correct horse battery';
const MAIL_SECRET = 'inbound-mail-shared-secret-value';
const TWILIO_TOKEN = 'twilio-test-auth-token';

async function signup(name: string, email: string, workspace: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: PASSWORD, workspace_name: workspace },
  });
  assert.equal(res.statusCode, 201, res.body);
  await unscopedPrisma.users.update({ where: { email }, data: { email_verified_at: new Date() } });
  return res.json().access_token as string;
}

async function workspaceOf(token: string): Promise<string> {
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return me.json().workspaces[0].id as string;
}

async function makeWebsite(token: string, workspaceId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().website.id as string;
}

function addEndpoint(
  token: string,
  workspaceId: string,
  websiteId: string,
  payload: { channel: string; address: string; label?: string },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites/${websiteId}/channels`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function inboundMail(
  payload: Record<string, unknown>,
  signature: string | null = MAIL_SECRET,
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/channels/email/inbound',
    headers: signature === null ? {} : { 'x-nestled-signature': signature },
    payload,
  });
}

/** Sign a form body the way Twilio does, so the happy path is actually exercised. */
function twilioSigned(params: Record<string, string>, url: string, token = TWILIO_TOKEN) {
  const signed =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(signed, 'utf8')).digest('base64');
}

function inboundSms(params: Record<string, string>, opts: { signature?: string; host?: string } = {}) {
  const host = opts.host ?? 'api.test';
  const url = `https://${host}/api/v1/channels/sms/inbound`;
  return app.inject({
    method: 'POST',
    url: '/api/v1/channels/sms/inbound',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host,
      'x-forwarded-proto': 'https',
      'x-twilio-signature': opts.signature ?? twilioSigned(params, url),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  await updateSettings({
    inbound_mail_secret: MAIL_SECRET,
    inbound_mail_domain: 'inbox.test',
    twilio_account_sid: 'ACtest',
    twilio_auth_token: TWILIO_TOKEN,
  });

  adaToken = await signup('Ada', 'ada@example.com', 'Acme');
  bobToken = await signup('Bob', 'bob@example.com', 'Globex');
  adaWs = await workspaceOf(adaToken);
  bobWs = await workspaceOf(bobToken);
  adaSite = await makeWebsite(adaToken, adaWs, 'Acme Site');
  bobSite = await makeWebsite(bobToken, bobWs, 'Globex Site');

  assert.equal(
    (await addEndpoint(adaToken, adaWs, adaSite, {
      channel: 'email',
      address: 'help@inbox.test',
      label: 'Acme Support',
    })).statusCode,
    201,
  );
  assert.equal(
    (await addEndpoint(adaToken, adaWs, adaSite, { channel: 'sms', address: '+15550001111' }))
      .statusCode,
    201,
  );
  assert.equal(
    (await addEndpoint(bobToken, bobWs, bobSite, { channel: 'email', address: 'help@globex.test' }))
      .statusCode,
    201,
  );
});

after(async () => {
  await app.close();
  await updateSettings({
    inbound_mail_secret: '',
    inbound_mail_domain: '',
    twilio_account_sid: '',
    twilio_auth_token: '',
  });
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  await unscopedPrisma.$disconnect();
});

// ── The webhooks refuse strangers ───────────────────────────────────────────

test('inbound mail without a signature is refused', async () => {
  const res = await inboundMail(
    { from: 'x@example.com', to: 'help@inbox.test', text: 'hi', message_id: '<a@x>' },
    null,
  );
  assert.equal(res.statusCode, 401, res.body);
});

test('inbound mail with a wrong signature is refused', async () => {
  const res = await inboundMail(
    { from: 'x@example.com', to: 'help@inbox.test', text: 'hi', message_id: '<b@x>' },
    'not-the-secret-but-same-length!!',
  );
  assert.equal(res.statusCode, 401, res.body);
});

test('inbound SMS with a wrong signature is refused', async () => {
  const res = await inboundSms(
    { From: '+15551234567', To: '+15550001111', Body: 'hello', MessageSid: 'SM1' },
    { signature: 'wrong' },
  );
  assert.equal(res.statusCode, 401, res.body);
});

test('a signature computed for a different URL is refused', async () => {
  // Twilio signs the URL. Accepting a signature made for another host would let a
  // capture from any other Twilio integration be replayed at us.
  const params = { From: '+15551234567', To: '+15550001111', Body: 'hi', MessageSid: 'SM-url' };
  const forElsewhere = twilioSigned(params, 'https://evil.test/api/v1/channels/sms/inbound');
  const res = await inboundSms(params, { signature: forElsewhere, host: 'api.test' });
  assert.equal(res.statusCode, 401, res.body);
});

// ── Tenant routing ──────────────────────────────────────────────────────────

test('the workspace comes from OUR address, not from the sender', async () => {
  const res = await inboundMail({
    from: 'Ayşe <ayse@example.com>',
    to: 'help@inbox.test',
    subject: 'Order',
    text: 'Where is my order?',
    message_id: '<route-1@example.com>',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'accepted');

  const conv = await unscopedPrisma.conversations.findFirst({
    where: { channel: 'email', channel_address: 'ayse@example.com' },
    select: { workspace_id: true, website_id: true, visitor_name: true, source: true, channel: true },
  });
  assert.equal(conv?.workspace_id, adaWs);
  assert.equal(conv?.website_id, adaSite);
  assert.equal(conv?.visitor_name, 'Ayşe');
  assert.equal(conv?.source, 'inbound');
  // Ada's inbox, and nothing of Bob's.
  const bobConvs = await unscopedPrisma.conversations.count({ where: { workspace_id: bobWs } });
  assert.equal(bobConvs, 0);
});

test('an address nobody owns is accepted-and-dropped, not an error', async () => {
  // A 4xx or 5xx makes the provider redeliver a message that will never have a home.
  const res = await inboundMail({
    from: 'stranger@example.com',
    to: 'nobody@inbox.test',
    text: 'hello?',
    message_id: '<unrouted-1@example.com>',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'unrouted');
});

test('one address cannot be claimed by two workspaces', async () => {
  // The unique index is what makes inbound routing unambiguous.
  const res = await addEndpoint(bobToken, bobWs, bobSite, {
    channel: 'email',
    address: 'help@inbox.test',
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'address_taken');
  // And it must not reveal who holds it.
  assert.ok(!res.body.includes('Acme'), res.body);
  assert.ok(!res.body.includes(adaWs), res.body);
});

test('a website id from another workspace cannot have an endpoint attached', async () => {
  const res = await addEndpoint(bobToken, bobWs, adaSite, {
    channel: 'email',
    address: 'sneaky@inbox.test',
  });
  assert.ok(res.statusCode >= 400, `expected a refusal, got ${res.statusCode}`);
  const leaked = await unscopedPrisma.channel_endpoints.findFirst({
    where: { address: 'sneaky@inbox.test' },
  });
  assert.equal(leaked, null);
});

test('one workspace cannot list or delete another workspace’s endpoints', async () => {
  const mine = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${bobWs}/websites/${bobSite}/channels`,
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.deepEqual(
    mine.json().endpoints.map((e: { address: string }) => e.address),
    ['help@globex.test'],
  );

  const adasEndpoint = await unscopedPrisma.channel_endpoints.findFirstOrThrow({
    where: { workspace_id: adaWs, channel: 'email' },
    select: { id: true },
  });
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${bobWs}/websites/${bobSite}/channels/${adasEndpoint.id}`,
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(del.statusCode, 404, del.body);
  assert.ok(
    await unscopedPrisma.channel_endpoints.findUnique({ where: { id: adasEndpoint.id } }),
    'Ada’s endpoint survived',
  );
});

// ── Redelivery ──────────────────────────────────────────────────────────────

test('a redelivered webhook lands once', async () => {
  const payload = {
    from: 'dup@example.com',
    to: 'help@inbox.test',
    text: 'Only once please',
    message_id: '<dup-1@example.com>',
  };
  const first = await inboundMail(payload);
  assert.equal(first.json().status, 'accepted');

  const second = await inboundMail(payload);
  // 2xx, and reported as a duplicate. A 500 here makes the provider retry harder.
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().status, 'duplicate');

  const count = await unscopedPrisma.messages.count({
    where: { workspace_id: adaWs, content: 'Only once please' },
  });
  assert.equal(count, 1);
});

test('two concurrent deliveries of the same message still land once', async () => {
  // The unique constraint, not a prior lookup, is what makes this safe: both of these
  // pass a findFirst and only one survives the insert.
  const payload = {
    from: 'race@example.com',
    to: 'help@inbox.test',
    text: 'Raced',
    message_id: '<race-1@example.com>',
  };
  const [a, b] = await Promise.all([inboundMail(payload), inboundMail(payload)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const count = await unscopedPrisma.messages.count({
    where: { workspace_id: adaWs, content: 'Raced' },
  });
  assert.equal(count, 1);
});

test('a second message from the same person joins the same conversation', async () => {
  await inboundMail({
    from: 'thread@example.com',
    to: 'help@inbox.test',
    text: 'First question',
    message_id: '<thread-1@example.com>',
  });
  await inboundMail({
    from: 'thread@example.com',
    to: 'help@inbox.test',
    text: 'And another thing',
    message_id: '<thread-2@example.com>',
  });
  const convs = await unscopedPrisma.conversations.findMany({
    where: { workspace_id: adaWs, channel_address: 'thread@example.com' },
    select: { id: true },
  });
  assert.equal(convs.length, 1);
  const messages = await unscopedPrisma.messages.count({
    where: { conversation_id: convs[0]!.id, sender_type: 'visitor' },
  });
  assert.equal(messages, 2);
});

// ── SMS ─────────────────────────────────────────────────────────────────────

test('a signed SMS lands in the right inbox', async () => {
  const res = await inboundSms({
    From: '+15551234567',
    To: '+15550001111',
    Body: 'Is my parcel out for delivery?',
    MessageSid: 'SM-ok-1',
  });
  // 204: Twilio reads a body as TwiML to send back, and we send nothing back.
  assert.equal(res.statusCode, 204, res.body);

  const conv = await unscopedPrisma.conversations.findFirst({
    where: { channel: 'sms', channel_address: '+15551234567' },
    select: { workspace_id: true, visitor_email: true, visitor_token_hash: true },
  });
  assert.equal(conv?.workspace_id, adaWs);
  // A phone number is not an email address, and writing it into visitor_email would
  // break every path that trusts that column.
  assert.equal(conv?.visitor_email, null);
  // No visitor token on a channel where nothing can present one.
  assert.equal(conv?.visitor_token_hash, null);
});

test('STOP is recorded in the thread so the agent can see the channel is closed', async () => {
  await inboundSms({
    From: '+15559998888',
    To: '+15550001111',
    Body: 'STOP',
    MessageSid: 'SM-stop-1',
  });
  const message = await unscopedPrisma.messages.findFirst({
    where: { workspace_id: adaWs, content: { contains: 'opted out' } },
    select: { content: true },
  });
  assert.ok(message, 'the opt-out is visible in the thread');
  assert.match(message!.content, /STOP/);
});

// ── The webhooks are closed when unconfigured ───────────────────────────────

test('with no secret configured, inbound mail is closed rather than open', async () => {
  await updateSettings({ inbound_mail_secret: '' });
  const res = await inboundMail(
    { from: 'x@example.com', to: 'help@inbox.test', text: 'hi', message_id: '<closed-1@x>' },
    'anything',
  );
  assert.equal(res.statusCode, 503, res.body);
  await updateSettings({ inbound_mail_secret: MAIL_SECRET });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('address parsing', () => {
  assert.equal(bareAddress('Ada Lovelace <ada@example.com>'), 'ada@example.com');
  assert.equal(bareAddress('  ADA@Example.COM '), 'ada@example.com');
  assert.equal(displayName('"Ada Lovelace" <ada@example.com>'), 'Ada Lovelace');
  assert.equal(displayName('Ada Lovelace <ada@example.com>'), 'Ada Lovelace');
  assert.equal(displayName('ada@example.com'), null);
});

test('a channel identity is stable and case-insensitive', () => {
  // Two casings of one address must not become two people in the identity graph.
  assert.equal(channelVisitorId('email', 'Ada@Example.com'), 'email:ada@example.com');
  assert.equal(channelVisitorId('email', ' ada@example.com '), 'email:ada@example.com');
});

test('quoted history is cut, and never at the cost of the whole message', () => {
  assert.equal(
    stripQuotedReply('Thanks, that worked!\n\nOn Mon, 3 Feb 2026, Support wrote:\n> Try this\n> and this'),
    'Thanks, that worked!',
  );
  assert.equal(
    stripQuotedReply('Tamam oldu.\n\n27 Tem 2026 tarihinde Destek şunları yazdı:\n> Şunu dene'),
    'Tamam oldu.',
  );
  assert.equal(stripQuotedReply('Fixed it.\n\n-- \nSent from my phone'), 'Fixed it.');
  // A single quoted line above a reply is a deliberate quote, not a history.
  assert.equal(
    stripQuotedReply('> the tracking link\nThat link is broken.'),
    '> the tracking link\nThat link is broken.',
  );
  // The safety net: bottom-posted, so a cut would leave nothing. Keep it all rather
  // than throwing away the customer's only words.
  assert.equal(
    stripQuotedReply('On Mon, Support wrote:\n> anything else?\nYes — one more question.'),
    'On Mon, Support wrote:\n> anything else?\nYes — one more question.',
  );
  assert.equal(stripQuotedReply('   '), '');
});

test('SMS segments: one emoji triples the price of a long message', () => {
  assert.deepEqual(smsSegments('hello'), { segments: 1, encoding: 'GSM-7' });
  assert.deepEqual(smsSegments('a'.repeat(160)), { segments: 1, encoding: 'GSM-7' });
  assert.deepEqual(smsSegments('a'.repeat(161)), { segments: 2, encoding: 'GSM-7' });
  // A Turkish ş is not in GSM-7, so the whole message becomes UCS-2 at 70 per segment.
  const withTurkish = smsSegments('ş'.repeat(100));
  assert.equal(withTurkish.encoding, 'UCS-2');
  assert.equal(withTurkish.segments, 2);
  assert.equal(smsSegments('🎉').encoding, 'UCS-2');
});

test('opt-out keyword matching follows Twilio’s own list', () => {
  for (const word of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'QUIT']) {
    assert.equal(isOptOut(word), true, word);
  }
  for (const word of ['stop it', 'please stop', 'hello', '']) {
    assert.equal(isOptOut(word), false, word);
  }
});

test('Twilio signature verification accepts only the exact signed string', () => {
  const url = 'https://api.test/hook';
  const params = { B: '2', A: '1' };
  const good = twilioSigned(params, url);
  assert.equal(verifyTwilioSignature(url, params, good, TWILIO_TOKEN), true);
  // Params sorted differently produce the same signature — order of the object keys
  // must not matter, only the sorted concatenation.
  assert.equal(verifyTwilioSignature(url, { A: '1', B: '2' }, good, TWILIO_TOKEN), true);
  assert.equal(verifyTwilioSignature(url, { A: '1', B: '3' }, good, TWILIO_TOKEN), false);
  assert.equal(verifyTwilioSignature('https://other.test/hook', params, good, TWILIO_TOKEN), false);
  assert.equal(verifyTwilioSignature(url, params, good, 'wrong-token'), false);
  assert.equal(verifyTwilioSignature(url, params, undefined, TWILIO_TOKEN), false);
  assert.equal(verifyTwilioSignature(url, params, good, null), false);
});
