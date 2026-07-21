-- Site scoping: which site(s)/scenario-packs an entry applies to. Empty = all.
ALTER TABLE "knowledge_base" ADD COLUMN "sites" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "canned_responses" ADD COLUMN "sites" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "triggers" ADD COLUMN "sites" TEXT[] NOT NULL DEFAULT '{}';
