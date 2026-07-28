/**
 * Wire types for the visitor-facing chat plane.
 *
 * These mirror what `server/src/routes/v1/widget.ts` actually sends. They are
 * type-only (erased at build time), so the widget pays nothing for importing
 * them from outside its own directory.
 *
 * Everything the visitor can see is DESCRIBED here rather than interpreted: the
 * widget renders a `ContextCard` or a `BotStep` exactly as handed to it and has
 * no opinion about what an order, a ticket or a bot flow is. That is the whole
 * reason those two shapes are presentation payloads and not domain objects.
 */

export type SenderType = 'visitor' | 'agent' | 'ai' | 'bot' | 'system';

export interface ChatMessage {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: SenderType;
  sender_member_id: string | null;
  metadata: MessageMetadata;
  created_at: string;
}

export interface MessageMetadata {
  agent?: { name?: string | null; avatar_url?: string | null };
  /** Server-rendered presentation payload — see ContextCard. */
  context_card?: ContextCard;
  /**
   * Bot runtime hint. The flow itself executes server-side; this is only the
   * shape of the next thing to draw. Both spellings are accepted because the
   * runtime is being written in parallel — see BotStep.tsx.
   */
  bot_step?: BotStep;
  'bot:step'?: BotStep;
  [key: string]: unknown;
}

// ── Boot ────────────────────────────────────────────────────────────────────

export interface BootTheme {
  primary_color: string;
  color_mode: 'light' | 'dark' | 'auto';
  radius_px: number;
  font_family: string;
  position: 'left' | 'right';
  offset_x: number;
  offset_y: number;
  launcher_style: 'bubble' | 'pill' | 'custom_icon';
  /** 40–96 px. */
  launcher_size: number;
  launcher_icon: 'chat' | 'question' | 'sparkle' | 'envelope' | 'wave';
  header_style: 'solid' | 'soft' | 'minimal';
  bubble_style: 'brand' | 'neutral';
  panel_width: number;
  launcher_pulse: boolean;
  /** Null = use `primary_color` in dark mode too. */
  primary_color_dark: string | null;
  brand_avatar_url: string | null;
  show_branding: boolean;
}

export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'textarea';
  required?: boolean;
  placeholder?: string;
}

export interface BootBehavior {
  ai_enabled: boolean;
  pre_chat_enabled: boolean;
  pre_chat_fields: FormField[];
  auto_welcome_enabled: boolean;
  auto_welcome_message: string | null;
  auto_welcome_delay: number;
  file_upload_enabled: boolean;
  sound_enabled: boolean;
  reset_after_resolve: boolean;
  rating_tags: string[];
}

export interface Starter {
  id: string;
  label: string;
  message: string | null;
  kind: 'auto' | 'human' | 'bot';
  fields: FormField[];
  icon: string | null;
}

export interface Availability {
  online: boolean;
  within_hours: boolean;
  offline_behavior: string;
}

export interface BootPayload {
  enabled: boolean;
  authorized?: boolean;
  website?: { id: string; name: string };
  theme?: BootTheme;
  copy?: Record<string, string>;
  behavior?: BootBehavior;
  starters?: Starter[];
  triggers?: Trigger[];
  availability?: Availability;
  /**
   * Reserved. The server does not send this yet — see the ContextCard note in
   * ContextCard.tsx. Typed now so adding it server-side needs no client change.
   */
  context_card?: ContextCard;
}

// ── Presentation payloads the widget renders without interpreting ───────────

export interface ContextCard {
  title?: string;
  subtitle?: string;
  badge?: { label: string; tone?: 'neutral' | 'positive' | 'warning' | 'danger' };
  fields?: { label: string; value: string }[];
  progress?: { steps: string[]; current: number };
  actions?: { label: string; url: string }[];
}

export interface BotStep {
  /** Echoed back with the answer so the server can correlate it to a node. */
  id?: string;
  prompt?: string;
  choices?: { value: string; label: string }[];
  fields?: FormField[];
  submit_label?: string;
}

// ── Triggers ────────────────────────────────────────────────────────────────
// Stored as four jsonb columns, so every member is optional on the wire.

export interface TriggerAction {
  show_message?: boolean;
  message_content?: string | null;
  open_chatbox?: boolean;
  play_sound?: boolean;
}

export interface TriggerEvent {
  on_leave_intent?: boolean;
  on_click_link?: boolean;
  click_selectors?: string[];
  on_pages?: boolean;
  page_urls?: string[];
  on_url_parameters?: boolean;
  url_parameters?: Record<string, string>;
  after_delay?: boolean;
  delay_seconds?: number;
}

export interface TriggerBehavior {
  execute_if_online?: boolean;
  execute_on_first_visit?: boolean;
  execute_if_no_other_trigger?: boolean;
  country_restriction?: string[];
}

export interface TriggerPlatform {
  desktop_enabled?: boolean;
  mobile_enabled?: boolean;
}

export interface Trigger {
  id: string;
  identifier: string;
  actions?: TriggerAction | null;
  events?: TriggerEvent | null;
  behaviors?: TriggerBehavior | null;
  platforms?: TriggerPlatform | null;
}
