-- Credentials for the channel providers.
--
-- These are PLATFORM level, not per workspace, and that is a deliberate split from
-- `channel_endpoints`. We hold the Twilio account and the inbound-mail route; a
-- customer supplies which address or number is theirs, never a credential. Two
-- reasons: a customer-held credential is a support liability the first time it
-- expires, and a table of tenant-supplied provider secrets is a much more
-- interesting target than one platform row.
ALTER TABLE "platform_settings" ADD COLUMN "twilio_account_sid" TEXT;
ALTER TABLE "platform_settings" ADD COLUMN "twilio_auth_token" TEXT;

-- Shared secret for the inbound-mail webhook.
--
-- Inbound email arrives at a public URL from whichever mail provider is in front of
-- us, with a body that names the workspace by its To: address. Unauthenticated, that
-- endpoint lets anyone put words in any customer's inbox attributed to any sender —
-- so it is verified, and it refuses when no secret is set rather than defaulting to
-- open.
ALTER TABLE "platform_settings" ADD COLUMN "inbound_mail_secret" TEXT;

-- The domain inbound addresses live on, e.g. 'inbox.nestled.chat'. Shown in the
-- settings UI so an operator knows what to point their MX record at, and used to
-- suggest addresses rather than making customers invent them.
ALTER TABLE "platform_settings" ADD COLUMN "inbound_mail_domain" TEXT;
