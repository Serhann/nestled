-- Site manager: per-site widget appearance + quick-action configuration.
CREATE TABLE "sites" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "key"             TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "primary_color"   TEXT,
  "widget_title"    TEXT,
  "welcome_message" TEXT,
  "widget_position" TEXT,
  "quick_actions"   JSONB NOT NULL DEFAULT '[]',
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sites_key_key" ON "sites"("key");

-- Seed the two known sites. Empty quick_actions => the widget falls back to its
-- built-in pack (food is order-phase aware; saas is support + lead-gen), so
-- behaviour is unchanged until an admin customises it.
INSERT INTO "sites" ("key", "name") VALUES
  ('food', 'JetFood'),
  ('saas', 'TryJet');
