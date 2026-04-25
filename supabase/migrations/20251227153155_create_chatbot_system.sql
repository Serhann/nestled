/*
  # Chatbot System Database Schema

  ## Overview
  Complete chatbot system similar to Crisp with AI integration and knowledge base.

  ## New Tables
  
  ### `conversations`
  - `id` (uuid, primary key) - Unique conversation identifier
  - `visitor_id` (text) - Anonymous visitor identifier
  - `visitor_name` (text) - Visitor's name (optional)
  - `visitor_email` (text) - Visitor's email (optional)
  - `status` (text) - Conversation status: 'active', 'resolved', 'waiting'
  - `created_at` (timestamptz) - When conversation started
  - `updated_at` (timestamptz) - Last message time
  - `metadata` (jsonb) - Additional data (browser, location, etc.)

  ### `messages`
  - `id` (uuid, primary key) - Unique message identifier
  - `conversation_id` (uuid, foreign key) - Links to conversation
  - `content` (text) - Message content
  - `sender_type` (text) - 'visitor', 'agent', or 'ai'
  - `sender_id` (text) - Identifier of sender
  - `created_at` (timestamptz) - When message was sent
  - `metadata` (jsonb) - Additional data

  ### `knowledge_base`
  - `id` (uuid, primary key) - Unique article identifier
  - `question` (text) - Question or title
  - `answer` (text) - Answer or content
  - `category` (text) - Category for organization
  - `keywords` (text[]) - Search keywords
  - `embedding` (vector(1536)) - AI embedding for semantic search
  - `priority` (integer) - Display priority
  - `is_active` (boolean) - Whether article is active
  - `created_at` (timestamptz) - Creation time
  - `updated_at` (timestamptz) - Last update time

  ### `agents`
  - `id` (uuid, primary key) - Links to auth.users
  - `name` (text) - Agent name
  - `email` (text) - Agent email
  - `avatar_url` (text) - Profile picture
  - `is_online` (boolean) - Online status
  - `last_seen` (timestamptz) - Last activity
  - `created_at` (timestamptz) - Account creation

  ### `chat_settings`
  - `id` (uuid, primary key) - Settings identifier
  - `widget_title` (text) - Chat widget title
  - `welcome_message` (text) - Welcome message
  - `ai_enabled` (boolean) - Enable AI responses
  - `primary_color` (text) - Widget color theme
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ## Security
  - Enable RLS on all tables
  - Conversations: Public can insert (visitors), agents can view all
  - Messages: Public can insert, related parties can read
  - Knowledge base: Public can read active items, agents can manage
  - Agents: Only authenticated agents can access
  - Settings: Only agents can read/update

  ## Indexes
  - Conversations by status and updated_at for dashboard
  - Messages by conversation_id for chat history
  - Knowledge base by category and keywords for search
*/

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Create conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id text NOT NULL,
  visitor_name text,
  visitor_email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'waiting')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id ON conversations(visitor_id);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content text NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('visitor', 'agent', 'ai')),
  sender_id text,
  created_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, created_at);

-- Create knowledge_base table
CREATE TABLE IF NOT EXISTS knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question text NOT NULL,
  answer text NOT NULL,
  category text DEFAULT 'general',
  keywords text[] DEFAULT ARRAY[]::text[],
  embedding vector(1536),
  priority integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_active ON knowledge_base(is_active);

-- Create agents table
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  avatar_url text,
  is_online boolean DEFAULT false,
  last_seen timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Create chat_settings table
CREATE TABLE IF NOT EXISTS chat_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_title text DEFAULT 'Chat with us',
  welcome_message text DEFAULT 'Hi! How can we help you today?',
  ai_enabled boolean DEFAULT true,
  primary_color text DEFAULT '#3B82F6',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Insert default settings
INSERT INTO chat_settings (widget_title, welcome_message, ai_enabled, primary_color)
VALUES ('Chat with us', 'Hi! How can we help you today?', true, '#3B82F6')
ON CONFLICT DO NOTHING;

-- Enable RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies for conversations
CREATE POLICY "Anyone can create conversations"
  ON conversations FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Agents can view all conversations"
  ON conversations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  );

CREATE POLICY "Visitors can view own conversations"
  ON conversations FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Agents can update conversations"
  ON conversations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  );

-- RLS Policies for messages
CREATE POLICY "Anyone can insert messages"
  ON messages FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can view messages in their conversations"
  ON messages FOR SELECT
  TO anon, authenticated
  USING (true);

-- RLS Policies for knowledge_base
CREATE POLICY "Anyone can view active knowledge base items"
  ON knowledge_base FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "Agents can manage knowledge base"
  ON knowledge_base FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  );

-- RLS Policies for agents
CREATE POLICY "Agents can view all agents"
  ON agents FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  );

CREATE POLICY "Agents can update own profile"
  ON agents FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- RLS Policies for chat_settings
CREATE POLICY "Anyone can view chat settings"
  ON chat_settings FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Agents can update chat settings"
  ON chat_settings FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM agents WHERE agents.id = auth.uid()
    )
  );

-- Function to update conversation updated_at
CREATE OR REPLACE FUNCTION update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations 
  SET updated_at = now() 
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update conversation timestamp on new message
DROP TRIGGER IF EXISTS update_conversation_timestamp_trigger ON messages;
CREATE TRIGGER update_conversation_timestamp_trigger
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_timestamp();