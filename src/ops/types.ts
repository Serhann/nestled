/**
 * Response shapes, mirrored from server/src/routes/platform/*.
 *
 * Hand-written rather than generated: this panel consumes maybe twenty endpoints,
 * and a codegen step in the build for that is a maintenance cost with no payer.
 * Each type names the route it came from so the pair can be kept honest by reading.
 */

export interface Plan {
  id: string;
  code: string;
  name: string;
  is_public: boolean;
  sort_order: number;
  is_trial_default: boolean;
  price_monthly_cents: number;
  price_yearly_cents: number;
  included_seats: number;
  max_seats: number;
  max_websites: number;
  max_conversations_month: number;
  max_ai_replies_month: number;
  max_kb_entries: number;
  max_bot_flows: number;
  max_triggers: number;
  storage_mb: number;
  retention_days: number;
  allow_remove_branding: boolean;
  allow_live_view: boolean;
  allow_bot: boolean;
  _count?: { workspaces: number; subscriptions: number };
}

/** GET /platform/search */
export interface SearchResult {
  kind: 'workspace' | 'user' | 'website' | 'conversation' | 'person' | 'invoice';
  id: string;
  label: string;
  sublabel: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  matched: string;
}

export interface SearchResponse {
  query: string;
  interpretedAs: 'email' | 'website_key' | 'domain' | 'uuid' | 'text';
  results: SearchResult[];
}

/** GET /platform/workspaces */
export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  subscription_status: string;
  trial_ends_at: string | null;
  grace_until: string | null;
  deleted_at: string | null;
  created_at: string;
  plan: { code: string; name: string };
  _count: { members: number; websites: number; conversations: number };
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceRow[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

/** GET /platform/workspaces/:id */
export interface WorkspaceOverview {
  workspace: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    subscription_status: string;
    trial_ends_at: string | null;
    grace_until: string | null;
    purge_after: string | null;
    deleted_at: string | null;
    stripe_customer_id: string | null;
    created_at: string;
    plan: Plan;
    subscription: { status: string; interval: string; current_period_end: string } | null;
    _count: { members: number; websites: number; conversations: number; invites: number };
  };
  owners: { id: string; name: string; email: string; last_login_at: string | null }[];
  signals: { last_conversation_at: string | null; installed_websites: number };
}

/** GET /platform/workspaces/:id/plan */
export interface WorkspacePlanTab {
  plan: Plan;
  is_override: boolean;
  subscription_status: string;
  /** `manual` = we bill them another way, and Stripe is ignored for this workspace. */
  billing_mode: 'stripe' | 'manual';
  /** The Stripe mirror, when there is one. Present here since 0011's manual billing. */
  subscription: { status: string; interval: string; cancel_at_period_end: boolean } | null;
  trial_ends_at: string | null;
  grace_until: string | null;
  invoices: {
    id: string;
    number: string | null;
    status: string;
    amount_due: number;
    amount_paid: number;
    currency: string;
    hosted_invoice_url: string | null;
    created_at: string;
  }[];
  catalog: Plan[];
}

/** GET /platform/workspaces/:id/usage */
export interface WorkspaceUsageTab {
  current: Record<string, number>;
  levels: { seats: number; websites: number };
  limits: Record<string, number>;
  ai_this_period: { calls: number; input_tokens: number; output_tokens: number; cost_micros: number };
}

/** GET /platform/workspaces/:id/websites */
export interface WorkspaceWebsite {
  id: string;
  name: string;
  public_key: string;
  primary_domain: string | null;
  is_active: boolean;
  installed_at: string | null;
  deleted_at: string | null;
  has_identity_secret: boolean;
  _count: { conversations: number };
  domains: { host: string; hits: number; authorized: boolean; last_seen: string }[];
}

/**
 * GET /platform/workspaces/:id/websites/:websiteId/prompt
 *
 * Every tier is returned, not just the one in force: an empty override field means "use
 * the install's, or ours", and a UI that cannot show WHICH invites somebody to paste a
 * whole new prompt when they meant to change one sentence.
 */
export interface WebsitePrompt {
  website_name: string;
  source: 'website' | 'install' | 'default';
  website: string | null;
  install: string | null;
  default: string;
  effective_template: string;
  actions: {
    catalog: { name: string; placeholder: string; always: boolean }[];
    enabled: string[];
    values: Record<string, string[]>;
  };
  /** The whole system prompt as the model receives it, with the two per-conversation
   *  blocks described rather than filled in. */
  assembled: string;
}

/** GET /platform/workspaces/:id/members */
export interface WorkspaceMember {
  id: string;
  role: string;
  status: string;
  all_websites: boolean;
  is_online: boolean;
  last_seen: string;
  user: { id: string; name: string; email: string; email_verified_at: string | null; last_login_at: string | null };
}

/** GET /platform/workspaces/:id/conversations — metadata only, by design. */
export interface WorkspaceConversation {
  id: string;
  status: string;
  source: string;
  visitor_name: string | null;
  visitor_email: string | null;
  message_count: number;
  rating_stars: number | null;
  created_at: string;
  updated_at: string;
  website: { id: string; name: string } | null;
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface ImpersonationSession {
  id: string;
  reason: string;
  scope: 'read_only' | 'full';
  ip: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  active: boolean;
  mutations: number;
  platform_user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; slug: string };
}

/** GET /platform/dunning */
export interface DunningRow {
  bucket: 'payment_failed' | 'grace' | 'trial_ending' | 'trial_expired' | 'pending_purge';
  workspace_id: string;
  name: string;
  slug: string;
  plan_code: string;
  subscription_status: string;
  days_remaining: number | null;
  deadline: string | null;
  amount_due_cents: number;
  currency: string | null;
  owner_email: string | null;
  last_invoice_url: string | null;
  priority: number;
}

export interface DunningResponse {
  rows: DunningRow[];
  totals: Record<string, { count: number; amount_due_cents: number }>;
  total_at_risk_cents: number;
}

/** GET /platform/health */
export interface HealthCheck {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface HealthReport {
  generated_at: string;
  process: {
    started_at: string;
    uptime_seconds: number;
    node_env: string;
    /** Promise rejections the crash guard contained. Nonzero = a fire-and-forget bug. */
    contained_rejections: number;
    last_contained_rejection: { at: string; message: string } | null;
  };
  database: HealthCheck & { latency_ms: number | null };
  realtime: HealthCheck & {
    workspacesWithAgents: number;
    agentSockets: number;
    visitorSockets: number;
    conversationsWithVisitors: number;
  };
  push: HealthCheck & {
    configured: boolean;
    /** Set when keys ARE present but web-push refuses them — a fault, not a choice. */
    key_error: string | null;
    failures: number;
    errors: number;
    stored_subscriptions: number;
  };
  geoip: HealthCheck & { source: string; path: string | null; age_days: number | null };
  retention: HealthCheck & { enabled: boolean; last_run: { at: string; ok: boolean } | null };
  email: HealthCheck & { queued: number; failed: number; smtp_configured: boolean };
  billing: HealthCheck & { unprocessed_stripe_events: number; stripe_configured: boolean };
}

/**
 * GET /platform/audit — the cross-workspace read.
 *
 * A superset of `AuditEntry` above, which is the per-workspace activity tab's row. Kept
 * as its own type rather than widening that one: this view carries the workspace, the IP
 * and the restore handle, and none of those belong on a list already scoped to one
 * customer.
 */
export interface PlatformAuditEntry {
  id: string;
  workspace_id: string | null;
  actor_type: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  impersonation_session_id: string | null;
  /** Null once the workspace itself has been purged — `details.label` survives it. */
  workspace: { name: string; slug: string } | null;
  /**
   * Present only while this entry's deletion can still be undone. Resolved by the
   * server from `deletion_events`, so the button never offers to reverse something
   * that was purged months ago.
   */
  restore: { deletion_event_id: string; days_left: number } | null;
}

export interface AuditPage {
  entries: PlatformAuditEntry[];
  total: number;
  page: number;
  per_page: number;
}

/** GET /platform/deletions */
export interface DeletionEvent {
  id: string;
  actor_type: string;
  actor_email: string | null;
  workspace_id: string | null;
  target_type: 'workspace' | 'website' | 'user' | 'conversation';
  target_id: string;
  target_label: string | null;
  reason: string;
  targets: { table: string; ids: string[] }[];
  created_at: string;
  purge_after: string;
  restored_at: string | null;
  purged_at: string | null;
  restore_days_left: number;
  workspace: { name: string; slug: string } | null;
}

/** GET /platform/diagnostics/client-ip */
export interface ClientIpDiagnostics {
  resolved: string;
  configured_header: string | null;
  headers: Record<string, string | null>;
  socket: string;
}

/** GET /platform/users */
export interface StaffAccount {
  id: string;
  email: string;
  name: string;
  role: string;
  /** Scopes beyond the role's bundle. */
  granted_scopes: string[];
  /** Scopes removed from it. Deny wins, superadmin included. */
  denied_scopes: string[];
  /** role ∪ granted − denied, resolved by the server so the panel never recomputes it. */
  capabilities: string[];
  totp_enabled: boolean;
  must_change_password: boolean;
  disabled_at: string | null;
  created_at: string;
  _count: { sessions: number; impersonations: number };
}

export interface StaffListResponse {
  users: StaffAccount[];
  /**
   * The vocabulary, from the server. `by_role` is what each role grants on its own,
   * which is what lets the UI show a tick as "added beyond the role" rather than as a
   * bare tick — without it, changing the role tells you nothing about what it did.
   */
  catalog: {
    capabilities: string[];
    roles: string[];
    by_role: Record<string, string[]>;
  };
}
