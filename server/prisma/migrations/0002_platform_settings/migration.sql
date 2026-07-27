-- Install-wide settings, editable from the ops panel.
--
-- Hand-written. `prisma migrate diff` also wanted to drop the composite assignee
-- foreign key, the three GIN indexes and the jsonb column defaults from
-- 0001_init, because those were hand-appended there and the introspected schema
-- cannot see them. Applying its output verbatim would have silently removed the
-- constraint that makes a cross-tenant assignment a Postgres error.

CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,

    -- AI. Ours, not the customer's: usage is metered per workspace.
    "ai_provider"       TEXT,
    "ai_model"          TEXT,
    "anthropic_api_key" TEXT,
    "openai_api_key"    TEXT,
    "ollama_url"        TEXT,

    -- Transactional email.
    "smtp_host"     TEXT,
    "smtp_port"     INTEGER,
    "smtp_secure"   BOOLEAN,
    "smtp_user"     TEXT,
    "smtp_password" TEXT,
    "mail_from"     TEXT,

    -- Web Push (VAPID).
    "vapid_public_key"  TEXT,
    "vapid_private_key" TEXT,
    "vapid_subject"     TEXT,

    -- IP geolocation.
    "geolite2_db_path"    TEXT,
    "maxmind_account_id"  TEXT,
    "maxmind_license_key" TEXT,
    "maxmind_endpoint"    TEXT,

    -- Billing.
    "stripe_secret_key"     TEXT,
    "stripe_webhook_secret" TEXT,
    "stripe_return_url"     TEXT,

    -- Public URLs, used to build links in outbound email.
    "app_url"       TEXT,
    "marketing_url" TEXT,

    -- Operations.
    "discord_webhook_url"        TEXT,
    "sentry_dsn"                 TEXT,
    "retention_days"             INTEGER,
    "platform_session_ttl_hours" INTEGER,

    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    -- A singleton, enforced rather than assumed. Two rows here would mean the
    -- install has two opinions about its own Stripe key.
    CONSTRAINT "platform_settings_singleton" CHECK ("id" = 1),
    CONSTRAINT "platform_settings_ai_provider_check"
      CHECK ("ai_provider" IS NULL OR "ai_provider" IN ('knowledge_base','anthropic','openai','ollama'))
);

ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "platform_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The row always exists, so every read is a plain findUnique and no caller has to
-- treat "not configured yet" as a different case from "configured to nothing".
INSERT INTO "platform_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
