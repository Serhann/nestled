/*
  # Add Widget Customization and Multi-Agent Features

  ## Changes

  ### chat_settings table updates
  1. New Columns
    - `widget_position` (text) - Widget position: 'left' or 'right', default 'right'
    - `widget_avatar_url` (text) - Custom avatar URL for the chatbot
    - `ai_response_mode` (text) - AI response behavior: 'always', 'first_message', 'off', default 'first_message'
    - `notification_sound_enabled` (boolean) - Enable/disable notification sounds, default true

  ### agents table updates
  1. New Columns
    - Update avatar_url to have a default value

  ### conversations table updates
  1. New Columns
    - `message_count` (integer) - Track number of messages in conversation
    - `ai_greeted` (boolean) - Track if AI has sent initial greeting

  ## Security
  - All existing RLS policies remain in effect
  - No security changes needed for these additions
*/

-- Add new columns to chat_settings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'widget_position'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN widget_position text DEFAULT 'right' CHECK (widget_position IN ('left', 'right'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'widget_avatar_url'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN widget_avatar_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'ai_response_mode'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ai_response_mode text DEFAULT 'first_message' CHECK (ai_response_mode IN ('always', 'first_message', 'off'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'notification_sound_enabled'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN notification_sound_enabled boolean DEFAULT true;
  END IF;
END $$;

-- Add new columns to conversations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'message_count'
  ) THEN
    ALTER TABLE conversations ADD COLUMN message_count integer DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'ai_greeted'
  ) THEN
    ALTER TABLE conversations ADD COLUMN ai_greeted boolean DEFAULT false;
  END IF;
END $$;

-- Create function to increment message count
CREATE OR REPLACE FUNCTION increment_message_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET message_count = message_count + 1
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to increment message count
DROP TRIGGER IF EXISTS increment_message_count_trigger ON messages;
CREATE TRIGGER increment_message_count_trigger
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION increment_message_count();

-- Update existing conversations to have correct message counts
UPDATE conversations c
SET message_count = (
  SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
)
WHERE message_count = 0;
