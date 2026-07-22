-- Track every IP a visitor connects from (across sessions / IP changes).
CREATE TABLE "visitor_ips" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "visitor_id" TEXT NOT NULL,
  "ip"         TEXT NOT NULL,
  "geo"        JSONB,
  "hits"       INTEGER NOT NULL DEFAULT 1,
  "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "visitor_ips_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visitor_ips_visitor_id_ip_key" ON "visitor_ips"("visitor_id", "ip");
CREATE INDEX "idx_visitor_ips_visitor" ON "visitor_ips"("visitor_id");
