-- Cross-site people pool: fuse per-site visitor ids into one canonical person
-- via device fingerprints + email. Admin-only graph (never exposed to visitors).

CREATE TABLE "persons" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "display_name"  TEXT,
  "primary_email" TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_persons_email" ON "persons" ("primary_email");

CREATE TABLE "visitor_links" (
  "visitor_id" TEXT           NOT NULL,
  "person_id"  UUID           NOT NULL,
  "mode"       TEXT,
  "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "visitor_links_pkey" PRIMARY KEY ("visitor_id"),
  CONSTRAINT "visitor_links_person_id_fkey" FOREIGN KEY ("person_id")
    REFERENCES "persons" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_visitor_links_person" ON "visitor_links" ("person_id");

CREATE TABLE "person_signals" (
  "id"         UUID           NOT NULL DEFAULT gen_random_uuid(),
  "person_id"  UUID           NOT NULL,
  "kind"       TEXT           NOT NULL,
  "value"      TEXT           NOT NULL,
  "hits"       INTEGER        NOT NULL DEFAULT 1,
  "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "person_signals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "person_signals_person_id_fkey" FOREIGN KEY ("person_id")
    REFERENCES "persons" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_person_signals_kind_value" ON "person_signals" ("kind", "value");
CREATE INDEX "idx_person_signals_person" ON "person_signals" ("person_id");
