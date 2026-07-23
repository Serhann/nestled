-- Per-site pre-chat (lead capture) form.
ALTER TABLE "sites" ADD COLUMN "pre_chat_enabled" BOOLEAN;
ALTER TABLE "sites" ADD COLUMN "pre_chat_fields" JSONB NOT NULL DEFAULT '[]';
