# Deploying Nestled

All fourteen phases are merged. **213 server tests pass, both typechecks are
clean, ESLint reports zero errors, and the production images have been built and
exercised end to end** — signup, website creation, widget boot, a visitor
message, an agent reply, the billing state, and both directions of the
customer/staff auth wall.

Read "What is not verified" before you point real customers at it.

---

## The four surfaces

| Origin | What it is |
|---|---|
| `nestled.chat` | Marketing. Prerendered HTML — real documents, not an SPA shell. |
| `app.nestled.chat` | The customer panel. Inbox, visitors, websites, automation, settings. |
| `ops.nestled.chat` | Your own staff console. Separate auth mechanism; never indexed, never framed. |
| `widget.nestled.chat` | The visitor widget and `embed.js`. |

One container serves all four. In production each is a subdomain; the same nginx
config also serves them under `/app`, `/ops`, `/widget` path prefixes, and no
application code hardcodes either — every cross-surface URL comes from
`src/lib/origins.ts`.

Putting the widget on its own origin is a security decision, not a deployment
preference: the panel's tokens live in the app origin's storage, so a widget
running inside a customer's page physically cannot read them.

---

## 1. Environment

Fourteen variables, and only three you must think about. Everything else — the
AI key, SMTP, Stripe, GeoIP, VAPID, the public URLs, retention — is configured
in the **ops panel** at `https://ops.your-host/settings` and stored in the
database. Those are settings; you change them on a Tuesday afternoon, and in the
environment each change costs a container restart.

(The old variables still work as a fallback if you prefer config-as-code. They
are simply not required, and no longer listed in the compose files.)

Copy `.env.staging.example` and fill it in. **Every secret in it is a
placeholder:**

```bash
openssl rand -base64 48   # JWT secrets, POSTGRES_PASSWORD, SETTINGS_KEY
```

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres 16. The schema uses `ON DELETE SET NULL (col)`, which needs **PG 15+**. Compose builds it from `POSTGRES_*`. |
| `JWT_ACCESS_SECRET` | ≥16 chars. Cannot move into the database — it is what proves a request may reach the database. Rotating it signs out every agent AND invalidates every live widget session. |
| `JWT_REFRESH_SECRET` | ≥16 chars. |
| `ALLOWED_ORIGINS` | The **private** origins: app, ops, widget, marketing. Deployment topology, not a setting. Customer domains do NOT belong here — where a widget may run is per-website, in `websites.allowed_domains`. **Leaving out the widget origin makes every widget call fail in the browser with a CORS error that looks like the API is down.** The public URLs used in outbound email are derived from this list unless you set them in the ops panel. |

Optional but recommended:

| Variable | Why |
|---|---|
| `SETTINGS_KEY` | Encrypts the secrets you enter in the ops panel (AES-256-GCM). Without it they sit in the database in plain text — and while it already holds conversation history, a leaked backup containing a live Stripe key is a different category of problem, because that key moves money. Changing it makes existing stored secrets unreadable; they are reported as absent, loudly, and can be re-entered. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Creates the first **customer** user and their workspace on an empty database, then no-ops forever. |
| `SEED_PLATFORM_EMAIL` / `SEED_PLATFORM_PASSWORD` | Creates the first **staff** account for the ops panel. It can read everything and change nothing until a TOTP factor is enrolled — an identity provisioned from an env var should not be able to touch customer data on its own. |

The rest (`NODE_ENV`, `PORT`, `HOST`, `UPLOAD_DIR`, `MAX_UPLOAD_BYTES`,
`MIGRATE_ON_BOOT`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`) have working
defaults and are set by the compose files.

### What you configure in the ops panel

Sign in at `https://ops.your-host`, enrol TOTP, then open **Settings**:

- **AI** — provider, model, and the API key. This is *our* infrastructure, not
  the customer's: usage is metered per workspace. Without a key the AI degrades
  to knowledge-base answers.
- **Email** — SMTP host, credentials, from-address, and a **Send test** button.
  Without an SMTP host, mail is queued to `outbound_emails` and logged rather
  than sent; nothing is lost, but nobody receives a verification link.
- **Billing** — the Stripe secret and webhook signing secret. Without them plans
  and limits still apply (they are database facts); only checkout and the
  billing portal are disabled, which is a perfectly good self-hosted setup.
- **Web Push** — the VAPID keypair (`cd server && npm run vapid`).
- **IP geolocation** — a local GeoLite2 file or MaxMind web-service credentials.
- **URLs and operations** — the app and marketing URLs used in email links, a
  Sentry DSN, a retention override, and the staff session length.

Changes take effect immediately; nothing restarts. Secrets are write-only: the
panel reports whether one is set and its last four characters, never the value.

## 2. Deploy

```bash
docker compose -f docker-compose.production.yml up -d
```

Four services: `db`, a one-shot `migrate`, `app`, and `web`. The app waits for
the migration to exit successfully, so a failed migration stops the deploy rather
than half-starting it.

Verify:

```bash
curl https://your-host/healthz                # {"status":"ok","db":"up"}
curl -s https://your-host/ | grep -c '<h1'    # the landing page is real HTML
docker compose logs migrate                   # "All migrations have been successfully applied"
```

## 3. First run

Sign up at `https://app.your-host/signup`, or use `SEED_ADMIN_*`. The wizard
takes it from there: name the workspace, add a website, paste the snippet. The
install detector tells you the moment it sees your site, and if the snippet is
live on a host your allowlist does not cover it says so and offers to add it.

For the staff console, sign in at `https://ops.your-host` with `SEED_PLATFORM_*`
and enrol TOTP — until you do, the account can read everything and change
nothing.

---

## What is NOT verified

Be aware of these before a launch. None is a known defect; each is something
nobody has watched happen.

**The panel and the ops console have not been clicked through in a browser.**
Both typecheck, lint, build, and their API contracts are covered by integration
tests. The React rendering itself is not — no human and no headless browser has
used them. The widget, by contrast, *was* driven in a real browser end to end.

**Stripe has only been tested against a fake client.** The webhook route's branch
logic, all three idempotency mechanisms, out-of-order delivery and both checkout
arrival orders are covered — but Stripe's real HMAC signature verification and
real network calls are not. Run `stripe listen --forward-to
https://your-host/api/v1/stripe/webhook` and a test-mode subscribe → upgrade →
cancel before taking live payments.

**Email delivery has not been exercised against a real SMTP server.** The ops
panel's Settings page has a Send test button — use it before opening signup.

**Four widget features are stubbed pending server work**, listed in the widget
agent's notes and reproduced here so they are not discovered by a customer:

- **ContextCard renders nothing.** The component exists; the server has no
  presentation payload for it yet (`verifyContextToken` returns the raw verified
  bag). Signed attributes still reach the agent's sidebar — only the visitor-side
  card is missing.
- **No file attachments from the visitor.** `file_upload_enabled` is advertised
  in the boot payload but there is no widget attachment endpoint, so the
  paperclip was deliberately omitted rather than shipped broken.
- **`Nestled('startBot', …)`** resolves against configured starters rather than
  a dedicated endpoint.
- **Live view records only when explicitly enabled** on both the plan and the
  website setting. That is intended, but it means the toggle is the only thing
  standing between you and a feature that appears not to work.

**Session replay, campaigns and bot flows have unit and integration coverage but
no soak testing.** The replay buffer is bounded and LRU-evicted; nobody has run
it for a day.

---

## Operational constraints you must know

**Run exactly ONE app replica.** This is architectural, not tuning: agent
sockets, the presence board, the realtime catch-up buffer and the replay buffers
are per-process, so an agent connected to replica 1 never sees an event published
by replica 2. The rate limiter and the ops health counters have the same
constraint. Scale vertically; the ceiling is roughly 5–10k concurrent
WebSockets per process. Everything publishes through `realtime/hub.ts`, so the
Redis bus that lifts this is one file plus config.

**Uploads are on local disk** (`UPLOAD_DIR`, a mounted volume). `stored_files`
carries a `backend` column so S3 is a seam rather than a rewrite, but it is not
implemented.

**Retention is per plan.** `RETENTION_DAYS` is now only a self-host override;
otherwise each workspace's plan decides. `0` on both means keep forever.

**Rotating `JWT_ACCESS_SECRET`** signs out every agent AND invalidates every live
widget session, so visitors mid-conversation must reload. Do it during quiet
hours.

**Going over a conversation allowance does not break the widget.** It warns at
100% and only stops creating new conversations at 120%, falling back to
"leave your email". This is deliberate: refusing a conversation means a visitor
on a customer's production site gets a broken chat and the customer silently
loses a lead. AI replies are a hard stop at 100%, because each call costs real
money — they degrade to knowledge-base answers and then to a human.

**During billing grace the widget keeps serving.** A lapsed trial, a failed
payment and a cancellation all leave the widget live for the grace window while
the panel goes read-only except billing. Never break a prospect's production
site over billing.

## Security notes

- `.env.staging.example` previously contained real-looking secrets and **they are
  still in the git history. If any of those values were ever used on a real host,
  rotate them.**
- The pre-tenant build had a conversation-takeover hole on `/ws/presence`: it
  accepted an unauthenticated `visitor_id` and the proactive frame carried the
  conversation's own `visitor_token`. Two independent fixes are in place — a
  signed widget session, and a single-use 60-second claim token — and both are
  pinned by `server/src/test/presenceSecurity.test.ts`. **If you have an old
  deployment still running, that hole is live on it.**
- Staff impersonation requires a written reason, is capped at 30 minutes, has no
  refresh token, cannot touch billing, member management, integration secrets or
  data export, and writes every action into the **customer's own** audit log,
  where it is labelled as ours. A read-only session throws on the first write at
  the database-client layer, not just at the permission check.
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
npm test        # 213 tests, serial (they share one database)
```

From the repo root: `npm run typecheck && npx eslint . && npm run build`.
