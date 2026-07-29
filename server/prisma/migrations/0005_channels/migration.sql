-- Conversations that did not come from the widget.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DECISION THAT SHAPES THIS WHOLE MIGRATION: a channel belongs to a website.
--
-- `conversations.website_id` stays NOT NULL. That looks like a compromise and is
-- actually the point. `websites` is already the thing that owns settings, business
-- hours, the knowledge base, canned responses, routing rules, triggers, and — this
-- is the one that matters — `member_website_access`. Hang an email address or a
-- phone number off a website and every one of those applies to it for free, and an
-- agent scoped to one website keeps seeing exactly what they should.
--
-- Making website_id nullable instead would have meant changing the composite FK
-- that all website-scoped children hang from, and answering "can an agent scoped
-- to website A see a conversation belonging to no website?" — a question with no
-- good answer and a permission hole behind every wrong one.
--
-- The cost: the word "website" now means "brand / inbox", and for an email-only
-- customer it will read oddly in the UI. Renaming the table across forty files
-- buys nothing today. Noted here so the next person knows it was a choice.
-- ─────────────────────────────────────────────────────────────────────────────

-- Which medium this conversation is happening on.
ALTER TABLE "conversations" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'widget';
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_check"
  CHECK ("channel" IN ('widget', 'email', 'sms', 'whatsapp', 'instagram'));

-- The customer's address on that channel: an email address, an E.164 number, later
-- a WhatsApp id. NULL for the widget, where the visitor has no address.
ALTER TABLE "conversations" ADD COLUMN "channel_address" TEXT;

-- A visitor bearer token is a widget concept. Someone emailing us has no token and
-- never will.
--
-- The existing UNIQUE index is left exactly as it is, on purpose: Postgres treats
-- NULLs as distinct in a unique index, so dropping NOT NULL is sufficient and every
-- non-widget conversation can carry NULL without collision. No partial index, and
-- `findUnique({ where: { visitor_token_hash } })` keeps working for the widget.
ALTER TABLE "conversations" ALTER COLUMN "visitor_token_hash" DROP NOT NULL;

-- `source` records how a conversation began; `channel` records where it lives. They
-- are orthogonal, and inbound mail needs a value for the first one.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_source_check";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_check"
  CHECK ("source" IN ('widget', 'proactive', 'bot', 'inbound'));

-- Finding the open conversation for an inbound message is a lookup by address, and
-- it happens on every webhook delivery.
CREATE INDEX "conversations_workspace_channel_address_idx"
  ON "conversations" ("workspace_id", "channel", "channel_address");

-- ── Message provenance and delivery ─────────────────────────────────────────

-- The provider's id for an inbound message. Every one of these providers will
-- redeliver a webhook — that is the contract, not a bug — so this is the
-- idempotency key, and it is enforced by the database rather than by a lookup that
-- two concurrent deliveries can both pass.
ALTER TABLE "messages" ADD COLUMN "external_id" TEXT;
CREATE UNIQUE INDEX "messages_workspace_id_external_id_key"
  ON "messages" ("workspace_id", "external_id");

-- Outbound on a real channel can fail after the agent has pressed send: a bounced
-- address, a landline, a revoked API key. On the widget it cannot, which is why
-- nothing needed this before. An agent who is not told is an agent who thinks they
-- answered.
ALTER TABLE "messages" ADD COLUMN "delivery_status" TEXT;
ALTER TABLE "messages" ADD COLUMN "delivery_error" TEXT;
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_status_check"
  CHECK ("delivery_status" IS NULL OR "delivery_status" IN ('pending', 'sent', 'failed'));

-- ── Our addresses ───────────────────────────────────────────────────────────

-- The addresses we RECEIVE on: an inbound mailbox, a phone number we own.
--
-- The global unique on (channel, address) is the load-bearing constraint. An
-- inbound email arrives carrying nothing but a To: header, and an SMS nothing but a
-- destination number — that address IS the tenant routing key. If two workspaces
-- could claim one address, inbound delivery would have to guess which customer a
-- stranger's message belongs to. Postgres refuses instead.
CREATE TABLE "channel_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    -- Provider config for this endpoint. Never a credential: we hold the provider
    -- account, so those are platform-level in platform_settings.
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "verified_at" TIMESTAMPTZ(6),
    "last_inbound_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "channel_endpoints_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_channel_check"
  CHECK ("channel" IN ('email', 'sms', 'whatsapp', 'instagram'));

CREATE UNIQUE INDEX "channel_endpoints_channel_address_key"
  ON "channel_endpoints" ("channel", lower("address"));

CREATE UNIQUE INDEX "channel_endpoints_workspace_id_id_key"
  ON "channel_endpoints" ("workspace_id", "id");

CREATE INDEX "channel_endpoints_workspace_id_channel_idx"
  ON "channel_endpoints" ("workspace_id", "channel");

ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite FK, same as every other website-scoped child: pointing an endpoint
-- at another tenant's website is a Postgres error, not a code review finding.
ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_workspace_id_website_id_fkey"
  FOREIGN KEY ("workspace_id", "website_id") REFERENCES "websites"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
