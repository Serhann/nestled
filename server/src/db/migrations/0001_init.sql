-- ============================================================================
-- 0001_init — JetChat self-hosted schema (replaces Supabase + RLS).
--
-- Security model (Phase 1): there is NO row-level security here. Access control
-- lives entirely in the application layer, where two auth planes are enforced:
--   * agents  -> email/password -> JWT (role: admin | agent)
--   * visitors-> per-conversation opaque token (only ever sees its own row)
-- Secrets (API keys, webhook URLs) live in `private_settings`, which no
-- anonymous code path ever queries. `public_settings` holds only widget-safe
-- fields. This makes the old "anon can SELECT the OpenAI key" bug structurally
-- impossible: the public config query cannot reach the secret table.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Agents (support staff). First registered agent becomes admin.
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  avatar_url    text,
  is_online     boolean NOT NULL DEFAULT false,
  last_seen     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens: we store only a SHA-256 hash so a DB leak can't mint tokens.
-- Rotation invalidates the old row; logout / revoke deletes rows.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX idx_refresh_tokens_agent ON refresh_tokens(agent_id);

-- ---------------------------------------------------------------------------
-- Conversations. `visitor_token_hash` scopes anonymous access to this one row.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id         text NOT NULL,
  visitor_name       text,
  visitor_email      text,
  visitor_token_hash text NOT NULL,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'waiting', 'resolved')),
  assigned_agent_id  uuid REFERENCES agents(id) ON DELETE SET NULL,
  needs_human        boolean NOT NULL DEFAULT false,
  message_count      integer NOT NULL DEFAULT 0,
  ai_greeted         boolean NOT NULL DEFAULT false,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_visitor_id ON conversations(visitor_id);
CREATE INDEX idx_conversations_assigned ON conversations(assigned_agent_id);

-- ---------------------------------------------------------------------------
-- Messages.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content         text NOT NULL,
  sender_type     text NOT NULL CHECK (sender_type IN ('visitor', 'agent', 'ai')),
  sender_id       text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- Keep conversations.updated_at / message_count in sync on new messages.
CREATE OR REPLACE FUNCTION bump_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE conversations
     SET updated_at = now(),
         message_count = message_count + 1
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bump_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION bump_conversation_on_message();

-- ---------------------------------------------------------------------------
-- Knowledge base. `embedding` column intentionally dropped (Phase 7 may add
-- pgvector). Keyword scoring is done in the app for now.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_base (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question   text NOT NULL,
  answer     text NOT NULL,
  category   text NOT NULL DEFAULT 'general',
  keywords   text[] NOT NULL DEFAULT ARRAY[]::text[],
  priority   integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_active ON knowledge_base(is_active);
CREATE INDEX idx_kb_category ON knowledge_base(category);

-- ---------------------------------------------------------------------------
-- Settings, split by trust boundary.
--   public_settings  -> served to anonymous widgets (GET /api/widget-config)
--   private_settings -> admin-only; secret VALUES are write-only via the API
-- Both are single-row tables (enforced by a fixed sentinel id).
-- ---------------------------------------------------------------------------
CREATE TABLE public_settings (
  id                         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  widget_title               text NOT NULL DEFAULT 'Chat with us',
  welcome_message            text NOT NULL DEFAULT 'Hi! How can we help you today?',
  primary_color              text NOT NULL DEFAULT '#3B82F6',
  widget_position            text NOT NULL DEFAULT 'right' CHECK (widget_position IN ('left', 'right')),
  widget_avatar_url          text,
  ai_enabled                 boolean NOT NULL DEFAULT true,
  pre_chat_enabled           boolean NOT NULL DEFAULT false,
  pre_chat_fields            jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_welcome_enabled       boolean NOT NULL DEFAULT false,
  auto_welcome_message       text,
  auto_welcome_delay         integer NOT NULL DEFAULT 5,
  notification_sound_enabled boolean NOT NULL DEFAULT true,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private_settings (
  id                         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ai_provider                text NOT NULL DEFAULT 'anthropic'
                               CHECK (ai_provider IN ('knowledge_base', 'anthropic', 'openai', 'ollama')),
  ai_model                   text NOT NULL DEFAULT 'claude-opus-4-8',
  ai_response_mode           text NOT NULL DEFAULT 'first_message'
                               CHECK (ai_response_mode IN ('off', 'first_message', 'when_no_agent_online', 'always')),
  system_prompt              text NOT NULL DEFAULT
    'You are a helpful customer support assistant for JetFood, a food-ordering platform. Answer only about JetFood and its services. Never invent order statuses or refunds — direct those to a human. Reply in English, concisely and professionally.',
  -- Secret values. Never returned to the client verbatim; the API masks them.
  anthropic_api_key          text,
  openai_api_key             text,
  openai_model               text NOT NULL DEFAULT 'gpt-4o-mini',
  ollama_url                 text,
  ollama_model               text NOT NULL DEFAULT 'llama2',
  discord_webhook_url        text,
  discord_webhook_enabled    boolean NOT NULL DEFAULT false,
  discord_notify_new_chat    boolean NOT NULL DEFAULT true,
  discord_notify_new_message boolean NOT NULL DEFAULT false,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Seed the single settings rows.
INSERT INTO public_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO private_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Triggers system (ported 1:1 from Supabase; kept, fixed in Phase 8).
-- ---------------------------------------------------------------------------
CREATE TABLE triggers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  identifier text NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  priority   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_triggers_active ON triggers(is_active, priority);

CREATE TABLE trigger_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id         uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  show_message       boolean NOT NULL DEFAULT false,
  message_content    text,
  localized_messages jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_chatbox       boolean NOT NULL DEFAULT false,
  play_sound         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trigger_actions_trigger ON trigger_actions(trigger_id);

CREATE TABLE trigger_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id           uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  on_leave_intent      boolean NOT NULL DEFAULT false,
  on_click_link        boolean NOT NULL DEFAULT false,
  click_selectors      text[] NOT NULL DEFAULT '{}',
  on_pages             boolean NOT NULL DEFAULT false,
  page_urls            text[] NOT NULL DEFAULT '{}',
  on_url_parameters    boolean NOT NULL DEFAULT false,
  url_parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_delay          boolean NOT NULL DEFAULT false,
  delay_seconds        integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trigger_events_trigger ON trigger_events(trigger_id);

CREATE TABLE trigger_behaviors (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id                  uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  show_as_website             boolean NOT NULL DEFAULT false,
  execute_if_online           boolean NOT NULL DEFAULT false,
  execute_on_first_visit      boolean NOT NULL DEFAULT false,
  execute_if_no_other_trigger boolean NOT NULL DEFAULT false,
  country_restriction         text[] NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trigger_behaviors_trigger ON trigger_behaviors(trigger_id);

CREATE TABLE trigger_platforms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id      uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  desktop_enabled boolean NOT NULL DEFAULT true,
  mobile_enabled  boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_trigger_platforms_trigger ON trigger_platforms(trigger_id);

-- ---------------------------------------------------------------------------
-- Audit log for admin actions (settings changes, agent CRUD, etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  agent_email text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_agent ON audit_log(agent_id);
