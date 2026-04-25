/*
  # Create Triggers System

  ## Overview
  This migration creates a comprehensive triggers system that allows automated chatbot interactions based on visitor behavior.

  ## New Tables

  ### 1. triggers
  Main triggers table storing trigger definitions
  - `id` (uuid, primary key) - Unique trigger identifier
  - `name` (text) - Human-readable trigger name
  - `identifier` (text, unique) - URL-safe slug for the trigger
  - `is_active` (boolean) - Whether trigger is active
  - `priority` (integer) - Execution order (lower = higher priority)
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 2. trigger_actions
  Actions to execute when trigger conditions are met
  - `id` (uuid, primary key)
  - `trigger_id` (uuid, foreign key) - Parent trigger
  - `show_message` (boolean) - Whether to display a message
  - `message_content` (text) - Default message content
  - `localized_messages` (jsonb) - Messages in different languages
  - `open_chatbox` (boolean) - Whether to open the chat widget
  - `play_sound` (boolean) - Whether to play notification sound
  - `created_at` (timestamptz)

  ### 3. trigger_events
  Event conditions that activate the trigger
  - `id` (uuid, primary key)
  - `trigger_id` (uuid, foreign key) - Parent trigger
  - `on_leave_intent` (boolean) - Detect exit intent
  - `on_click_link` (boolean) - Click on specific links
  - `click_selectors` (text[]) - CSS selectors for clickable elements
  - `on_pages` (boolean) - Specific page URLs
  - `page_urls` (text[]) - URL patterns (supports wildcards)
  - `on_url_parameters` (boolean) - URL parameters
  - `url_parameters` (jsonb) - Parameter key-value pairs
  - `on_user_event` (boolean) - Custom JavaScript events
  - `user_event_name` (text) - Custom event name
  - `on_user_data` (boolean) - Based on visitor metadata
  - `user_data_conditions` (jsonb) - Metadata conditions
  - `after_delay` (boolean) - Time-based delay
  - `delay_seconds` (integer) - Delay in seconds
  - `created_at` (timestamptz)

  ### 4. trigger_behaviors
  Behavioral rules for trigger execution
  - `id` (uuid, primary key)
  - `trigger_id` (uuid, foreign key) - Parent trigger
  - `show_as_website` (boolean) - Display as website message
  - `execute_if_online` (boolean) - Only if agents online
  - `execute_on_first_visit` (boolean) - First-time visitors only
  - `execute_if_no_other_trigger` (boolean) - Fallback trigger
  - `country_restriction` (text[]) - Allowed country codes
  - `created_at` (timestamptz)

  ### 5. trigger_platforms
  Platform targeting for triggers
  - `id` (uuid, primary key)
  - `trigger_id` (uuid, foreign key) - Parent trigger
  - `desktop_enabled` (boolean) - Run on desktop
  - `mobile_enabled` (boolean) - Run on mobile
  - `created_at` (timestamptz)

  ## Security
  - Enable RLS on all tables
  - Authenticated agents can read/write all trigger data
  - Public (visitors) can only read active triggers and related data
*/

-- Create triggers table
CREATE TABLE IF NOT EXISTS triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  identifier text UNIQUE NOT NULL,
  is_active boolean DEFAULT true,
  priority integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create trigger_actions table
CREATE TABLE IF NOT EXISTS trigger_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  show_message boolean DEFAULT false,
  message_content text,
  localized_messages jsonb DEFAULT '{}',
  open_chatbox boolean DEFAULT false,
  play_sound boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Create trigger_events table
CREATE TABLE IF NOT EXISTS trigger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  on_leave_intent boolean DEFAULT false,
  on_click_link boolean DEFAULT false,
  click_selectors text[] DEFAULT '{}',
  on_pages boolean DEFAULT false,
  page_urls text[] DEFAULT '{}',
  on_url_parameters boolean DEFAULT false,
  url_parameters jsonb DEFAULT '{}',
  on_user_event boolean DEFAULT false,
  user_event_name text,
  on_user_data boolean DEFAULT false,
  user_data_conditions jsonb DEFAULT '{}',
  after_delay boolean DEFAULT false,
  delay_seconds integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Create trigger_behaviors table
CREATE TABLE IF NOT EXISTS trigger_behaviors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  show_as_website boolean DEFAULT false,
  execute_if_online boolean DEFAULT false,
  execute_on_first_visit boolean DEFAULT false,
  execute_if_no_other_trigger boolean DEFAULT false,
  country_restriction text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Create trigger_platforms table
CREATE TABLE IF NOT EXISTS trigger_platforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  desktop_enabled boolean DEFAULT true,
  mobile_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_behaviors ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_platforms ENABLE ROW LEVEL SECURITY;

-- RLS Policies for triggers
CREATE POLICY "Authenticated agents can manage triggers"
  ON triggers FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can view active triggers"
  ON triggers FOR SELECT
  TO anon
  USING (is_active = true);

-- RLS Policies for trigger_actions
CREATE POLICY "Authenticated agents can manage trigger actions"
  ON trigger_actions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can view trigger actions"
  ON trigger_actions FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM triggers
      WHERE triggers.id = trigger_actions.trigger_id
      AND triggers.is_active = true
    )
  );

-- RLS Policies for trigger_events
CREATE POLICY "Authenticated agents can manage trigger events"
  ON trigger_events FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can view trigger events"
  ON trigger_events FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM triggers
      WHERE triggers.id = trigger_events.trigger_id
      AND triggers.is_active = true
    )
  );

-- RLS Policies for trigger_behaviors
CREATE POLICY "Authenticated agents can manage trigger behaviors"
  ON trigger_behaviors FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can view trigger behaviors"
  ON trigger_behaviors FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM triggers
      WHERE triggers.id = trigger_behaviors.trigger_id
      AND triggers.is_active = true
    )
  );

-- RLS Policies for trigger_platforms
CREATE POLICY "Authenticated agents can manage trigger platforms"
  ON trigger_platforms FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Public can view trigger platforms"
  ON trigger_platforms FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM triggers
      WHERE triggers.id = trigger_platforms.trigger_id
      AND triggers.is_active = true
    )
  );

-- Create function to update trigger updated_at timestamp
CREATE OR REPLACE FUNCTION update_trigger_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE triggers
  SET updated_at = now()
  WHERE id = NEW.trigger_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to update parent trigger timestamp
CREATE TRIGGER update_trigger_on_action_change
  AFTER INSERT OR UPDATE OR DELETE ON trigger_actions
  FOR EACH ROW
  EXECUTE FUNCTION update_trigger_timestamp();

CREATE TRIGGER update_trigger_on_event_change
  AFTER INSERT OR UPDATE OR DELETE ON trigger_events
  FOR EACH ROW
  EXECUTE FUNCTION update_trigger_timestamp();

CREATE TRIGGER update_trigger_on_behavior_change
  AFTER INSERT OR UPDATE OR DELETE ON trigger_behaviors
  FOR EACH ROW
  EXECUTE FUNCTION update_trigger_timestamp();

CREATE TRIGGER update_trigger_on_platform_change
  AFTER INSERT OR UPDATE OR DELETE ON trigger_platforms
  FOR EACH ROW
  EXECUTE FUNCTION update_trigger_timestamp();

-- Create index for faster trigger lookups
CREATE INDEX IF NOT EXISTS idx_triggers_active ON triggers(is_active, priority);
CREATE INDEX IF NOT EXISTS idx_trigger_actions_trigger_id ON trigger_actions(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_events_trigger_id ON trigger_events(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_behaviors_trigger_id ON trigger_behaviors(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_platforms_trigger_id ON trigger_platforms(trigger_id);
