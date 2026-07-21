-- Per-site domain allowlist + where-loaded tracking.
ALTER TABLE "sites" ADD COLUMN "allowed_domains" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "sites" ADD COLUMN "enforce_domains" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "site_domains" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_key"   TEXT NOT NULL,
  "host"       TEXT NOT NULL,
  "hits"       INTEGER NOT NULL DEFAULT 1,
  "authorized" BOOLEAN NOT NULL DEFAULT true,
  "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "site_domains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_domains_site_key_host_key" ON "site_domains"("site_key", "host");
