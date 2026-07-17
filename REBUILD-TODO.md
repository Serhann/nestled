# JetChat Rebuild — Full TODO / Implementation Prompt

> Feed this document (or one phase at a time) to your AI coding tool. Work through the phases in order — Phase 1 and 2 are blocking; nothing ships before they're done.

## Context

This repo is a self-hosted live-chat + AI chatbot platform intended to replace a $100/month Crisp subscription for **jetfood.com** (a US food-ordering platform). It was prototyped with React + Vite + TypeScript on the frontend and **Supabase** (Postgres + RLS + edge functions + realtime) on the backend.

**Decision: we are dropping Supabase entirely.** The project must be migrated to a fully self-hosted backend (see Target Architecture). All `@supabase/supabase-js` usage, `supabase/migrations/`, and `supabase/functions/` must be replaced.

The owner's must-have feature set (what Crisp currently provides):

1. Live chat widget embedded on jetfood.com via one `<script>` tag
2. **Live visitor board** — see every visitor currently browsing the site in real time (not just people who opened the chat), and start a conversation with them proactively
3. **Reply from a phone** — installable PWA admin panel that is genuinely usable on mobile
4. **Real push notifications** — background Web Push when a new message/conversation arrives, working on Android and iOS (16.4+, installed PWA), even when the app is closed
5. AI auto-replies with a knowledge base, with clean handoff to humans

A security audit of the prototype found critical flaws that MUST be fixed (Phase 1). Known-broken items from the audit are listed inside each phase.

## Target Architecture

- **Backend:** Node.js 22 + TypeScript + Fastify (or Express), single service
- **Database:** PostgreSQL 16, plain SQL migrations (e.g. `node-pg-migrate` or Drizzle). Port the existing schema concepts: `conversations`, `messages`, `knowledge_base`, `agents`, `chat_settings`, `triggers` (+ its child tables). Drop the unused `embedding vector(1536)` column unless Phase 7 implements embeddings.
- **Realtime:** WebSocket server (socket.io or `ws`) on the same service. Replaces all Supabase realtime channels (`postgres_changes` subscriptions in `ChatWidget.tsx`, `ConversationsList.tsx`, `ChatPanel.tsx`).
- **Frontend:** keep React + Vite + TS. Replace `src/lib/supabase.ts` with a small typed API client (REST for CRUD, WS for realtime).
- **Edge function replacements:** `track-visitor`, `chatbot-ai`, `discord-notify` become backend routes/services.
- **Deploy:** Docker Compose (app + postgres). All secrets via server-side `.env` only.

## Global rules (apply to every phase)

- **All customer-facing copy in English.** The current widget contains Turkish strings (`ChatWidget.tsx`, `embed.js` comments, `alert('Lütfen...')` at ChatWidget.tsx:360). JetFood serves US customers — no Turkish may ever render to a site visitor. Admin panel UI: English too.
- **No secrets in the client, ever.** OpenAI/Anthropic keys, Discord webhook URLs, VAPID private key live only in server `.env`. The client bundle and every API response must be free of them.
- **Two auth planes:** Agents authenticate with email+password → JWT (access + refresh). Visitors get a per-conversation random token (returned once at conversation creation, stored in the widget's localStorage) — every visitor read/write is scoped to that conversation via the token. No endpoint may return data outside the caller's scope.
- **TypeScript strict mode**, shared types package/folder between widget, admin, and server.
- Keep code deterministic and boring; no speculative abstractions.

---

## Phase 1 — Backend migration + security remediation (BLOCKING)

The prototype's Supabase RLS policies made everything public: any visitor with the anon key could read **all conversations** (names, emails, IPs, geolocation), read/inject **all messages**, and `SELECT` the `chat_settings` table which stores the **OpenAI API key and Discord webhook URL in plaintext** (policies in `supabase/migrations/20251227153155_create_chatbot_system.sql:157-241`, key column added in `...155950_add_ai_settings_columns.sql:46`). The migration to our own backend must make this class of bug impossible.

TODO:

- [ ] Scaffold the Node/Fastify + Postgres backend with migrations porting the existing tables. Write a data-export note (if any production data exists in Supabase, provide a `pg_dump`-based import script).
- [ ] Auth: agent register/login/refresh endpoints (bcrypt + JWT). First registered user becomes `admin` role; subsequent agent creation is admin-only (fixes the open signup trigger from `...154322_fix_agent_signup_with_trigger.sql`).
- [ ] Visitor scope: `POST /api/conversations` creates a conversation and returns `{conversation_id, visitor_token}`. All widget endpoints (`GET/POST messages`, typing, etc.) require the token and are scoped to that single conversation.
- [ ] Settings: split into `public_settings` (widget color, position, welcome text, prechat fields — safe for anon `GET /api/widget-config`) and `private_settings` (AI provider config, Discord webhook — admin-JWT-only, and secret VALUES are write-only: API returns `"sk-...redacted"` style masks).
- [ ] Move all AI calls server-side (see Phase 7); the widget never talks to an AI provider directly.
- [ ] Rate limiting: conversation creation (e.g. 3/min/IP), message posting (e.g. 20/min/conversation), login attempts. Return 429s.
- [ ] CORS locked to `https://www.jetfood.com` + `https://jetfood.com` (+ localhost in dev) — replaces the `*` CORS on all three edge functions.
- [ ] Basic audit log table for admin actions (settings changes, agent CRUD).
- [ ] Rotate/revoke note in README: the OpenAI key previously stored in Supabase `chat_settings` must be treated as leaked and rotated.

Acceptance: an anonymous client can only (a) fetch public widget config, (b) create a conversation, (c) read/write its own conversation via its token. Everything else 401/403s. `npm run typecheck` passes; app boots via `docker compose up`.

## Phase 2 — Real Web Push notifications (BLOCKING — the Crisp-app replacement)

Today there is **no push**: `public/sw.js:54-72` has a `push` listener but nothing ever subscribes (`pushManager`/VAPID appear nowhere in the codebase), and "notifications" only work while the app is open (`registerSW.ts:36-40` postMessage hack). The only background channel is the one-way Discord webhook.

TODO:

- [ ] Generate VAPID keys (`web-push` npm package); public key served via config endpoint, private key in `.env`.
- [ ] Admin PWA: after login, request Notification permission **on explicit user action** (a "Enable notifications" button — required for iOS), call `registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey})`, and POST the subscription to the server.
- [ ] Server: `push_subscriptions` table (per agent, multiple devices). Send push via `web-push` on: new conversation, new visitor message in an unassigned or your-assigned conversation. Payload: conversation id, visitor name/page, message preview.
- [ ] `sw.js`: rewrite `push` handler to show the notification from the payload; `notificationclick` opens/focuses the admin panel deep-linked to that conversation.
- [ ] Handle subscription lifecycle: prune subscriptions on 404/410 responses from the push service; re-subscribe on `pushsubscriptionchange`.
- [ ] Do not notify the agent who is actively viewing that conversation (track active conversation over WS).
- [ ] Badge count via `navigator.setAppBadge` where supported.
- [ ] iOS notes in README: push requires iOS 16.4+, app must be added to Home Screen, permission must come from a user gesture.
- [ ] Keep the Discord webhook as an optional secondary channel (server-side, URL from `.env`/private settings).

Acceptance: with the PWA installed and closed on a phone (Android + iOS 16.4+), sending a message from the widget produces a push notification within seconds; tapping it opens that conversation.

## Phase 3 — Live visitor presence + proactive chat

Today only visitors who **open a conversation** are tracked (metadata collected in `ChatWidget.tsx:184-258`, geolocated by the `track-visitor` function). There is no anonymous presence — Crisp's "see everyone on the site right now" doesn't exist.

TODO:

- [ ] `embed.js` (host-page context): on load, open a lightweight WS presence connection (or heartbeat POST every 20–30s) with a persistent anonymous `visitor_id` (localStorage) sending: current URL, referrer, UTM params, device type, screen size, session start time. Update on SPA navigation (`popstate` + history patch).
- [ ] Server keeps an in-memory (or Redis-free, Postgres-backed with TTL) presence registry; broadcasts the live list to admin clients over WS.
- [ ] Geo-IP server-side: use local MaxMind GeoLite2 database (free, no per-request API). Replace all `ipapi.co` calls — both in `track-visitor` and the per-pageload `triggerEngine.detectUserCountry()` (which would blow ipapi's ~1k/day free limit instantly). Cache lookups by IP.
- [ ] Admin "Live Visitors" screen: realtime list — location, current page, time on site, pages viewed, returning/new, whether they have an open conversation.
- [ ] Proactive engagement: from the live list, an agent can "Start chat" → creates a conversation and pops the widget open on the visitor's browser with the agent's message (via the widget's WS/presence channel).
- [ ] Link presence to conversations: when a visitor with a conversation is online/offline, show it in the conversation list (green dot).

Acceptance: open jetfood.com in two browsers without touching the widget; both appear on the Live Visitors board within seconds with correct page + geo; proactive message pops the widget on the visitor side.

## Phase 4 — Widget production hardening

Known issues: full-size invisible iframe swallows clicks near the bottom-right corner (`embed.js:31-56` — the author's own comment admits it's unresolved); Turkish strings; `Notification.requestPermission()` fired at load (`ChatWidget.tsx:87-91`); `NodeJS.Timeout` type in browser code (`ChatWidget.tsx:32`); `alert()` for validation.

TODO:

- [ ] Rework embed to a **two-state iframe**: a small launcher iframe (~64×64) that only covers the button, swapped/resized to the full chat window via `postMessage` when opened. No pointer-events hacks; the host page must never lose clicks.
- [ ] All visitor-facing strings → English; centralize in one strings file.
- [ ] Remove the widget's Notification permission request entirely (visitors don't need it; realtime delivery is via WS while the tab is open).
- [ ] Replace `alert()` validation with inline field errors; fix browser-incompatible types; clean console noise.
- [ ] Unread badge on the launcher; message sound (respect a mute toggle); typing indicators both directions (WS events); "Agent is online/offline" status in the header (driven by agent presence).
- [ ] File/image attachments (Crisp parity): visitor and agent can send images/files — server-side size/type validation, stored on disk or S3-compatible storage, served via authenticated URLs.
- [ ] Widget must load async and never block or style-leak into the host page; total embed footprint documented.
- [ ] Offline fallback: if no agent online and AI disabled, show "Leave a message" (email capture) instead of a dead chat.

Acceptance: on jetfood.com staging, every element in the bottom-right corner of the page remains clickable with the widget closed; Lighthouse on the host page unaffected; attachments work end to end.

## Phase 5 — Admin panel: mobile-first + PWA polish

Today the panel is desktop-only (fixed `w-64`/`w-80` layouts in `AdminPanel.tsx:100`, `ChatPanel.tsx:205,264`) and the manifest has a broken empty `icon-192.png` and no maskable icons.

TODO:

- [ ] Responsive rework: on mobile, conversations list and chat view become stacked routes/panels with back navigation; sidebar becomes a bottom nav or drawer. Test at 375px width.
- [ ] Proper PWA assets: real 192/512 PNG + maskable icons, correct `manifest.json` (name, theme, start_url), iOS meta tags (`apple-mobile-web-app-capable`, apple-touch-icon).
- [ ] Service worker: offline app shell for the admin panel; version-based cache busting on deploy.
- [ ] Conversation list: unread counts, last-message preview, assignment indicator, live visitor status.
- [ ] Quick actions on mobile: canned responses (see Phase 6), attachment send, mark-resolved.

Acceptance: an agent can realistically handle a full conversation from a phone: get push → tap → read → reply with a canned response → resolve.

## Phase 6 — Multi-agent correctness

Today: no roles (every agent is full admin), no conversation assignment, and agent deletion calls `supabase.auth.admin.deleteUser` **from the browser** (`AgentsPanel.tsx:122`) which can never work client-side.

TODO:

- [ ] Roles: `admin` (settings, agents, triggers, KB) vs `agent` (conversations only). Enforce server-side on every route, reflect in UI.
- [ ] Agent CRUD entirely server-side admin endpoints (fixes delete).
- [ ] Conversation assignment: claim/assign/transfer; unassigned pool visible to all; events over WS; push routing respects assignment (Phase 2).
- [ ] Agent online/offline presence (drives widget status + AI takeover in Phase 7).
- [ ] Canned responses (shortcuts): admin-managed snippets, `/` autocomplete in the chat input.
- [ ] Internal notes on a conversation (visible to agents only).
- [ ] Conversation states: open / pending / resolved; resolved conversations re-open on new visitor message.

## Phase 7 — AI replies, done right

Today: `chatbot-ai` edge function supports `knowledge_base` (naive substring scoring), `openai` (gpt-4o-mini), and `ollama`; stuffs the **entire** knowledge base into every prompt (`chatbot-ai/index.ts:200-218`); has no "answer only when no human is available" mode; and the key is stored/readable client-side (fixed in Phase 1).

TODO:

- [ ] Server-side `AIService` with provider adapters. **Default provider: Anthropic Claude** via the official `@anthropic-ai/sdk` — model from env (`AI_MODEL`, default `claude-opus-4-8`; `claude-haiku-4-5` is the cheap/fast option). Note for Claude 4.6+ models: do NOT send `temperature`/`top_p` (rejected); keep `max_tokens` ~1024 for chat replies. Keep OpenAI and Ollama as optional adapters behind the same interface.
- [ ] KB retrieval instead of stuff-everything: score entries (keyword/BM25 is fine to start), include only top 3–5 relevant entries in the system prompt, with a hard token budget. (Optional stretch: pgvector embeddings — otherwise drop the dead `embedding` column.)
- [ ] Reply modes (admin setting): `off` / `first_message` (greeting only) / `when_no_agent_online` (AI answers fully while no agent is online, stops the moment an agent joins) / `always`. The missing `when_no_agent_online` mode is the important one — it uses agent presence from Phase 6.
- [ ] Handoff: AI system prompt instructs it to say it's connecting a human when it can't help; that flags the conversation `needs_human`, triggers push (Phase 2), and stops further AI replies in that conversation.
- [ ] AI messages visibly labeled in widget and admin ("AI Assistant").
- [ ] Guardrails in the system prompt: only answer about JetFood/the restaurant platform, never invent order statuses or refunds — direct those to a human; English only.
- [ ] Log AI usage (tokens in/out per reply) to a table for cost monitoring; simple monthly total in admin settings.
- [ ] Timeouts + failure fallback: if the provider errors, post nothing (or the offline fallback), never a raw error to the visitor.

## Phase 8 — Triggers & campaigns (keep + fix)

The trigger engine (`triggerEngine.ts` + `TriggersPanel.tsx`) is the most complete feature — keep it. Fixes:

- [ ] Country detection: use the server's GeoLite2 result delivered with widget config — remove the client-side `ipapi.co` call.
- [ ] Implement or remove the schema-defined-but-unimplemented `on_user_event` / `on_user_data` trigger types (recommend: remove from schema for now).
- [ ] Port trigger config storage/CRUD to the new backend; triggers evaluated in the embed/widget as today.
- [ ] Trigger analytics: fire count + resulting-conversation count per trigger.

## Phase 9 — MagicBrowse (optional — decide before building)

The current implementation **does not work as intended**: `rrweb.record()` runs inside the widget's cross-origin iframe (`ChatWidget.tsx:318-349`), so it records the chat box, not the host page, and only after a conversation starts. Two options — pick one, do not keep the broken middle ground:

- **Option A (recommended): cut it.** Delete `MagicBrowse.tsx`, the rrweb deps (alpha versions), and the 1s broadcast loop (which would also burn WS bandwidth). Live Visitors (Phase 3) covers 90% of the need.
- **Option B: rebuild properly.** Run `rrweb.record()` from `embed.js` in the **host page** context, stream events over the visitor WS with sampling/throttling, replay in admin with `rrweb.Replayer({liveMode:true})`. Must mask all inputs (`maskAllInputs: true`) and any payment/PII selectors, be off by default, and be per-site-configurable. Budget bandwidth (batch events, 2–5s flush, cap payload size).

## Phase 10 — Ops & quality

- [ ] `docker-compose.yml`: app + Postgres + (optional) MaxMind updater; one-command bring-up; `.env.example` documenting every variable (DB URL, JWT secrets, VAPID keys, ANTHROPIC_API_KEY, DISCORD_WEBHOOK_URL, ALLOWED_ORIGINS).
- [ ] README: architecture diagram, deploy steps, jetfood.com embed snippet, iOS push caveats, backup/restore (pg_dump cron).
- [ ] Migrations run automatically on boot; seed script creates the first admin.
- [ ] Tests (minimum): auth + scope enforcement (visitor token cannot read another conversation — regression test for the Phase 1 vulnerabilities), push subscription lifecycle, AI mode selection logic, trigger URL matching.
- [ ] Error tracking hook (Sentry-compatible, DSN optional via env) + structured request logging.
- [ ] Uptime/health endpoint (`/healthz`) checking DB + WS.
- [ ] Data retention: purge presence rows > 24h, closed conversations archived, attachments TTL configurable.

---

## Definition of done (Crisp cancellation checklist)

- [ ] Widget live on jetfood.com, English-only, no click-swallowing
- [ ] Live Visitors board shows anonymous traffic in real time; proactive chat works
- [ ] Push notification received on a locked phone (Android + iOS installed PWA) and deep-links into the conversation
- [ ] Admin panel fully usable on a phone
- [ ] AI answers from KB when no agent online, hands off cleanly
- [ ] No secret reachable from the client; visitor scope enforced and tested
- [ ] Running on our own server via Docker Compose with backups
