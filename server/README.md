# JetChat Server (self-hosted backend)

Node 22 + TypeScript + Fastify + PostgreSQL. Replaces the former Supabase
backend (Postgres + RLS + edge functions + realtime) with a single self-hosted
service. This is **Phase 1** of the rebuild — backend migration + security
remediation. See `../REBUILD-TODO.md` for the full plan.

## ⚠️ Security: rotate the leaked OpenAI key

The Supabase prototype stored the OpenAI API key and Discord webhook URL **in
plaintext** in the `chat_settings` table, and its RLS policies let any anonymous
client `SELECT` that table. **Treat the OpenAI key previously stored there as
compromised and revoke/rotate it immediately** in the OpenAI dashboard. The old
Supabase anon key (in the repo's root `.env`) should also be considered exposed;
the Supabase project can be deleted once this backend is live.

In this backend, secrets live only in `private_settings` (admin-only) or the
server `.env`. No anonymous endpoint can reach them, and the settings API never
returns secret values — only masked previews (`••••abcd`).

## Architecture

```
Browser widget ──HTTP──▶  Fastify  ──▶ PostgreSQL
   (anon)        ──WS───▶  service  ◀── (migrations run on boot)
Admin panel  ──JWT HTTP─▶
   (agents)  ──WS(token)▶
```

Two auth planes, enforced in the app layer (there is **no** RLS — access control
is code, and secrets are physically separated into `private_settings`):

- **Agents** authenticate with email + password → JWT access token (15m) +
  rotating refresh token (stored hashed). Roles: `admin` | `agent`.
- **Visitors** get a per-conversation opaque token, returned once when the
  conversation is created. Every visitor request is scoped to that one
  conversation; a visitor can never read another conversation.

## Run locally (without Docker)

```bash
cd server
cp .env.example .env      # fill in JWT secrets + ANTHROPIC_API_KEY
npm install
# Point DATABASE_URL at a local Postgres 16, then:
npm run migrate           # apply schema
npm run dev               # tsx watch on :4000
```

Create the first admin: `POST /api/auth/register` (open only while zero agents
exist), or set `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` and run `npm run seed`.

## Run with Docker Compose (from repo root)

```bash
# Set at minimum JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ANTHROPIC_API_KEY,
# SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD in a root .env (compose reads it).
docker compose up --build
curl localhost:4000/healthz
```

The app runs migrations and seeds the first admin (from `SEED_ADMIN_*`) on boot
— both idempotent. If `POSTGRES_HOST_PORT` (default 5432) clashes with a local
Postgres, set it to a free port; the app reaches the DB over the compose network
regardless.

## API surface (Phase 1)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET  | `/api/widget-config` | none | Public widget config (no secrets) |
| POST | `/api/conversations` | none | Create conversation → `{conversation_id, visitor_token}` |
| GET  | `/api/conversations/:id/messages` | visitor token | Read own conversation |
| POST | `/api/conversations/:id/messages` | visitor token | Post message (may trigger AI reply) |
| POST | `/api/conversations/:id/typing` | visitor token | Typing indicator |
| POST | `/api/auth/register` | none (bootstrap) | First admin only |
| POST | `/api/auth/login` | none | → access + refresh tokens |
| POST | `/api/auth/refresh` | refresh token | Rotate tokens |
| POST | `/api/auth/logout` | refresh token | Revoke |
| GET  | `/api/auth/me` | agent JWT | Current agent |
| GET  | `/api/agent/conversations` | agent JWT | List / read / reply / status |
| GET  | `/api/settings` | admin JWT | Full config, secrets masked |
| PUT  | `/api/settings/public\|private` | admin JWT | Update (secrets write-only) |
| GET/POST/PATCH/DELETE | `/api/agents` | agent / admin | Roster + admin CRUD |
| GET/POST/PUT/DELETE | `/api/knowledge-base` | agent / admin | KB CRUD |
| GET  | `/api/triggers/active` | none | Active triggers for the embed |
| POST | `/api/conversations/:id/attachments` | visitor token | Upload a file/image |
| POST | `/api/agent/conversations/:id/attachments` | agent JWT | Agent uploads a file/image |
| GET  | `/api/attachments/:id` | visitor `?token=` or agent JWT/`?jwt=` | Serve a file |
| GET  | `/api/agent-status` | none | Is any agent online (widget header/fallback) |
| GET  | `/api/geo` | none | Caller's country (server GeoLite2) — replaces ipapi.co |
| GET  | `/api/agent/presence` | agent JWT | Live-visitor snapshot |
| POST | `/api/agent/presence/:visitorId/start-chat` | agent JWT | Proactive: create conv + pop widget |
| WS   | `/ws/presence?visitor_id=` | none | Host-page presence (hello/ping/update; receives `proactive`) |
| GET  | `/api/push/public-key` | none | VAPID public key + `enabled` flag |
| POST | `/api/push/subscribe` | agent JWT | Store this device's push subscription |
| POST | `/api/push/unsubscribe` | agent JWT | Remove this device |
| POST | `/api/push/resubscribe` | none (SW) | Re-attribute on `pushsubscriptionchange` |
| WS   | `/ws/agent?token=` | agent JWT | Realtime firehose; send `{type:'view',conversationId}` to suppress push while viewing |
| WS   | `/ws/visitor/:id?token=` | visitor token | This conversation's realtime |

## Rate limits

Conversation creation 3/min/IP · visitor messages 20/min · login 10/min ·
register 5/min · global floor 300/min. Exceeding returns 429.

## Web Push (Phase 2)

Real background Web Push replaces the old "notifications only while the app is
open" hack. Flow: generate VAPID keys → the admin PWA subscribes on an explicit
tap → the server pushes on a new conversation or a new visitor message.

Setup:

```bash
cd server
npm run vapid          # prints VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY=
# paste both into .env, then restart. Without them, push is disabled gracefully.
```

- Client integration lives in `../src/lib/push.ts` (`enablePush`/`disablePush`),
  wired into the admin login flow during the Phase 5 admin cutover. The service
  worker (`../public/sw.js`) shows the notification, deep-links to the
  conversation on click, re-subscribes on `pushsubscriptionchange`, and keeps an
  app-icon badge.
- An agent actively viewing a conversation (reported via the agent WS
  `{type:'view',conversationId}`) is **not** pushed for that conversation.
- Dead subscriptions are pruned automatically on 404/410 from the push service.
- Discord remains an optional **secondary** channel (server-side, URL from
  private settings or `.env`).

### iOS caveats

On iOS/iPadOS, Web Push requires **iOS 16.4+**, the app **added to the Home
Screen** (installed PWA — Safari tabs cannot receive push), and permission
requested from a **real user gesture** (that's why `enablePush` does the
`Notification.requestPermission()` call — bind it to a button, not page load).

## Live visitor presence + proactive chat (Phase 3)

Every visitor on the site — including anonymous ones who never open the chat —
appears on the agent's Live Visitors board in real time (Crisp's "see everyone
right now"). Presence runs in the **host page**, not the widget iframe.

- Host-page client: `../public/presence.js` (`JetChatPresence.init({apiBase,onProactive})`).
  It keeps a persistent `visitor_id` (localStorage), opens `/ws/presence`, sends
  a `hello` (url, referrer, UTM, device, screen, session start, new/returning),
  heartbeats every 25s, reports SPA navigations, and reconnects with backoff.
  Phase 4's embed rework loads it.
- Server keeps an in-memory presence registry (TTL-swept) and broadcasts the
  live list to agents over the agent WS as `presence:list` events;
  `GET /api/agent/presence` is the snapshot.
- **Proactive engagement:** from the board, an agent calls
  `POST /api/agent/presence/:visitorId/start-chat` → the server creates the
  conversation, seeds the agent's message, and pushes a `proactive` frame to the
  visitor's presence socket (with the conversation id + visitor token) so the
  widget pops open. If the visitor is offline, the conversation still exists and
  surfaces on their return (`delivered:false`).
- A visitor who has an open conversation carries its id on the presence entry
  (green-dot linkage in the conversation list).

### Geo-IP (MaxMind GeoLite2)

Geo runs server-side from a local GeoLite2 `.mmdb` — no per-request external API
(the old ipapi.co calls leaked IPs and would blow the free tier at one lookup
per pageload). Download `GeoLite2-City.mmdb` (free MaxMind account) into
`server/geoip/`, set `GEOLITE2_DB_PATH`, and it's used for conversation metadata,
the live board, and `/api/geo` (the trigger engine's country source — the
client-side ipapi.co removal itself is wired in Phase 8). Without the DB, geo is
disabled gracefully. Lookups are cached by IP.

## Widget & embed (Phase 4)

The customer widget (`../src/components/ChatWidget.tsx`) now runs entirely on
this backend — English-only copy (`../src/lib/strings.ts`), a typed client
(`../src/lib/api.ts`), REST + the visitor WebSocket. It has: unread badge, sound
with a mute toggle, typing indicators both directions, an online/offline agent
status in the header, file/image attachments, inline field validation (no more
`alert()`), an offline "leave a message" fallback, and proactive-chat adoption.
The old Notification-permission request, rrweb recording, and `NodeJS.Timeout`
browser type are gone.

**The click-swallowing fix:** the embed (`../public/embed.js`) no longer paints a
full-viewport transparent iframe. It renders a ~76×76 launcher iframe that covers
*only* the button; the widget `postMessage`s its desired size and the embed
resizes the iframe (full panel when open, full-screen on phones). The rest of the
host page's bottom-right corner is always clickable.

Embed snippet for jetfood.com:

```html
<script src="https://widget.jetfood.com/embed.js"
        data-api-base="https://api.jetfood.com"
        data-position="right" async></script>
```

`data-api-base` is this backend. The embed also loads `presence.js` (Phase 3) and
forwards proactive chats into the widget. Attachments: images/PDF/text ≤ 10 MB
(`MAX_UPLOAD_BYTES`), stored under `UPLOAD_DIR`, served only to the owning visitor
(via `?token=`) or an agent.

## Live session replay — MagicBrowse (Phase 9)

Rebuilt to record in the **host page** (the old version wrongly recorded inside
the widget iframe). `public/presence.js` lazy-loads `public/vendor/rrweb-record.min.js`
when `magic_browse_enabled`, records with `maskAllInputs` + blocked payment/PII
selectors + periodic full snapshots, and streams batched events over the presence
WS. The server (`realtime/replay.ts`) keeps a per-visitor buffer trimmed to the
latest snapshot and live-forwards to agents who "Watch" from the Live Visitors
board; the admin replays with `rrweb.Replayer({liveMode:true})`. Off by default,
per-site via the setting.

## Testing (Phase 10)

```bash
docker compose up -d db            # or any Postgres on :55432
cd server
DATABASE_URL=postgres://jetchat:jetchat@localhost:55432/jetchat npm test
```

`node:test` + Fastify `app.inject` (no socket). Covers the **Phase 1 security
regressions** (a visitor token cannot read another conversation; protected
endpoints 401; widget-config leaks no secrets), role enforcement (agent vs
admin), auth bootstrap/login, push subscribe/unsubscribe lifecycle, trigger
CRUD + fire analytics, and KB retrieval scoring.

## Ops & backups (Phase 10)

- **Health:** `GET /healthz` checks the DB.
- **Migrations + seed** run on boot (idempotent).
- **Errors:** a global handler logs with request context and never leaks
  internals; set `SENTRY_DSN` for a forwarding hook.
- **Retention:** set `RETENTION_DAYS > 0` to delete resolved conversations
  (and their on-disk attachments) daily.
- **Backup / restore** (Docker):

  ```bash
  # Backup (cron this)
  docker compose exec -T db pg_dump -U jetchat jetchat | gzip > backup-$(date +%F).sql.gz
  # Restore
  gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U jetchat jetchat
  ```

  Also back up the attachments volume (`jetchat_uploads`).

## Status

All 10 phases implemented. Device/browser-only checks (real push on a locked
phone, PWA install, on-device geo with a real GeoLite2 DB, rrweb replay
rendering) require a physical device / a licensed GeoLite2 file and are called
out in each section. The old Supabase-based components are fully replaced; a
Knowledge Base admin editor can reuse the existing `/api/knowledge-base` CRUD
(a small follow-up).
