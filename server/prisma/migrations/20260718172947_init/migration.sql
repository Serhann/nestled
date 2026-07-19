-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "avatar_url" TEXT,
    "avatar_mime" TEXT,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "visitor_id" TEXT NOT NULL,
    "visitor_name" TEXT,
    "visitor_email" TEXT,
    "visitor_token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_agent_id" UUID,
    "needs_human" BOOLEAN NOT NULL DEFAULT false,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "ai_greeted" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "public_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "widget_title" TEXT NOT NULL DEFAULT 'Chat with us',
    "welcome_message" TEXT NOT NULL DEFAULT 'Hi! How can we help you today?',
    "primary_color" TEXT NOT NULL DEFAULT '#3B82F6',
    "widget_position" TEXT NOT NULL DEFAULT 'right',
    "widget_avatar_url" TEXT,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pre_chat_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pre_chat_fields" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "auto_welcome_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_welcome_message" TEXT,
    "auto_welcome_delay" INTEGER NOT NULL DEFAULT 5,
    "notification_sound_enabled" BOOLEAN NOT NULL DEFAULT true,
    "magic_browse_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ai_provider" TEXT NOT NULL DEFAULT 'anthropic',
    "ai_model" TEXT NOT NULL DEFAULT 'claude-opus-4-8',
    "ai_response_mode" TEXT NOT NULL DEFAULT 'first_message',
    "system_prompt" TEXT NOT NULL DEFAULT 'You are a helpful customer support assistant for JetFood, a food-ordering platform. Answer only about JetFood and its services. Never invent order statuses or refunds — direct those to a human. Reply in English, concisely and professionally.',
    "anthropic_api_key" TEXT,
    "openai_api_key" TEXT,
    "openai_model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "ollama_url" TEXT,
    "ollama_model" TEXT NOT NULL DEFAULT 'llama2',
    "discord_webhook_url" TEXT,
    "discord_webhook_enabled" BOOLEAN NOT NULL DEFAULT false,
    "discord_notify_new_chat" BOOLEAN NOT NULL DEFAULT true,
    "discord_notify_new_message" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "private_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "conversation_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "show_message" BOOLEAN NOT NULL DEFAULT false,
    "message_content" TEXT,
    "localized_messages" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "open_chatbox" BOOLEAN NOT NULL DEFAULT false,
    "play_sound" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "on_leave_intent" BOOLEAN NOT NULL DEFAULT false,
    "on_click_link" BOOLEAN NOT NULL DEFAULT false,
    "click_selectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "on_pages" BOOLEAN NOT NULL DEFAULT false,
    "page_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "on_url_parameters" BOOLEAN NOT NULL DEFAULT false,
    "url_parameters" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "after_delay" BOOLEAN NOT NULL DEFAULT false,
    "delay_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_behaviors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "show_as_website" BOOLEAN NOT NULL DEFAULT false,
    "execute_if_online" BOOLEAN NOT NULL DEFAULT false,
    "execute_on_first_visit" BOOLEAN NOT NULL DEFAULT false,
    "execute_if_no_other_trigger" BOOLEAN NOT NULL DEFAULT false,
    "country_restriction" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_behaviors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_platforms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "desktop_enabled" BOOLEAN NOT NULL DEFAULT true,
    "mobile_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID,
    "agent_email" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shortcut" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID,
    "agent_name" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_email_key" ON "agents"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_refresh_tokens_agent" ON "refresh_tokens"("agent_id");

-- CreateIndex
CREATE INDEX "idx_conversations_status" ON "conversations"("status");

-- CreateIndex
CREATE INDEX "idx_conversations_updated_at" ON "conversations"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_conversations_visitor_id" ON "conversations"("visitor_id");

-- CreateIndex
CREATE INDEX "idx_conversations_assigned" ON "conversations"("assigned_agent_id");

-- CreateIndex
CREATE INDEX "idx_messages_conversation" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_kb_active" ON "knowledge_base"("is_active");

-- CreateIndex
CREATE INDEX "idx_kb_category" ON "knowledge_base"("category");

-- CreateIndex
CREATE UNIQUE INDEX "triggers_identifier_key" ON "triggers"("identifier");

-- CreateIndex
CREATE INDEX "idx_triggers_active" ON "triggers"("is_active", "priority");

-- CreateIndex
CREATE INDEX "idx_trigger_actions_trigger" ON "trigger_actions"("trigger_id");

-- CreateIndex
CREATE INDEX "idx_trigger_events_trigger" ON "trigger_events"("trigger_id");

-- CreateIndex
CREATE INDEX "idx_trigger_behaviors_trigger" ON "trigger_behaviors"("trigger_id");

-- CreateIndex
CREATE INDEX "idx_trigger_platforms_trigger" ON "trigger_platforms"("trigger_id");

-- CreateIndex
CREATE INDEX "idx_audit_log_created" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_log_agent" ON "audit_log"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "idx_push_subscriptions_agent" ON "push_subscriptions"("agent_id");

-- CreateIndex
CREATE INDEX "idx_attachments_conversation" ON "attachments"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_shortcut_key" ON "canned_responses"("shortcut");

-- CreateIndex
CREATE INDEX "idx_conversation_notes_conversation" ON "conversation_notes"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_ai_usage_created" ON "ai_usage"("created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_actions" ADD CONSTRAINT "trigger_actions_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_behaviors" ADD CONSTRAINT "trigger_behaviors_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_platforms" ADD CONSTRAINT "trigger_platforms_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- The following objects are not expressible in the Prisma schema and are
-- appended by hand: CHECK constraints, the message-count trigger, and the
-- singleton settings seed rows. Prisma ignores these on future diffs.
-- ============================================================================

-- ── CHECK constraints ────────────────────────────────────────────────────────
ALTER TABLE "agents" ADD CONSTRAINT "agents_role_check" CHECK (role IN ('admin', 'agent'));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_status_check" CHECK (status IN ('open', 'pending', 'resolved'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_type_check" CHECK (sender_type IN ('visitor', 'agent', 'ai'));
ALTER TABLE "public_settings" ADD CONSTRAINT "public_settings_id_check" CHECK (id = 1);
ALTER TABLE "public_settings" ADD CONSTRAINT "public_settings_widget_position_check" CHECK (widget_position IN ('left', 'right'));
ALTER TABLE "private_settings" ADD CONSTRAINT "private_settings_id_check" CHECK (id = 1);
ALTER TABLE "private_settings" ADD CONSTRAINT "private_settings_ai_provider_check" CHECK (ai_provider IN ('knowledge_base', 'anthropic', 'openai', 'ollama'));
ALTER TABLE "private_settings" ADD CONSTRAINT "private_settings_ai_response_mode_check" CHECK (ai_response_mode IN ('off', 'first_message', 'when_no_agent_online', 'always'));

-- ── Keep conversations.updated_at / message_count in sync on new messages ─────
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

-- ── Seed the singleton settings rows ─────────────────────────────────────────
INSERT INTO public_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO private_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
