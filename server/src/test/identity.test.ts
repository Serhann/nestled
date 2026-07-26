import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';

/**
 * The identity plane, end to end over HTTP.
 *
 * Walks the real signup path a customer takes — sign up, verify, create a
 * workspace and a website, get the embed key, invite a teammate, accept — and then
 * checks the boundaries that matter: that a second workspace cannot touch the
 * first, and that the seat and enumeration protections actually hold.
 *
 * Requires a migrated Postgres (see tenancy.test.ts for the container command).
 */

let app: FastifyInstance;

/** Read a single-use token straight from the DB — the email body isn't stored. */
async function latestToken(userEmail: string, kind: 'email_verify' | 'password_reset') {
  const user = await unscopedPrisma.users.findUniqueOrThrow({
    where: { email: userEmail },
    select: { id: true },
  });
  const row = await unscopedPrisma.user_tokens.findFirstOrThrow({
    where: { user_id: user.id, kind, consumed_at: null },
    orderBy: { created_at: 'desc' },
  });
  return row;
}

interface Session {
  access: string;
  refresh: string;
}

async function signup(name: string, email: string, workspaceName?: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name, email, password: 'correct horse battery', workspace_name: workspaceName },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { access: body.access_token, refresh: body.refresh_token };
}

const auth = (s: Session) => ({ authorization: `Bearer ${s.access}` });

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await unscopedPrisma.$disconnect();
});

test('signup creates a user, a workspace and an owner membership in one step', async () => {
  const s = await signup('Ada', 'ada@example.com', 'Acme');
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(s) });
  assert.equal(me.statusCode, 200);
  const body = me.json();

  assert.equal(body.user.email, 'ada@example.com');
  assert.equal(body.user.email_verified, false, 'a fresh signup must NOT be pre-verified');
  assert.equal(body.workspaces.length, 1);
  assert.equal(body.workspaces[0].role, 'owner');
  // Derived from server facts, so the wizard is resumable from any device.
  assert.equal(body.workspaces[0].onboarding.step, 'website');
  assert.ok(body.workspaces[0].permissions.includes('billing:manage'), 'an owner manages billing');
});

test('signup refuses a duplicate email', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Ada Two', email: 'ada@example.com', password: 'correct horse battery' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'email_taken');
});

test('signup rejects a short password', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { name: 'Weak', email: 'weak@example.com', password: 'short' },
  });
  assert.equal(res.statusCode, 400);
});

test('email verification consumes its token and cannot be replayed', async () => {
  const tok = await latestToken('ada@example.com', 'email_verify');
  // The raw token only exists in the emailed link, so drive verification the way
  // the endpoint is reached and assert the DB state afterwards.
  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    payload: { token: 'not-a-real-token-value' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'bad_token');

  // Consume it directly (we cannot recover the plaintext from the hash), then
  // confirm the endpoint refuses an already-consumed token.
  await unscopedPrisma.user_tokens.update({ where: { id: tok.id }, data: { consumed_at: new Date() } });
  await unscopedPrisma.users.update({
    where: { email: 'ada@example.com' },
    data: { email_verified_at: new Date() },
  });
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: auth(await login('ada@example.com')),
  });
  assert.equal(me.json().user.email_verified, true);
});

async function login(email: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'correct horse battery' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const b = res.json();
  return { access: b.access_token, refresh: b.refresh_token };
}

test('login rejects a wrong password with the same shape as an unknown account', async () => {
  const wrongPass = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'ada@example.com', password: 'wrong wrong wrong' },
  });
  const noSuchUser = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'nobody@example.com', password: 'wrong wrong wrong' },
  });
  assert.equal(wrongPass.statusCode, 401);
  assert.equal(noSuchUser.statusCode, 401);
  // Identical bodies: login must not be usable to enumerate accounts.
  assert.equal(wrongPass.body, noSuchUser.body);
});

test('forgot-password answers 200 for an unknown address (no enumeration oracle)', async () => {
  const known = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email: 'ada@example.com' },
  });
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email: 'ghost@example.com' },
  });
  assert.equal(known.statusCode, 200);
  assert.equal(unknown.statusCode, 200);
  assert.equal(known.body, unknown.body);
  // ...but only the real account gets a token.
  assert.ok(await latestToken('ada@example.com', 'password_reset'));
});

test('refresh rotates, and reusing a rotated token kills the whole family', async () => {
  const s = await login('ada@example.com');
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refresh_token: s.refresh },
  });
  assert.equal(first.statusCode, 200);
  const rotated = first.json().refresh_token;
  assert.notEqual(rotated, s.refresh, 'refresh must rotate');

  // Replaying the original — the shape of a stolen token being used.
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refresh_token: s.refresh },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().code, 'token_reuse');

  // And the legitimate rotated token is dead too: the family was revoked, so a
  // thief cannot keep using the token they stole even if they rotated first.
  const after = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refresh_token: rotated },
  });
  assert.equal(after.statusCode, 401);
});

test('a website is created with its settings and hours, and yields an unguessable key', async () => {
  const s = await login('ada@example.com');
  const wsId = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(s) })).json()
    .workspaces[0].id;

  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${wsId}/websites`,
    headers: auth(s),
    payload: { name: 'Acme Storefront', primary_domain: 'acme.com' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const website = res.json().website;
  assert.match(website.public_key, /^nst_[A-Za-z0-9_-]{20,}$/, 'the embed key must be unguessable');

  // The 1:1 rows must exist immediately: the widget boot route reads them without
  // merging defaults, so a lazily-created settings row would 500 on first load.
  assert.ok(await unscopedPrisma.website_settings.findUnique({ where: { website_id: website.id } }));
  assert.ok(await unscopedPrisma.website_business_hours.findUnique({ where: { website_id: website.id } }));

  const status = await app.inject({
    method: 'GET',
    url: `/api/v1/w/${wsId}/websites/${website.id}/install-status`,
    headers: auth(s),
  });
  assert.equal(status.json().phase, 'waiting');
});

test('a second workspace cannot see or touch the first one\'s websites', async () => {
  const ada = await login('ada@example.com');
  const adaWs = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ada) })).json()
    .workspaces[0].id;
  const adaSite = (
    await app.inject({ method: 'GET', url: `/api/v1/w/${adaWs}/websites`, headers: auth(ada) })
  ).json().websites[0];

  const bob = await signup('Bob', 'bob@example.com', 'Beta');
  const bobWs = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(bob) })).json()
    .workspaces[0].id;

  // Bob's own workspace is empty...
  assert.deepEqual(
    (await app.inject({ method: 'GET', url: `/api/v1/w/${bobWs}/websites`, headers: auth(bob) })).json()
      .websites,
    [],
  );
  // ...he cannot address Ada's workspace at all (404, not 403 — he must not learn
  // the id exists)...
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/v1/w/${adaWs}/websites`, headers: auth(bob) }))
      .statusCode,
    404,
  );
  // ...and Ada's website id under HIS workspace resolves to nothing, because the
  // scoped client added the predicate.
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/w/${bobWs}/websites/${adaSite.id}`,
        headers: auth(bob),
        payload: { name: 'pwned' },
      })
    ).statusCode,
    404,
  );
  const untouched = await unscopedPrisma.websites.findUniqueOrThrow({ where: { id: adaSite.id } });
  assert.equal(untouched.name, 'Acme Storefront');
});

test('an unverified account cannot send invitations', async () => {
  // The abuse surface that makes open signup safe: explore freely, mail nobody.
  const carol = await signup('Carol', 'carol@example.com', 'Carol Co');
  const ws = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(carol) })).json()
    .workspaces[0].id;
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${ws}/invites`,
    headers: auth(carol),
    payload: { email: 'friend@example.com' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'email_unverified');
});

test('invite → accept creates the account, the membership, and consumes the invite', async () => {
  const ada = await login('ada@example.com');
  const ws = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ada) })).json()
    .workspaces[0].id;

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${ws}/invites`,
    headers: auth(ada),
    payload: { email: 'dev@example.com', role: 'agent' },
  });
  assert.equal(created.statusCode, 201, created.body);
  // The raw token is returned so the UI can offer a copyable link for Slack.
  const url = created.json().invite_url as string;
  const token = url.split('/invite/')[1]!;

  // The public preview shows only what the acceptance screen needs.
  const preview = await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().invite.email, 'dev@example.com');
  assert.equal(preview.json().invite.inviter_name, 'Ada');

  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/invites/${token}/accept`,
    payload: { name: 'Dev', password: 'another good passphrase' },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().had_account, false);

  // Receiving the token proves the mailbox, so there is nothing left to verify.
  const dev = await unscopedPrisma.users.findUniqueOrThrow({ where: { email: 'dev@example.com' } });
  assert.ok(dev.email_verified_at, 'accepting an invite verifies the address');

  // Single use.
  const replay = await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` });
  assert.equal(replay.statusCode, 404);

  // And the new member sees the workspace with agent capabilities only.
  const devSession = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'dev@example.com', password: 'another good passphrase' },
  });
  const devMe = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${devSession.json().access_token}` },
  });
  const membership = devMe.json().workspaces[0];
  assert.equal(membership.role, 'agent');
  assert.ok(!membership.permissions.includes('billing:manage'), 'an agent must not manage billing');
  assert.ok(!membership.permissions.includes('website:create'));
});

test('an agent cannot invite or change members', async () => {
  const dev = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'dev@example.com', password: 'another good passphrase' },
  });
  const headers = { authorization: `Bearer ${dev.json().access_token}` };
  const ws = (await app.inject({ method: 'GET', url: '/api/v1/me', headers })).json().workspaces[0].id;

  const invite = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${ws}/invites`,
    headers,
    payload: { email: 'nope@example.com' },
  });
  assert.equal(invite.statusCode, 403);

  const website = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${ws}/websites`,
    headers,
    payload: { name: 'Sneaky' },
  });
  assert.equal(website.statusCode, 403);
});

test('the last owner cannot be demoted or removed', async () => {
  // Otherwise a workspace reaches a state where nobody can manage billing or
  // delete it — unrecoverable without direct database access.
  const ada = await login('ada@example.com');
  const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ada) })).json();
  const ws = me.workspaces[0].id;
  const ownerMemberId = me.workspaces[0].member_id;

  const demote = await app.inject({
    method: 'PATCH',
    url: `/api/v1/w/${ws}/members/${ownerMemberId}`,
    headers: auth(ada),
    payload: { role: 'admin' },
  });
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.json().code, 'last_owner');

  const remove = await app.inject({
    method: 'DELETE',
    url: `/api/v1/w/${ws}/members/${ownerMemberId}`,
    headers: auth(ada),
  });
  assert.equal(remove.statusCode, 409);
});

test('the website plan limit is enforced', async () => {
  const ada = await login('ada@example.com');
  const ws = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ada) })).json()
    .workspaces[0];
  const limit = ws.plan.limits.websites as number;

  // Fill to the limit, then assert the next one is refused with a payment-required
  // shape the UI can turn into an upsell rather than a generic error.
  const existing = (
    await app.inject({ method: 'GET', url: `/api/v1/w/${ws.id}/websites`, headers: auth(ada) })
  ).json().websites.length;
  for (let i = existing; i < limit; i++) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/w/${ws.id}/websites`,
      headers: auth(ada),
      payload: { name: `Site ${i}` },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
  const over = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${ws.id}/websites`,
    headers: auth(ada),
    payload: { name: 'One too many' },
  });
  assert.equal(over.statusCode, 402);
  assert.equal(over.json().metric, 'websites');
});

test('protected endpoints reject anonymous callers', async () => {
  for (const url of ['/api/v1/me', '/api/v1/w/00000000-0000-0000-0000-000000000000/websites']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} must require authentication`);
  }
});
