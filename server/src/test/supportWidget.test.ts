import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { loadSettings, updateSettings } from '../services/platform/settings.js';

/**
 * Nestled's own support chat.
 *
 * Two properties carry the weight. It must be OFF unless somebody configured it —
 * a self-hosted install shipping our chat bubble to its operator would be both
 * baffling and a privacy leak. And the identity it hands our agents must be
 * SIGNED and must describe the caller only, because an endpoint that will
 * describe any workspace you name is a directory of every customer.
 */

let app: FastifyInstance;
let ownerToken: string;
let supportKey: string;
let identitySecret: string;

before(async () => {
  await unscopedPrisma.$executeRawUnsafe('TRUNCATE users, workspaces CASCADE');
  app = await buildServer();
  await app.ready();

  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      name: 'Ada Lovelace',
      email: 'ada@support.test',
      password: 'correct horse battery',
      workspace_name: 'Acme',
    },
  });
  ownerToken = signup.json().access_token;

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const workspaceId = me.json().workspaces[0].id;

  // Our own support website is an ordinary website in an ordinary workspace —
  // that is the point. Here the test's own workspace stands in for ours.
  const site = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: 'Nestled Support' },
  });
  supportKey = site.json().website.public_key;

  const secret = await app.inject({
    method: 'POST',
    url: `/api/v1/w/${workspaceId}/websites/${site.json().website.id}/identity-secret`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  identitySecret = secret.json().secret;
});

after(async () => {
  await unscopedPrisma.platform_settings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: { support_website_key: null },
  });
  await app.close();
  await unscopedPrisma.$disconnect();
});

beforeEach(async () => {
  await unscopedPrisma.platform_settings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: { support_website_key: null },
  });
  await loadSettings();
});

test('unconfigured, there is no support chat anywhere', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/support-widget' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { enabled: false, key: null });

  // And the panel is told the same thing, rather than being handed a token for a
  // widget that will never load.
  const ctx = await app.inject({
    method: 'GET',
    url: '/api/v1/me/support-context',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(ctx.json().enabled, false);
  assert.equal(ctx.json().context_token, null);
});

test('configured, the key is public — it is pasted into a page, after all', async () => {
  await updateSettings({ support_website_key: supportKey });

  const res = await app.inject({ method: 'GET', url: '/api/v1/support-widget' });
  assert.equal(res.statusCode, 200, 'the marketing site is anonymous and still needs this');
  assert.deepEqual(res.json(), { enabled: true, key: supportKey });
});

test('the panel gets a SIGNED description of who is asking', async () => {
  await updateSettings({ support_website_key: supportKey });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/me/support-context',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const token = res.json().context_token as string;
  assert.ok(token, 'a configured install must produce a token');

  // Signed with the support website's own secret — the same mechanism a customer
  // uses to vouch for their visitors, applied to ourselves. A token we cannot
  // verify is a token an agent should not trust.
  const payload = jwt.verify(token, identitySecret, { algorithms: ['HS256'] }) as {
    customer: { name: string; email: string };
    attributes: Record<string, unknown>;
    exp: number;
    iat: number;
  };

  assert.equal(payload.customer.email, 'ada@support.test');
  assert.equal(payload.customer.name, 'Ada Lovelace');
  assert.equal(payload.attributes.workspace, 'Acme');
  assert.equal(payload.attributes.role, 'owner');
  assert.equal(payload.attributes.can_manage_billing, true, 'an owner can');
  assert.ok(payload.exp > payload.iat, 'it must expire');
  assert.ok(payload.exp - payload.iat <= 24 * 60 * 60, 'and within the accepted lifetime');
});

test('the token describes the CALLER, whatever workspace is asked for', async () => {
  await updateSettings({ support_website_key: supportKey });

  // A second account with its own workspace, whose slug the first will now name.
  const other = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      name: 'Grace',
      email: 'grace@support.test',
      password: 'correct horse battery',
      workspace_name: 'Initech',
    },
  });
  const otherMe = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: `Bearer ${other.json().access_token}` },
  });
  const foreignSlug = otherMe.json().workspaces[0].slug;

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/me/support-context?workspace=${encodeURIComponent(foreignSlug)}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const payload = jwt.verify(res.json().context_token, identitySecret) as {
    attributes: Record<string, unknown>;
  };

  // Falls back to the caller's own workspace. An endpoint that described any
  // workspace you named would be a directory of every customer, signed by us.
  assert.equal(payload.attributes.workspace, 'Acme');
  assert.notEqual(payload.attributes.workspace, 'Initech');
});

test('an anonymous caller gets no identity token', async () => {
  await updateSettings({ support_website_key: supportKey });
  const res = await app.inject({ method: 'GET', url: '/api/v1/me/support-context' });
  assert.equal(res.statusCode, 401);
});

test('a key naming nothing degrades to an unidentified widget, not an error', async () => {
  await updateSettings({ support_website_key: 'nst_thiskeydoesnotexist' });

  // A misconfiguration should cost the identity, not the whole panel: throwing
  // here would take out every page load of the app over our own chat bubble.
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/me/support-context',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().context_token, null);
});
