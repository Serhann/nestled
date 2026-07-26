import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * Regression tests for the presence takeover.
 *
 * THE BUG, as it existed in the pre-tenant build:
 *   `/ws/presence?visitor_id=…` accepted a client-supplied visitor id with no
 *   authentication, and `sendProactiveToVisitor` wrote a frame containing the
 *   conversation's `visitor_token` to every socket registered under that id. So
 *   anyone who opened `wss://…/ws/presence?visitor_id=<victim>` was handed a
 *   credential granting full read/write on that visitor's conversation.
 *
 * Two independent fixes are asserted here. Either alone would close it; both are
 * present so a future bug in one is not a breach:
 *   1. the socket requires a signed widget session, and takes the visitor id and
 *      website FROM THE TOKEN, never from the query string;
 *   2. the proactive frame carries a single-use, 60-second CLAIM token instead of
 *      the visitor token, and redeeming it requires the visitor's own session.
 *
 * These run against a real listening server rather than `inject`, because the
 * WebSocket upgrade is exactly the part being tested.
 */

let app: FastifyInstance;
let baseUrl: string;
let publicKey: string;

/** Connect, optionally say hello, and report how the socket ended. */
function probe(url: string, opts: { hello?: boolean } = {}): Promise<{
  opened: boolean;
  closeCode: number | null;
  frames: unknown[];
}> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames: unknown[] = [];
    let opened = false;
    const done = (closeCode: number | null) => resolve({ opened, closeCode, frames });

    ws.on('open', () => {
      opened = true;
      if (opts.hello !== false) ws.send(JSON.stringify({ type: 'hello', url: 'https://acme.com/' }));
    });
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)));
      } catch {
        frames.push(String(raw));
      }
    });
    ws.on('close', (code) => done(code));
    ws.on('error', () => done(null));
    // A socket still alive after this window counts as "accepted".
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        done(null);
      }
    }, 1500);
  });
}

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  // A real port: `inject` does not perform a WebSocket upgrade.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      name: 'Ada',
      email: 'presence@example.com',
      password: 'correct horse battery',
      workspace_name: 'Acme',
    },
  });
  const token = signup.json().access_token;
  await unscopedPrisma.users.update({
    where: { email: 'presence@example.com' },
    data: { email_verified_at: new Date() },
  });
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  const workspaceId = me.json().workspaces[0].id;
  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Acme Storefront' },
  });
  publicKey = site.json().website.public_key;
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

async function session(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/widget/session',
    payload: { key: publicKey },
  });
  return res.json().session_token as string;
}

test('the presence socket refuses a bare visitor_id — the old takeover vector', async () => {
  const r = await probe(`${baseUrl}/ws/presence?visitor_id=v_victim`);
  // The HTTP upgrade completes before the route handler runs, so the client does
  // briefly see `open`. What matters is that it is closed immediately with a policy
  // violation and that NOTHING is ever sent on it.
  assert.equal(r.closeCode, 1008, 'must be closed with a policy violation');
  assert.deepEqual(r.frames, [], 'no frame may be delivered to an unauthenticated socket');
});

test('the presence socket refuses a forged session token', async () => {
  const r = await probe(`${baseUrl}/ws/presence?token=not.a.real.token`);
  assert.equal(r.closeCode, 1008);
  assert.deepEqual(r.frames, []);
});

test('the presence socket refuses no credentials at all', async () => {
  const r = await probe(`${baseUrl}/ws/presence`);
  assert.equal(r.closeCode, 1008);
});

test('a valid widget session connects and stays connected', async () => {
  const r = await probe(`${baseUrl}/ws/presence?token=${await session()}`);
  // Closed by our own timeout (null), not by the server.
  assert.equal(r.closeCode, null, 'a legitimate widget session must not be closed');
  assert.equal(r.opened, true);
});

test('a proactive chat delivers a CLAIM token, never the visitor token', async () => {
  // Sign in as the agent, find the live visitor, and start a chat with them.
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'presence@example.com', password: 'correct horse battery' },
  });
  const token = login.json().access_token;
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  const workspaceId = me.json().workspaces[0].id;
  const websiteId = (
    await app.inject({
      method: 'GET',
      url: `/api/v1/w/${workspaceId}/websites`,
      headers: { authorization: `Bearer ${token}` },
    })
  ).json().websites[0].id;

  const sessionToken = await session();
  const visitorId = (
    await app.inject({ method: 'POST', url: '/api/v1/widget/session', payload: { key: publicKey } })
  ).json().visitor_id;

  // Hold a presence socket open with the SAME session, and capture what arrives.
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`${baseUrl}/ws/presence?token=${sessionToken}`);
  await new Promise<void>((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', url: 'https://acme.com/' }));
      setTimeout(resolve, 300);
    });
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  });

  // The visitor id in the session is the one presence registered under.
  const payload = JSON.parse(
    Buffer.from(sessionToken.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { vid: string };

  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/presence/${payload.vid}/start-chat`,
    headers: { authorization: `Bearer ${token}` },
    payload: { website_id: websiteId, message: 'Need a hand?' },
  });
  assert.equal(started.statusCode, 201, started.body);
  await new Promise((r) => setTimeout(r, 300));
  ws.close();

  const proactive = frames.find((f) => f.type === 'proactive');
  assert.ok(proactive, 'the visitor must receive the proactive frame');
  assert.ok(proactive.claim_token, 'a claim token must be delivered');
  // THE assertion this file exists for.
  assert.equal(
    proactive.visitor_token,
    undefined,
    'the conversation visitor_token must NEVER be put on the presence wire',
  );

  // And the claim is only redeemable by the visitor who owns that session.
  const otherSession = await session();
  const stolen = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${proactive.conversation_id}/claim`,
    payload: { claim_token: proactive.claim_token, session_token: otherSession },
  });
  assert.equal(stolen.statusCode, 401, 'a claim must not be redeemable with a different session');

  const redeemed = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${proactive.conversation_id}/claim`,
    payload: { claim_token: proactive.claim_token, session_token: sessionToken },
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  assert.ok(redeemed.json().visitor_token);

  // Single use: replaying it after redemption gets nothing.
  const replay = await app.inject({
    method: 'POST',
    url: `/api/v1/widget/conversations/${proactive.conversation_id}/claim`,
    payload: { claim_token: proactive.claim_token, session_token: sessionToken },
  });
  assert.equal(replay.statusCode, 401, 'a claim token must be single-use');
  assert.equal(visitorId.length > 0, true);
});
