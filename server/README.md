# Nestled — server

Fastify 5 + Prisma 6 + PostgreSQL 16. ESM, Node 22, TypeScript. Tests with
`node --test`.

This is the whole backend: the customer API, the public widget plane, the
realtime sockets, and the vendor's own ops plane. Deployment lives in
[`../DEPLOY.md`](../DEPLOY.md).

## Run it locally

```bash
npm install
export DATABASE_URL='postgres://nestled:nestled@localhost:5544/nestled'
export JWT_ACCESS_SECRET=dev-secret-min-16-chars
export JWT_REFRESH_SECRET=dev-secret-min-16-chars
npx prisma migrate deploy     # apply the schema
# (`npm run migrate` is the same thing through db/migrate.ts, which also
#  percent-encodes the credentials — it runs from dist/, so it needs a build.
#  That is the entry point the compose release step uses.)
npm run seed        # a demo workspace with sample content (optional)
npm run dev         # tsx watch on :4000
```

`npm run seed` creates an Acme workspace with a website, knowledge base, canned
replies and starters, and prints the embed key. It is a **development
convenience and needs a source checkout** — the production image has no `tsx`,
so it cannot run there. Production bootstraps from `SEED_ADMIN_*` instead
(below).

## Tests

```bash
docker run -d --name nestled-test-db -e POSTGRES_USER=nestled \
  -e POSTGRES_PASSWORD=nestled -e POSTGRES_DB=nestled_test -p 5546:5432 postgres:16-alpine

export DATABASE_URL='postgres://nestled:nestled@localhost:5546/nestled_test'
export JWT_ACCESS_SECRET=test-secret-min-16-chars JWT_REFRESH_SECRET=test-secret-min-16-chars
export SETTINGS_KEY=test-settings-key
export NODE_ENV=test
npx prisma migrate deploy
npm test        # 393 tests, serial — they share one database
```

`SETTINGS_KEY` is not optional here even though it is optional in production:
one test asserts that a saved DeepL key is unreadable in the database, and
without a key encryption is a no-op, so it fails for the right reason.

They run with `--test-concurrency=1` on purpose: each file `TRUNCATE`s in its
`before`, and in parallel they delete each other's fixtures.

## The three planes

Nestled has three surfaces with three different authentications, and the
separation is structural rather than a naming convention.

**The customer plane** — `/api/v1/*`, a short-lived access JWT plus a rotating
refresh token. Everything tenant-scoped sits under `/api/v1/w/:workspaceId/…`:
the workspace is a **path segment**, not a claim in the token, so one token works
in several tabs on several workspaces and refresh stays stateless.

**The public widget plane** — `/api/v1/widget/*` and `/ws/presence`. Reachable
by an anonymous visitor on a customer's site. It resolves its tenant from an
unguessable website key, and the only per-conversation credential is a visitor
token the server minted.

**The vendor plane** — `/platform/*`, an opaque bearer session checked against
`platform_sessions` on every request. No JWT verifier is mounted there and
`/api/*` never reads those tables; both directions are pinned by a test.

## Tenant isolation, in three layers

1. **Structural.** Every tenant row carries `workspace_id NOT NULL`, and
   website-scoped children hang off composite foreign keys — so a cross-tenant
   reference is a Postgres error, not a code-review question.
2. **The scoped client** (`src/db/tenant.ts`). Routes get Prisma from `req.db`,
   which injects the workspace predicate and the member's per-website grants.
   `src/db/unscoped.ts` is blocked by ESLint outside a short allowlist; every
   exception carries its reason inline and is greppable:
   `grep -rn "no-restricted-imports --" src`.
3. **A boot assertion.** A model with `workspace_id` that is not registered in
   `TENANT_MODELS` refuses to start the process. Forgetting to register a new
   tenant table is the failure this exists to make impossible.

## API

Paths only — the shapes live next to the handlers, which is the version that
cannot go stale.

| Area | Routes |
|---|---|
| Auth | `POST /api/v1/auth/{signup,login,refresh,logout,verify-email,resend-verification,forgot-password,reset-password,change-password}`, `GET /api/v1/auth/slug-available`, `POST /api/v1/impersonation/claim` |
| Account | `GET|PATCH /api/v1/me` |
| Invitations | `GET /api/v1/invites/:token`, `POST /api/v1/invites/:token/accept` |
| Workspaces | `POST /api/v1/workspaces`, `GET|PATCH /api/v1/w/:id` |
| Websites | `/w/:id/websites`, `…/:websiteId`, `…/settings`, `…/hours`, `…/identity-secret`, `…/install-status` |
| Inbox | `/w/:id/conversations` and `…/:id/{messages,status,assign,tags,typing,notes}`, `/w/:id/translate` |
| Visitors | `/w/:id/presence`, `…/presence/:visitorId/start-chat`, `…/visitors/:visitorId/{ips,person}` |
| Content | `/w/:id/{kb,canned,starters}` and `…/:id` |
| Automation | `/w/:id/{triggers,routing,bots}`, `…/bots/:id/{publish,versions,rollback,simulate}` |
| Team | `/w/:id/{members,invites}` and `…/:id` |
| Billing | `GET /api/v1/plans`, `/w/:id/billing{,/checkout,/portal,/plan}`, `POST /api/v1/stripe/webhook` |
| Ops & usage | `/w/:id/{usage,audit,integrations}` |
| Push | `/api/v1/push/{public-key,subscribe,unsubscribe}` |
| Widget (public) | `/api/v1/widget/{boot,availability,session,offline-message}`, `…/conversations` and `…/:id/{messages,typing,rating,attributes,claim}`, `…/triggers/:id/fire` |
| Platform | `/platform/{auth,me,search,workspaces,plans,dunning,impersonations,health,settings,users}`, `GET|PATCH /platform/workspaces/:id/websites/:websiteId/prompt` |
| Realtime | `GET /ws/agent`, `/ws/visitor/:id`, `/ws/presence` |
| Health | `GET /healthz` |

## Bootstrap and configuration

`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` create the first **customer** user and
a workspace they own — but only while the `users` table is completely empty, and
then never again. `SEED_PLATFORM_EMAIL` / `SEED_PLATFORM_PASSWORD` do the same
for the first **staff** account, which starts read-only until a TOTP factor is
enrolled. Both run automatically at boot, before the server listens.

Almost nothing else is in the environment. AI keys, SMTP, Stripe, GeoIP, VAPID,
the public URLs and retention live in the `platform_settings` table and are
edited from the ops panel; `src/env.ts` documents the fourteen variables that
remain and why each one cannot move. The old variables still work as a fallback
layer beneath the database.

## Layout

```
src/
  index.ts              boot: assertions, migrations, seeds, plugins, routes
  env.ts                the fourteen environment variables, and why
  permissions.ts        3 customer roles, 34 capabilities, 14 platform scopes
  db/       tenant.ts   the scoped Prisma client — the enforcement core
            unscoped.ts the only real client; its docblock lists who may import it
  plugins/  auth.ts     requireAuth / requireWorkspace / can / requireVisitor / requirePlatform
  routes/   v1/*        the customer and widget planes
            platform/*  the vendor plane
  services/ ai, bot, billing, platform, email, geo, identity, push, discord
            ai/actions.ts    the token vocabulary: handoff, tag, resolve
            ai/preamble.ts   our instructions, resolved website → install → default
            ai/prompt.ts      assembly order: policy in front, safety and syntax last
  realtime/ hub, presence, replay, gateway
  lib/      limits, messages, usage, retention, jobs, audit, validate
  test/     *.test.ts
```
