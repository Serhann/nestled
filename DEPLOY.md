# Deploying Nestled

Status as of the `Phases 5+6` commit. **Read the "What is not ready" section before
pointing customers at this** — the backend is complete and tested; the customer-facing
panel is not yet ported.

---

## What works today

The **API and realtime server** are production-shaped and verified end to end:

- self-serve signup, email verification, password reset, team invites
- workspaces, websites, per-website settings, business hours
- the public widget plane: boot, session, conversations, messages, ratings
- the agent inbox: list/filter/search, reply, assign, tags, notes, translation
- knowledge base, canned responses, conversation starters
- live visitor presence, proactive chat, session replay
- Web Push, Discord notifications, plan limits and usage metering
- tenant isolation enforced at three layers, with 75 passing tests

Verified on the built production image: migrations apply on boot, the first user
is seeded from env, `/healthz` reports the database up, and signup succeeds over
HTTP.

## What is NOT ready

**The customer-facing panel (`app.html`) still speaks the pre-tenant API.** It was
left intact through the backend rewrite deliberately — rewriting it against
endpoints that were still moving would have meant doing it twice — but it means:

- logging in through the browser UI will not work yet
- the widget bundle (`widget.html`) likewise still calls the old endpoints

Everything below deploys the **server**. Do that first; it is the half that has to
be right before anyone can use the other half.

Also not yet built (planned, not started): Stripe billing, the ops/staff panel,
the visual bot builder, and the marketing site. Plan limits are *enforced*, but
nobody can pay to raise them yet, so set plans manually in the database for now.

---

## 1. Environment

Copy `.env.staging.example` and fill in real values. **Every secret in that file is
a placeholder** — generate your own:

```bash
openssl rand -base64 48        # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, POSTGRES_PASSWORD
cd server && npm run vapid     # VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (Web Push)
```

Required:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres 16. The schema uses `ON DELETE SET NULL (col)`, which needs **PG 15+**. |
| `JWT_ACCESS_SECRET` | ≥16 chars. Rotating it invalidates every session and widget session. |
| `JWT_REFRESH_SECRET` | ≥16 chars. |
| `ALLOWED_ORIGINS` | The **private** app origins only. Customer domains do NOT belong here — where a widget may run is enforced per-website by `websites.allowed_domains`. |
| `APP_URL` | Used to build links in outbound email. Get this wrong and verification links point at the wrong host. |

Strongly recommended:

| Variable | Why |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `MAIL_FROM` | Without SMTP nothing is sent: emails are queued to `outbound_emails` and the body is logged. Signup verification and invites then require reading the log. |
| `ANTHROPIC_API_KEY` | AI replies are platform infrastructure (we hold the key, usage is metered per workspace). Without it the AI degrades to knowledge-base answers. |
| `VAPID_*` | Web Push. Absent, push is disabled gracefully. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Creates the first user **and their workspace** on first boot, then no-ops forever. |

## 2. Deploy

```bash
docker compose -f docker-compose.production.yml up -d
```

Migrations run automatically on boot and are idempotent.

To verify:

```bash
curl https://your-host/healthz                       # {"status":"ok","db":"up"}
docker compose logs app | grep -E 'migration|listening'
```

## 3. First run

`SEED_ADMIN_*` creates one user and one workspace on an empty database. Everyone
else signs up, or is invited.

To create a website and get an embed key without the panel:

```bash
TOKEN=$(curl -s -X POST https://your-host/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .access_token)

WS=$(curl -s https://your-host/api/v1/me \
  -H "Authorization: Bearer $TOKEN" | jq -r '.workspaces[0].id')

curl -s -X POST "https://your-host/api/v1/w/$WS/websites" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme","primary_domain":"acme.com"}' | jq .website.public_key
```

The embed snippet (once the widget is ported):

```html
<script>
  window.Nestled = window.Nestled || function(){(Nestled.q=Nestled.q||[]).push(arguments)};
  window.NestledId = "nst_...";
</script>
<script async src="https://widget.your-host/embed.js"></script>
```

---

## Operational constraints you must know

**Run exactly ONE app replica.** This is architectural, not a tuning preference:
agent sockets, the presence board and the replay buffers are per-process, so an
agent connected to replica 1 never sees an event published by replica 2. The
rate limiter's store has the same constraint. Scale vertically. Ceiling is roughly
5–10k concurrent WebSockets per process; the Redis bus that lifts it goes behind a
flag in Phase 14, and every publish already routes through `realtime/bus.ts` so it
is one file plus config.

**Migrations run on app boot.** Convenient now, a footgun later: with a slow
migration or a second replica it becomes a startup race. Moving it to a release
step is a tracked Phase 14 item.

**Uploads are on local disk** (`UPLOAD_DIR`, a mounted volume). `stored_files`
carries a `backend` column so S3 is a seam rather than a rewrite, but it is not
implemented.

**Retention is per plan.** `RETENTION_DAYS` now acts only as a self-host override;
otherwise each workspace's plan decides. `0` on both means keep forever.

**Rotating `JWT_ACCESS_SECRET`** signs out every agent AND invalidates every live
widget session, so visitors mid-conversation have to reload. Do it during quiet
hours.

## Security notes

- `.env.staging.example` previously contained real-looking secrets, and they are
  still in the git history. **If any of those values were ever used on a real
  host, rotate them.**
- The pre-tenant build had a conversation-takeover hole on `/ws/presence`. It is
  fixed and covered by `server/src/test/presenceSecurity.test.ts`. If you have an
  **old** deployment still running, that hole is live on it.
- Anything that bypasses tenant scoping is greppable by design:
  `grep -rn "no-restricted-imports --" server/src` lists every such import with
  its stated reason.

## Running the tests

```bash
docker run -d --name nestled-test-db -e POSTGRES_USER=nestled \
  -e POSTGRES_PASSWORD=nestled -e POSTGRES_DB=nestled_test -p 5546:5432 postgres:16-alpine

cd server
export DATABASE_URL='postgres://nestled:nestled@localhost:5546/nestled_test'
export JWT_ACCESS_SECRET=test-secret-min-16-chars JWT_REFRESH_SECRET=test-secret-min-16-chars
export NODE_ENV=test
npx prisma migrate deploy
npm test        # 75 tests, serial (they share one database)
```
