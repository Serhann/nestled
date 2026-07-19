-- Organic design system: default widget accent becomes terracotta. Backfill the
-- singleton row only if it still holds the old blue default (respect overrides).
ALTER TABLE "public_settings" ALTER COLUMN "primary_color" SET DEFAULT '#c67139';
UPDATE "public_settings" SET primary_color = '#c67139' WHERE id = 1 AND primary_color = '#3B82F6';
