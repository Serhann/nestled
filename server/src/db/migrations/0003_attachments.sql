-- ============================================================================
-- 0003_attachments — file/image attachments (Phase 4, Crisp parity).
--
-- The binary lives on disk (UPLOAD_DIR); this row is the metadata + the auth
-- anchor. Serving checks that the caller owns the conversation (visitor token)
-- or is an agent before streaming the file. A message row references the
-- attachment via its metadata.attachment field.
-- ============================================================================

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,
  filename        text NOT NULL,
  mime            text NOT NULL,
  size_bytes      integer NOT NULL,
  storage_path    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_conversation ON attachments(conversation_id);
