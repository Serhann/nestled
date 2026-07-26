export interface Conversation {
  id: string;
  visitor_id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  status: 'active' | 'resolved' | 'waiting';
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  message_count: number;
  ai_greeted: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  sender_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeBaseItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  is_online: boolean;
  last_seen: string;
  created_at: string;
}

export interface PreChatField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel';
  required: boolean;
  placeholder: string;
}

export interface ChatSettings {
  id: string;
  widget_title: string;
  welcome_message: string;
  ai_enabled: boolean;
  primary_color: string;
  ai_provider: 'knowledge_base' | 'openai' | 'ollama';
  openai_api_key: string | null;
  openai_model: string;
  ollama_url: string | null;
  ollama_model: string;
  system_prompt: string;
  pre_chat_enabled: boolean;
  pre_chat_fields: PreChatField[];
  widget_position: 'left' | 'right';
  widget_avatar_url: string | null;
  ai_response_mode: 'always' | 'first_message' | 'off';
  notification_sound_enabled: boolean;
  auto_welcome_enabled: boolean;
  auto_welcome_message: string | null;
  auto_welcome_delay: number;
  discord_webhook_url: string | null;
  discord_webhook_enabled: boolean;
  discord_notify_new_chat: boolean;
  discord_notify_new_message: boolean;
  created_at: string;
  updated_at: string;
}

export interface Trigger {
  id: string;
  name: string;
  identifier: string;
  is_active: boolean;
  priority: number;
  fire_count?: number;
  conversation_count?: number;
  created_at: string;
  updated_at: string;
  actions?: TriggerAction;
  events?: TriggerEvent;
  behaviors?: TriggerBehavior;
  platforms?: TriggerPlatform;
}

export interface TriggerAction {
  id: string;
  trigger_id: string;
  show_message: boolean;
  message_content: string | null;
  localized_messages: Record<string, string>;
  open_chatbox: boolean;
  play_sound: boolean;
  created_at: string;
}

export interface TriggerEvent {
  id: string;
  trigger_id: string;
  on_leave_intent: boolean;
  on_click_link: boolean;
  click_selectors: string[];
  on_pages: boolean;
  page_urls: string[];
  on_url_parameters: boolean;
  url_parameters: Record<string, string>;
  after_delay: boolean;
  delay_seconds: number;
  created_at: string;
}

export interface TriggerBehavior {
  id: string;
  trigger_id: string;
  show_as_website: boolean;
  execute_if_online: boolean;
  execute_on_first_visit: boolean;
  execute_if_no_other_trigger: boolean;
  country_restriction: string[];
  created_at: string;
}

export interface TriggerPlatform {
  id: string;
  trigger_id: string;
  desktop_enabled: boolean;
  mobile_enabled: boolean;
  created_at: string;
}
