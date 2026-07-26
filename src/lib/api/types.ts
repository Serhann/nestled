/**
 * The shapes the API actually returns.
 *
 * Hand-written rather than generated, and deliberately narrower than the database
 * rows: a type here should describe what a screen can rely on, so that widening a
 * response is a visible change rather than a silent one.
 */

export type Role = 'owner' | 'admin' | 'agent';

export type Capability =
  | 'workspace:read'
  | 'workspace:update'
  | 'workspace:delete'
  | 'billing:read'
  | 'billing:manage'
  | 'member:read'
  | 'member:invite'
  | 'member:update'
  | 'member:remove'
  | 'website:create'
  | 'website:read'
  | 'website:delete'
  | 'website_settings:update'
  | 'conversation:read'
  | 'conversation:reply'
  | 'conversation:assign'
  | 'conversation:resolve'
  | 'conversation:delete'
  | 'note:write'
  | 'visitor:read'
  | 'visitor:replay'
  | 'kb:read'
  | 'kb:write'
  | 'canned:read'
  | 'canned:write'
  | 'starter:write'
  | 'trigger:write'
  | 'bot:write'
  | 'routing:write'
  | 'hours:write'
  | 'integration:manage'
  | 'audit:read'
  | 'transcript:send'
  | 'export:data';

export interface PlanLimits {
  seats: number;
  websites: number;
  conversations_month: number;
  ai_replies_month: number;
  kb_entries: number;
  bot_flows: number;
  triggers: number;
  storage_mb: number;
}

export interface PlanFeatures {
  remove_branding: boolean;
  live_view: boolean;
  bot: boolean;
}

export type OnboardingStep = 'website' | 'install' | 'first_conversation' | 'team' | null;

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  role: Role;
  member_id: string;
  permissions: Capability[];
  /** null means every website; otherwise the ids this member may see. */
  website_scope: string[] | null;
  plan: { code: string; name: string; limits: PlanLimits; features: PlanFeatures };
  subscription: {
    status: string;
    trial_ends_at: string | null;
    grace_until: string | null;
  };
  onboarding: { completed: boolean; step: OnboardingStep };
  counts: { open_conversations: number };
}

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
    timezone: string;
    avatar_url: string | null;
    default_workspace_id: string | null;
  };
  workspaces: WorkspaceSummary[];
  impersonation: {
    by_platform_user_id: string;
    scope: 'read_only' | 'full';
    workspace_id: string;
  } | null;
}

export interface Website {
  id: string;
  public_key: string;
  name: string;
  primary_domain: string | null;
  is_active: boolean;
  allowed_domains: string[];
  enforce_domains: boolean;
  installed_at: string | null;
  created_at: string;
}

export type ConversationStatus = 'open' | 'pending' | 'resolved';
export type SenderType = 'visitor' | 'agent' | 'ai' | 'bot' | 'system';

export interface ConversationRow {
  id: string;
  website_id: string;
  visitor_id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  status: ConversationStatus;
  assigned_member_id: string | null;
  needs_human: boolean;
  message_count: number;
  tags: string[];
  rating_stars: number | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
  last_message: string | null;
  last_sender: SenderType | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: SenderType;
  sender_member_id: string | null;
  sender_name: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Note {
  id: string;
  conversation_id: string;
  author_name: string | null;
  content: string;
  created_at: string;
}

export interface ConversationDetail extends Omit<ConversationRow, 'last_message' | 'last_sender'> {
  messages: Message[];
  notes: Note[];
  attachments: Attachment[];
  custom_attributes: Record<string, unknown> | null;
  first_response_at: string | null;
  resolved_at: string | null;
  rating_comment: string | null;
  rating_tags: string[];
}

export interface Attachment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface Member {
  id: string;
  role: Role;
  status: string;
  all_websites: boolean;
  website_ids: string[];
  is_online: boolean;
  last_seen: string | null;
  created_at: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatar_url: string | null;
    last_login_at: string | null;
  };
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  all_websites: boolean;
  website_ids: string[];
  expires_at: string;
  created_at: string;
  expired: boolean;
  author: { name: string } | null;
}

export interface PreChatField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox';
  required: boolean;
  placeholder: string;
  options?: string[];
  maps_to?: 'name' | 'email' | 'phone' | null;
}

export interface WebsiteSettings {
  website_id: string;
  primary_color: string;
  color_mode: 'light' | 'dark' | 'auto';
  radius_px: number;
  font_family: string;
  position: 'left' | 'right';
  offset_x: number;
  offset_y: number;
  launcher_style: 'bubble' | 'pill' | 'custom_icon';
  show_branding: boolean;
  ai_enabled: boolean;
  ai_response_mode: 'off' | 'first_message' | 'when_no_agent_online' | 'always';
  system_prompt: string | null;
  ai_extra_rules: string | null;
  pre_chat_enabled: boolean;
  pre_chat_fields: PreChatField[];
  auto_welcome_enabled: boolean;
  auto_welcome_message: string | null;
  auto_welcome_delay: number;
  file_upload_enabled: boolean;
  sound_enabled: boolean;
  live_view_enabled: boolean;
  transcript_email_enabled: boolean;
  reset_after_resolve: boolean;
  starters_enabled: boolean;
  rating_tags: string[];
  copy: Record<string, string>;
}

export interface BusinessHours {
  website_id: string;
  enabled: boolean;
  timezone: string;
  rules: { dow: number; intervals: [string, string][] }[];
  holidays: { date: string; label?: string }[];
  offline_behavior: 'collect_email' | 'message_only' | 'hide_widget' | 'bot_flow';
  offline_bot_flow_id: string | null;
}

export interface KbEntry {
  id: string;
  website_id: string | null;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  priority: number;
  is_active: boolean;
  created_at: string;
}

export interface CannedResponse {
  id: string;
  website_id: string | null;
  shortcut: string;
  title: string;
  content: string;
  created_at: string;
}

export interface Starter {
  id: string;
  website_id: string | null;
  key: string;
  label: string;
  message: string | null;
  kind: 'auto' | 'human' | 'bot';
  fields: { name: string; label: string; required: boolean }[];
  icon: string | null;
  priority: number;
  is_active: boolean;
}

export interface PresenceVisitor {
  visitor_id: string;
  website_id: string;
  name: string | null;
  email: string | null;
  current_url: string | null;
  page_title: string | null;
  referrer: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  started_at: string;
  last_seen: string;
  page_count: number;
  conversation_id: string | null;
  is_typing?: boolean;
  context?: unknown;
  data?: Record<string, unknown>;
}

export type InstallPhase = 'waiting' | 'wrong_domain' | 'script_seen' | 'message_received';

export interface InstallStatus {
  phase: InstallPhase;
  installed_at: string | null;
  conversations: number;
  domains: { host: string; hits: number; authorized: boolean; last_seen: string }[];
  wrong_domain_host: string | null;
}

export interface UsageCounter {
  metric: string;
  period_start: string;
  value: number;
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}
