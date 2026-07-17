-- ============================================================================
-- 0007_magic_browse — Phase 9: live session replay (MagicBrowse), rebuilt to
-- record in the HOST PAGE. Off by default; per-site opt-in via this flag.
-- ============================================================================

ALTER TABLE public_settings
  ADD COLUMN IF NOT EXISTS magic_browse_enabled boolean NOT NULL DEFAULT false;
