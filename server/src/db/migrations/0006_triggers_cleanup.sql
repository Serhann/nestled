-- ============================================================================
-- 0006_triggers_cleanup — Phase 8: drop unimplemented trigger event types and
-- add per-trigger analytics counters.
-- ============================================================================

-- These event types were defined in the schema but never implemented; remove
-- them rather than ship dead config surface.
ALTER TABLE trigger_events DROP COLUMN IF EXISTS on_user_event;
ALTER TABLE trigger_events DROP COLUMN IF EXISTS user_event_name;
ALTER TABLE trigger_events DROP COLUMN IF EXISTS on_user_data;
ALTER TABLE trigger_events DROP COLUMN IF EXISTS user_data_conditions;

-- Analytics: how often a trigger fired, and how many conversations it produced.
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS fire_count integer NOT NULL DEFAULT 0;
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS conversation_count integer NOT NULL DEFAULT 0;
