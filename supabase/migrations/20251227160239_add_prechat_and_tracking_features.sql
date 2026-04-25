/*
  # Add Pre-chat Form and Visitor Tracking Features
  
  ## New Features
  
  1. Pre-chat Form Configuration
     - Enable/disable pre-chat form
     - Configure which fields to collect (email, order number, custom fields)
     - Store responses in conversation metadata
  
  2. Visitor Tracking
     - Track current page URL
     - Track visited pages during session
     - Store IP address
     - Store geolocation data
  
  ## Changes to chat_settings table
  - `pre_chat_enabled` (boolean) - Enable/disable pre-chat form
  - `pre_chat_fields` (jsonb) - Array of field configurations
    Each field: { name: string, label: string, type: 'text'|'email'|'tel', required: boolean, placeholder: string }
  
  ## Conversation metadata will store
  - pre_chat_responses: object with field answers
  - current_page: URL where chat was initiated
  - visited_pages: array of URLs visited during chat
  - ip_address: visitor IP
  - location: { country, city, region } from IP geolocation
  
  ## Security
  - All existing RLS policies apply
  - IP and location data helps with analytics and support
*/

-- Add pre-chat form configuration columns
DO $$
BEGIN
  -- Add pre_chat_enabled column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'pre_chat_enabled'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN pre_chat_enabled boolean DEFAULT false;
  END IF;

  -- Add pre_chat_fields column (JSONB array of field definitions)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_settings' AND column_name = 'pre_chat_fields'
  ) THEN
    ALTER TABLE chat_settings ADD COLUMN pre_chat_fields jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Update existing settings with default pre-chat fields
UPDATE chat_settings 
SET 
  pre_chat_enabled = COALESCE(pre_chat_enabled, false),
  pre_chat_fields = COALESCE(
    pre_chat_fields, 
    '[
      {
        "name": "visitor_name",
        "label": "İsim",
        "type": "text",
        "required": true,
        "placeholder": "Adınız"
      },
      {
        "name": "visitor_email",
        "label": "E-posta",
        "type": "email",
        "required": true,
        "placeholder": "ornek@email.com"
      },
      {
        "name": "order_number",
        "label": "Sipariş Numarası",
        "type": "text",
        "required": false,
        "placeholder": "Opsiyonel"
      }
    ]'::jsonb
  )
WHERE pre_chat_enabled IS NULL OR pre_chat_fields IS NULL;

-- Create index on metadata for better query performance
CREATE INDEX IF NOT EXISTS idx_conversations_metadata ON conversations USING gin(metadata);
