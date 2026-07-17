-- ============================================================================
-- 0004_multi_agent — Phase 6: assignment, states, canned responses, notes.
-- ============================================================================

-- Conversation states: open / pending / resolved (was active/waiting/resolved).
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
UPDATE conversations SET status = 'open' WHERE status = 'active';
UPDATE conversations SET status = 'pending' WHERE status = 'waiting';
ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'open';
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'pending', 'resolved'));

-- Admin-managed canned responses; agents insert them via `/shortcut` autocomplete.
CREATE TABLE canned_responses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut   text NOT NULL UNIQUE,   -- typed after `/` in the composer
  title      text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Internal notes: visible to agents only, never sent to the visitor.
CREATE TABLE conversation_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_name      text,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversation_notes_conversation ON conversation_notes(conversation_id, created_at);
