/*
  # Add Auto-Welcome Message and Discord Webhook Settings

  ## Overview
  This migration adds auto-welcome message functionality and Discord webhook integration for new chat notifications.

  ## Changes

  ### chat_settings table updates
  1. New Columns for Auto-Welcome
    - `auto_welcome_enabled` (boolean) - Enable/disable auto-welcome messages, default false
    - `auto_welcome_message` (text) - Message content for auto-welcome
    - `auto_welcome_delay` (integer) - Delay in seconds before showing message, default 5

  2. New Columns for Discord Integration
    - `discord_webhook_url` (text) - Discord webhook URL for notifications
    - `discord_webhook_enabled` (boolean) - Enable/disable Discord notifications, default false
    - `discord_notify_new_chat` (boolean) - Notify when new chat starts, default true
    - `discord_notify_new_message` (boolean) - Notify on each new message, default false

  ## Security
  - All existing RLS policies remain in effect
  - No security changes needed for these additions
*/

-- Add auto-welcome columns to chat_settings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'auto_welcome_enabled'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN auto_welcome_enabled boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'auto_welcome_message'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN auto_welcome_message text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'auto_welcome_delay'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN auto_welcome_delay integer DEFAULT 5;
  END IF;
END $$;

-- Add Discord webhook columns to chat_settings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'discord_webhook_url'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN discord_webhook_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'discord_webhook_enabled'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN discord_webhook_enabled boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'discord_notify_new_chat'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN discord_notify_new_chat boolean DEFAULT true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'discord_notify_new_message'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN discord_notify_new_message boolean DEFAULT false;
  END IF;
END $$;
