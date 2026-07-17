-- ============================================================================
-- 0008_agent_avatar — per-agent uploaded avatar. The image is stored on disk
-- (UPLOAD_DIR/avatars/<agent_id>); avatar_url is the public serve path and
-- avatar_mime is its content type. Shown next to agent messages in the widget.
-- ============================================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_mime text;
