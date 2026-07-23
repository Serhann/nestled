-- Per-site AI system prompt (null = fall back to the global private_settings one).
ALTER TABLE "sites" ADD COLUMN "system_prompt" TEXT;
