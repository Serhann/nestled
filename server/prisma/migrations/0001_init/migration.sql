-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "plan_id" UUID NOT NULL,
    "subscription_status" TEXT NOT NULL DEFAULT 'trialing',
    "trial_ends_at" TIMESTAMPTZ(6),
    "stripe_customer_id" TEXT,
    "grace_until" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_file_id" UUID,
    "email_verified_at" TIMESTAMPTZ(6),
    "default_workspace_id" UUID,
    "timezone" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'active',
    "all_websites" BOOLEAN NOT NULL DEFAULT true,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_website_access" (
    "member_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,

    CONSTRAINT "member_website_access_pkey" PRIMARY KEY ("member_id","website_id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "all_websites" BOOLEAN NOT NULL DEFAULT true,
    "website_ids" UUID[],
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primary_domain" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enforce_domains" BOOLEAN NOT NULL DEFAULT false,
    "identity_secret" TEXT,
    "installed_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_settings" (
    "website_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "primary_color" TEXT NOT NULL DEFAULT '#4f46e5',
    "color_mode" TEXT NOT NULL DEFAULT 'light',
    "radius_px" INTEGER NOT NULL DEFAULT 16,
    "font_family" TEXT NOT NULL DEFAULT 'system',
    "position" TEXT NOT NULL DEFAULT 'right',
    "offset_x" INTEGER NOT NULL DEFAULT 20,
    "offset_y" INTEGER NOT NULL DEFAULT 20,
    "launcher_style" TEXT NOT NULL DEFAULT 'bubble',
    "launcher_file_id" UUID,
    "avatar_file_id" UUID,
    "logo_file_id" UUID,
    "show_branding" BOOLEAN NOT NULL DEFAULT true,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "ai_response_mode" TEXT NOT NULL DEFAULT 'first_message',
    "system_prompt" TEXT,
    "ai_extra_rules" TEXT,
    "pre_chat_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pre_chat_fields" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "auto_welcome_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_welcome_message" TEXT,
    "auto_welcome_delay" INTEGER NOT NULL DEFAULT 5,
    "file_upload_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sound_enabled" BOOLEAN NOT NULL DEFAULT true,
    "live_view_enabled" BOOLEAN NOT NULL DEFAULT false,
    "transcript_email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reset_after_resolve" BOOLEAN NOT NULL DEFAULT true,
    "starters_enabled" BOOLEAN NOT NULL DEFAULT true,
    "rating_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "copy" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_settings_pkey" PRIMARY KEY ("website_id")
);

-- CreateTable
CREATE TABLE "website_business_hours" (
    "website_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "rules" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "holidays" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "offline_behavior" TEXT NOT NULL DEFAULT 'collect_email',
    "offline_bot_flow_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_business_hours_pkey" PRIMARY KEY ("website_id")
);

-- CreateTable
CREATE TABLE "website_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_private_settings" (
    "workspace_id" UUID NOT NULL,
    "discord_webhook_url" TEXT,
    "discord_webhook_enabled" BOOLEAN NOT NULL DEFAULT false,
    "discord_notify_new_chat" BOOLEAN NOT NULL DEFAULT true,
    "discord_notify_new_message" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_private_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "person_id" UUID,
    "visitor_name" TEXT,
    "visitor_email" TEXT,
    "visitor_token_hash" TEXT NOT NULL,
    "claim_token_hash" TEXT,
    "claim_expires_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL DEFAULT 'widget',
    "assigned_member_id" UUID,
    "needs_human" BOOLEAN NOT NULL DEFAULT false,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "ai_greeted" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_response_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "rating_stars" INTEGER,
    "rating_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rating_comment" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "custom_attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_member_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "file_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_user_id" UUID,
    "author_name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'local',
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "shortcut" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "starters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "message" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'auto',
    "fields" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "bot_flow_id" UUID,
    "icon" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "conversation_count" INTEGER NOT NULL DEFAULT 0,
    "actions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "events" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "behaviors" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "platforms" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_flows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "entry" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "draft_graph" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "published_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_flow_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "flow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,

    CONSTRAINT "bot_flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_flow_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "flow_version" INTEGER NOT NULL,
    "current_node_id" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "strategy" TEXT NOT NULL DEFAULT 'round_robin',
    "member_pool" UUID[] DEFAULT ARRAY[]::UUID[],
    "cursor_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "display_name" TEXT,
    "primary_email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_links" (
    "workspace_id" UUID NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "person_id" UUID NOT NULL,
    "website_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_links_pkey" PRIMARY KEY ("workspace_id","visitor_id")
);

-- CreateTable
CREATE TABLE "person_signals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_ips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "geo" JSONB,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_ips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "stripe_product_id" TEXT,
    "stripe_price_monthly_id" TEXT,
    "stripe_price_yearly_id" TEXT,
    "price_monthly_cents" INTEGER NOT NULL DEFAULT 0,
    "price_yearly_cents" INTEGER NOT NULL DEFAULT 0,
    "included_seats" INTEGER NOT NULL DEFAULT 1,
    "max_seats" INTEGER NOT NULL DEFAULT 1,
    "max_websites" INTEGER NOT NULL DEFAULT 1,
    "max_conversations_month" INTEGER NOT NULL DEFAULT 200,
    "max_ai_replies_month" INTEGER NOT NULL DEFAULT 100,
    "max_kb_entries" INTEGER NOT NULL DEFAULT 50,
    "max_bot_flows" INTEGER NOT NULL DEFAULT 0,
    "max_triggers" INTEGER NOT NULL DEFAULT 3,
    "storage_mb" INTEGER NOT NULL DEFAULT 500,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "allow_remove_branding" BOOLEAN NOT NULL DEFAULT false,
    "allow_live_view" BOOLEAN NOT NULL DEFAULT false,
    "allow_bot" BOOLEAN NOT NULL DEFAULT false,
    "features" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "stripe_item_id" TEXT,
    "status" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "trial_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "last_event_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL,
    "amount_due" INTEGER NOT NULL,
    "amount_paid" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "hosted_invoice_url" TEXT,
    "invoice_pdf" TEXT,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "workspace_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("workspace_id","metric","period_start")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "conversation_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'support',
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "platform_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "platform_user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_user_id" UUID,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read_only',
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "ip_address" TEXT,
    "request_id" TEXT,
    "impersonation_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "to_email" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "related_type" TEXT,
    "related_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_stripe_customer_id_key" ON "workspaces"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "workspaces_subscription_status_idx" ON "workspaces"("subscription_status");

-- CreateIndex
CREATE INDEX "workspaces_deleted_at_idx" ON "workspaces"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_role_idx" ON "workspace_members"("workspace_id", "role");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_id_key" ON "workspace_members"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "member_website_access_website_id_idx" ON "member_website_access"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_workspace_id_accepted_at_idx" ON "invites"("workspace_id", "accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_user_id_kind_idx" ON "user_tokens"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "websites_public_key_key" ON "websites"("public_key");

-- CreateIndex
CREATE INDEX "websites_workspace_id_is_active_idx" ON "websites"("workspace_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "websites_workspace_id_id_key" ON "websites"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "website_settings_workspace_id_idx" ON "website_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "website_business_hours_workspace_id_idx" ON "website_business_hours"("workspace_id");

-- CreateIndex
CREATE INDEX "website_domains_workspace_id_idx" ON "website_domains"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_domains_website_id_host_key" ON "website_domains"("website_id", "host");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_visitor_token_hash_key" ON "conversations"("visitor_token_hash");

-- CreateIndex
CREATE INDEX "conversations_workspace_id_status_updated_at_idx" ON "conversations"("workspace_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_website_id_updated_at_idx" ON "conversations"("website_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_workspace_id_assigned_member_id_status_idx" ON "conversations"("workspace_id", "assigned_member_id", "status");

-- CreateIndex
CREATE INDEX "conversations_workspace_id_visitor_id_idx" ON "conversations"("workspace_id", "visitor_id");

-- CreateIndex
CREATE INDEX "conversations_person_id_idx" ON "conversations"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_id_key" ON "conversations"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_workspace_id_created_at_idx" ON "messages"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_conversation_id_idx" ON "attachments"("conversation_id");

-- CreateIndex
CREATE INDEX "attachments_workspace_id_idx" ON "attachments"("workspace_id");

-- CreateIndex
CREATE INDEX "conversation_notes_conversation_id_created_at_idx" ON "conversation_notes"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_notes_workspace_id_idx" ON "conversation_notes"("workspace_id");

-- CreateIndex
CREATE INDEX "stored_files_workspace_id_kind_idx" ON "stored_files"("workspace_id", "kind");

-- CreateIndex
CREATE INDEX "knowledge_base_workspace_id_is_active_idx" ON "knowledge_base"("workspace_id", "is_active");

-- CreateIndex
CREATE INDEX "knowledge_base_website_id_idx" ON "knowledge_base"("website_id");

-- CreateIndex
CREATE INDEX "canned_responses_website_id_idx" ON "canned_responses"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_workspace_id_shortcut_key" ON "canned_responses"("workspace_id", "shortcut");

-- CreateIndex
CREATE INDEX "starters_workspace_id_is_active_priority_idx" ON "starters"("workspace_id", "is_active", "priority");

-- CreateIndex
CREATE INDEX "starters_website_id_idx" ON "starters"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "starters_workspace_id_key_key" ON "starters"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "triggers_workspace_id_is_active_priority_idx" ON "triggers"("workspace_id", "is_active", "priority");

-- CreateIndex
CREATE INDEX "triggers_website_id_idx" ON "triggers"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "triggers_workspace_id_identifier_key" ON "triggers"("workspace_id", "identifier");

-- CreateIndex
CREATE INDEX "bot_flows_workspace_id_is_active_priority_idx" ON "bot_flows"("workspace_id", "is_active", "priority");

-- CreateIndex
CREATE INDEX "bot_flows_website_id_idx" ON "bot_flows"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_flows_workspace_id_id_key" ON "bot_flows"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_flow_versions_flow_id_version_key" ON "bot_flow_versions"("flow_id", "version");

-- CreateIndex
CREATE INDEX "bot_flow_runs_conversation_id_status_idx" ON "bot_flow_runs"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "bot_flow_runs_workspace_id_idx" ON "bot_flow_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "routing_rules_workspace_id_is_active_priority_idx" ON "routing_rules"("workspace_id", "is_active", "priority");

-- CreateIndex
CREATE INDEX "routing_rules_website_id_idx" ON "routing_rules"("website_id");

-- CreateIndex
CREATE INDEX "persons_workspace_id_idx" ON "persons"("workspace_id");

-- CreateIndex
CREATE INDEX "persons_workspace_id_primary_email_idx" ON "persons"("workspace_id", "primary_email");

-- CreateIndex
CREATE INDEX "visitor_links_person_id_idx" ON "visitor_links"("person_id");

-- CreateIndex
CREATE INDEX "person_signals_person_id_idx" ON "person_signals"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_signals_workspace_id_kind_value_key" ON "person_signals"("workspace_id", "kind", "value");

-- CreateIndex
CREATE INDEX "visitor_ips_workspace_id_visitor_id_idx" ON "visitor_ips"("workspace_id", "visitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_ips_workspace_id_visitor_id_ip_key" ON "visitor_ips"("workspace_id", "visitor_id", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_workspace_id_key" ON "subscriptions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_workspace_id_created_at_idx" ON "invoices"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stripe_events_processed_at_idx" ON "stripe_events"("processed_at");

-- CreateIndex
CREATE INDEX "ai_usage_workspace_id_created_at_idx" ON "ai_usage"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_sessions_platform_user_id_idx" ON "platform_sessions"("platform_user_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_workspace_id_created_at_idx" ON "impersonation_sessions"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_workspace_id_created_at_idx" ON "audit_log"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbound_emails_status_created_at_idx" ON "outbound_emails"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbound_emails_workspace_id_created_at_idx" ON "outbound_emails"("workspace_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_file_id_fkey" FOREIGN KEY ("avatar_file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_website_access" ADD CONSTRAINT "member_website_access_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_website_access" ADD CONSTRAINT "member_website_access_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_business_hours" ADD CONSTRAINT "website_business_hours_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_business_hours" ADD CONSTRAINT "website_business_hours_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_domains" ADD CONSTRAINT "website_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_domains" ADD CONSTRAINT "website_domains_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_private_settings" ADD CONSTRAINT "workspace_private_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_website_id_fkey" FOREIGN KEY ("workspace_id", "website_id") REFERENCES "websites"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_member_id_fkey" FOREIGN KEY ("assigned_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_member_id_fkey" FOREIGN KEY ("sender_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "starters" ADD CONSTRAINT "starters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "starters" ADD CONSTRAINT "starters_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flows" ADD CONSTRAINT "bot_flows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flows" ADD CONSTRAINT "bot_flows_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_versions" ADD CONSTRAINT "bot_flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "bot_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_versions" ADD CONSTRAINT "bot_flow_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_runs" ADD CONSTRAINT "bot_flow_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_runs" ADD CONSTRAINT "bot_flow_runs_workspace_id_conversation_id_fkey" FOREIGN KEY ("workspace_id", "conversation_id") REFERENCES "conversations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_runs" ADD CONSTRAINT "bot_flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "bot_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_links" ADD CONSTRAINT "visitor_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_links" ADD CONSTRAINT "visitor_links_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_links" ADD CONSTRAINT "visitor_links_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_signals" ADD CONSTRAINT "person_signals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_signals" ADD CONSTRAINT "person_signals_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_ips" ADD CONSTRAINT "visitor_ips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_impersonation_session_id_fkey" FOREIGN KEY ("impersonation_session_id") REFERENCES "impersonation_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- The following objects are NOT expressible in the Prisma schema and are
-- appended by hand. Prisma ignores them on future diffs, so keep them here.
-- ============================================================================

-- ── CHECK constraints for every string enum ──────────────────────────────────
-- Prisma models these as free strings so the client returns plain strings, but
-- the database is the last line of defence against a typo'd status.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_subscription_status_check"
  CHECK (subscription_status IN ('trialing','active','past_due','unpaid','canceled','trial_expired','suspended'));

ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_check"
  CHECK (role IN ('owner','admin','agent'));
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_status_check"
  CHECK (status IN ('active','suspended'));

ALTER TABLE "invites" ADD CONSTRAINT "invites_role_check"
  CHECK (role IN ('owner','admin','agent'));

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_kind_check"
  CHECK (kind IN ('email_verify','password_reset'));

ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_color_mode_check"
  CHECK (color_mode IN ('light','dark','auto'));
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_position_check"
  CHECK (position IN ('left','right'));
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_launcher_style_check"
  CHECK (launcher_style IN ('bubble','pill','custom_icon'));
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_ai_response_mode_check"
  CHECK (ai_response_mode IN ('off','first_message','when_no_agent_online','always'));

ALTER TABLE "website_business_hours" ADD CONSTRAINT "website_business_hours_offline_behavior_check"
  CHECK (offline_behavior IN ('collect_email','message_only','hide_widget','bot_flow'));

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_status_check"
  CHECK (status IN ('open','pending','resolved'));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_check"
  CHECK (source IN ('widget','proactive','bot'));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_rating_stars_check"
  CHECK (rating_stars IS NULL OR rating_stars BETWEEN 1 AND 5);

ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_type_check"
  CHECK (sender_type IN ('visitor','agent','ai','bot','system'));

ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_kind_check"
  CHECK (kind IN ('attachment','branding','user_avatar'));
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_backend_check"
  CHECK (backend IN ('local','s3'));

ALTER TABLE "starters" ADD CONSTRAINT "starters_kind_check"
  CHECK (kind IN ('auto','human','bot'));

ALTER TABLE "bot_flow_runs" ADD CONSTRAINT "bot_flow_runs_status_check"
  CHECK (status IN ('running','completed','handoff','abandoned'));

ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_strategy_check"
  CHECK (strategy IN ('round_robin','least_active','specific'));

ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_metric_check"
  CHECK (metric IN ('conversations','ai_replies','ai_tokens_in','ai_tokens_out','emails','storage_bytes'));

ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_role_check"
  CHECK (role IN ('superadmin','support','billing','readonly'));

ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_scope_check"
  CHECK (scope IN ('read_only','full'));

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_type_check"
  CHECK (actor_type IN ('user','platform_user','system','visitor'));

ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_status_check"
  CHECK (status IN ('queued','sent','failed'));

-- ── Tenant-integrity foreign key for the conversation assignee ───────────────
-- Prisma can only express this as a single-column FK, which would let a
-- conversation be assigned to a member of ANOTHER workspace. Replace it with the
-- composite pair. Postgres 15+ takes a column list on SET NULL, so only the
-- nullable column is cleared — `workspace_id` (NOT NULL) is left alone, which is
-- precisely why this cannot live in schema.prisma.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_assigned_member_id_fkey";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_member_fkey"
  FOREIGN KEY ("workspace_id", "assigned_member_id")
  REFERENCES "workspace_members"("workspace_id", "id")
  ON DELETE SET NULL ("assigned_member_id") ON UPDATE CASCADE;

-- ── Partial unique indexes (Prisma cannot express a WHERE clause) ────────────
-- One PENDING invite per email per workspace. Re-inviting replaces the row; an
-- accepted or revoked invite no longer blocks a fresh one.
CREATE UNIQUE INDEX "invites_pending_email_key"
  ON "invites" ("workspace_id", lower("email"))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- A live website owns its primary domain within the workspace; soft-deleted ones
-- release it.
CREATE UNIQUE INDEX "websites_primary_domain_key"
  ON "websites" ("workspace_id", "primary_domain")
  WHERE deleted_at IS NULL AND primary_domain IS NOT NULL;

-- Emails are compared case-insensitively everywhere; enforce that in the index
-- rather than trusting every call site to lowercase first.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

-- ── GIN indexes for containment search ──────────────────────────────────────
CREATE INDEX "conversations_tags_gin" ON "conversations" USING GIN ("tags");
CREATE INDEX "conversations_custom_attributes_gin"
  ON "conversations" USING GIN ("custom_attributes" jsonb_path_ops);
CREATE INDEX "knowledge_base_keywords_gin" ON "knowledge_base" USING GIN ("keywords");

-- ── Keep conversations.updated_at / message_count in sync on new messages ────
-- Carried over unchanged: doing this in a trigger means the counter cannot drift
-- when a message is inserted from a path that forgot to bump it.
CREATE OR REPLACE FUNCTION bump_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE conversations
     SET updated_at = now(),
         message_count = message_count + 1
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bump_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION bump_conversation_on_message();

-- ── Seed the plan catalog ───────────────────────────────────────────────────
-- Plans are reference data, not tenant data, so they belong in the migration:
-- `workspaces.plan_id` is NOT NULL, and signup has to find a plan to point at.
-- Stripe price ids are filled in per environment from the ops panel (Phase 12).
INSERT INTO "plans" (
  "id", "code", "name", "is_public", "sort_order",
  "price_monthly_cents", "price_yearly_cents", "included_seats",
  "max_seats", "max_websites", "max_conversations_month", "max_ai_replies_month",
  "max_kb_entries", "max_bot_flows", "max_triggers", "storage_mb", "retention_days",
  "allow_remove_branding", "allow_live_view", "allow_bot"
) VALUES
  (gen_random_uuid(), 'free',     'Free',     true, 0,
     0,      0,    1,
     1,  1,    100,   50,   25,  0,  1,   100,  30,  false, false, false),
  (gen_random_uuid(), 'starter',  'Starter',  true, 1,
     1900,   19000, 2,
     3,  1,    1000,  500,  200, 1,  10,  2000, 180, false, false, true),
  (gen_random_uuid(), 'pro',      'Pro',      true, 2,
     4900,   49000, 5,
     10, 5,    5000,  2500, 1000, 10, 50,  10000, 365, true,  true,  true),
  (gen_random_uuid(), 'business', 'Business', true, 3,
     9900,   99000, 15,
     50, 25,   25000, 10000, 5000, 50, 200, 50000, 730, true, true,  true)
ON CONFLICT ("code") DO NOTHING;
