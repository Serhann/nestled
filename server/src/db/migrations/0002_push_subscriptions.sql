-- ============================================================================
-- 0002_push_subscriptions — Web Push (Phase 2).
--
-- One agent can have many subscriptions (phone + laptop + tablet). The endpoint
-- is the push service's unique URL for that device; we key on it so a
-- re-subscribe from the same device upserts rather than duplicates. p256dh/auth
-- are the client's encryption keys required to send an encrypted payload.
-- ============================================================================

CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_agent ON push_subscriptions(agent_id);
