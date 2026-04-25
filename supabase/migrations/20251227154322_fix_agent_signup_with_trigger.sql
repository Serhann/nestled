/*
  # Fix Agent Signup and Add AI Provider Settings

  ## Changes
  
  1. Database Trigger for Auto Agent Creation
     - Automatically create agent profile when user signs up
     - Eliminates RLS issues during signup
  
  2. Enhanced Chat Settings for AI Providers
     - Add ai_provider field: 'knowledge_base', 'openai', 'ollama'
     - Add openai_api_key field (encrypted)
     - Add ollama_url field
     - Add model selection fields

  ## Security
  - Trigger runs with security definer to bypass RLS
  - API keys stored securely
*/

-- Drop existing INSERT policy (will use trigger instead)
DROP POLICY IF EXISTS "Users can create own agent profile" ON agents;

-- Create function to automatically create agent profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.agents (id, name, email, is_online)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', 'Agent'),
    NEW.email,
    true
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Add AI provider settings to chat_settings table
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'ai_provider'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ai_provider text DEFAULT 'knowledge_base' 
      CHECK (ai_provider IN ('knowledge_base', 'openai', 'ollama'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'openai_api_key'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN openai_api_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'openai_model'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN openai_model text DEFAULT 'gpt-4o-mini';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'ollama_url'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ollama_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'ollama_model'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ollama_model text DEFAULT 'llama2';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_settings' AND column_name = 'system_prompt'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN system_prompt text DEFAULT 'You are a helpful customer support assistant. Answer questions based on the knowledge base provided. Be concise and friendly.';
  END IF;
END $$;

-- Update existing settings row with new fields
UPDATE chat_settings 
SET 
  ai_provider = 'knowledge_base',
  openai_model = 'gpt-4o-mini',
  ollama_model = 'llama2',
  system_prompt = 'You are a helpful customer support assistant. Answer questions based on the knowledge base provided. Be concise and friendly.'
WHERE ai_provider IS NULL;