-- Per-site shared HMAC secret for signed visitor context (JetFood PHP signs the
-- logged-in customer + orders into a JWT; JetChat verifies it here). Admin-only.
ALTER TABLE "sites" ADD COLUMN "context_secret" TEXT;
