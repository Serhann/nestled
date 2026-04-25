/*
  # Add AI Configuration Columns to chat_settings
  
  ## Problem
  The SettingsPanel tries to save AI configuration fields that don't exist in the database:
  - ai_provider
  - openai_api_key
  - openai_model
  - ollama_url
  - ollama_model
  - system_prompt
  
  ## Changes
  Add missing columns to chat_settings table with appropriate defaults
  
  ## New Columns
  - `ai_provider` (text) - AI provider selection: 'knowledge_base', 'openai', or 'ollama'
  - `openai_api_key` (text) - OpenAI API key (nullable for security)
  - `openai_model` (text) - OpenAI model name
  - `ollama_url` (text) - Ollama server URL (nullable)
  - `ollama_model` (text) - Ollama model name
  - `system_prompt` (text) - AI system prompt instructions
  
  ## Security
  - API keys are stored encrypted at rest by Supabase
  - Only agents can read/update settings (existing RLS policies apply)
*/

-- Add AI provider configuration columns
DO $$
BEGIN
  -- Add ai_provider column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'ai_provider'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ai_provider text DEFAULT 'knowledge_base' 
    CHECK (ai_provider IN ('knowledge_base', 'openai', 'ollama'));
  END IF;

  -- Add openai_api_key column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'openai_api_key'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN openai_api_key text;
  END IF;

  -- Add openai_model column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'openai_model'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN openai_model text DEFAULT 'gpt-4o-mini';
  END IF;

  -- Add ollama_url column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'ollama_url'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ollama_url text;
  END IF;

  -- Add ollama_model column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'ollama_model'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN ollama_model text DEFAULT 'llama2';
  END IF;

  -- Add system_prompt column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'system_prompt'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN system_prompt text DEFAULT 'You are a helpful customer support assistant. Answer questions clearly and professionally based on the provided knowledge base.';
  END IF;
END $$;

-- Update existing settings row with defaults if it exists
UPDATE chat_settings 
SET 
  ai_provider = COALESCE(ai_provider, 'knowledge_base'),
  openai_model = COALESCE(openai_model, 'gpt-4o-mini'),
  ollama_model = COALESCE(ollama_model, 'llama2'),
  system_prompt = COALESCE(system_prompt, 'You are a helpful customer support assistant. Answer questions clearly and professionally based on the provided knowledge base.')
WHERE ai_provider IS NULL OR openai_model IS NULL OR ollama_model IS NULL OR system_prompt IS NULL;
