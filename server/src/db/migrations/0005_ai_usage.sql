-- ============================================================================
-- 0005_ai_usage — per-reply token accounting for cost monitoring (Phase 7).
-- ============================================================================

CREATE TABLE ai_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);
