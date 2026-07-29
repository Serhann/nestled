-- Nestled's own support chat: which website serves it.
--
-- Empty by default and empty forever on a self-hosted install — someone running
-- their own copy is not our customer, and shipping them a chat bubble that reaches
-- our support team would be both confusing and a privacy leak.
ALTER TABLE "platform_settings" ADD COLUMN "support_website_key" TEXT;
