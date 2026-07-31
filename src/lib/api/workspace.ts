import { del, get, patch, post } from '../http';
import type {
  AuditEntry,
  BusinessHours,
  InstallStatus,
  Invite,
  Member,
  Role,
  UsageCounter,
  Website,
  WebsiteSettings,
} from './types';

/**
 * Everything under `/api/v1/w/:workspaceId/…`.
 *
 * The workspace id is a required first argument on every call rather than
 * ambient state. That is the same reason it is a path segment on the server: two
 * tabs open on two workspaces must not be able to interfere, and a function that
 * reads "the current workspace" from a module-level variable is exactly how they
 * would.
 */

const w = (workspaceId: string, path: string): string => `/api/v1/w/${workspaceId}${path}`;

// ── Workspace ───────────────────────────────────────────────────────────────
export const createWorkspace = (input: {
  name: string;
  slug?: string;
  timezone?: string;
}): Promise<{ workspace: { id: string; slug: string; name: string } }> =>
  post('/api/v1/workspaces', input);

export const getWorkspace = (id: string): Promise<{ workspace: Record<string, unknown> }> =>
  get(w(id, ''));

export const updateWorkspace = (
  id: string,
  input: { name?: string; slug?: string; timezone?: string },
): Promise<{ workspace: { id: string; slug: string; name: string } }> => patch(w(id, ''), input);

// ── Websites ────────────────────────────────────────────────────────────────
export const listWebsites = (id: string): Promise<{ websites: Website[] }> =>
  get(w(id, '/websites'));

export const createWebsite = (
  id: string,
  input: { name: string; primary_domain?: string; allowed_domains?: string[]; enforce_domains?: boolean },
): Promise<{ website: Website }> => post(w(id, '/websites'), input);

export const updateWebsite = (
  id: string,
  websiteId: string,
  input: Partial<Pick<Website, 'name' | 'primary_domain' | 'allowed_domains' | 'enforce_domains' | 'is_active'>>,
): Promise<{ website: Website }> => patch(w(id, `/websites/${websiteId}`), input);

export const deleteWebsite = (id: string, websiteId: string): Promise<{ ok: true }> =>
  del(w(id, `/websites/${websiteId}`));

export const installStatus = (id: string, websiteId: string): Promise<InstallStatus> =>
  get(w(id, `/websites/${websiteId}/install-status`));

// ── Website settings ────────────────────────────────────────────────────────
export interface SettingsBundle {
  website: Website & { has_identity_secret: boolean };
  settings: WebsiteSettings;
  hours: BusinessHours | null;
  /** Only overrides are stored, so the editor needs these to show placeholders. */
  copy_defaults: Record<string, string>;
  plan_features: { remove_branding: boolean; live_view: boolean };
}

export const getSettings = (id: string, websiteId: string): Promise<SettingsBundle> =>
  get(w(id, `/websites/${websiteId}/settings`));

export const updateSettings = (
  id: string,
  websiteId: string,
  input: Partial<WebsiteSettings>,
): Promise<{ settings: WebsiteSettings }> => patch(w(id, `/websites/${websiteId}/settings`), input);

export const updateHours = (
  id: string,
  websiteId: string,
  input: Partial<BusinessHours>,
): Promise<{ hours: BusinessHours }> => patch(w(id, `/websites/${websiteId}/hours`), input);

export const rotateIdentitySecret = (
  id: string,
  websiteId: string,
): Promise<{ secret: string; warning: string }> =>
  post(w(id, `/websites/${websiteId}/identity-secret`));

// ── Team ────────────────────────────────────────────────────────────────────
export const listMembers = (
  id: string,
): Promise<{ members: Member[]; seats: { used: number; included: number } }> =>
  get(w(id, '/members'));

export const updateMember = (
  id: string,
  memberId: string,
  input: { role?: Role; status?: string; all_websites?: boolean; website_ids?: string[] },
): Promise<{ ok: true }> => patch(w(id, `/members/${memberId}`), input);

export const removeMember = (id: string, memberId: string): Promise<{ ok: true }> =>
  del(w(id, `/members/${memberId}`));

export const listInvites = (id: string): Promise<{ invites: Invite[] }> => get(w(id, '/invites'));

export const createInvite = (
  id: string,
  input: { email: string; role: Role; all_websites?: boolean; website_ids?: string[] },
): Promise<{ invite: Invite }> => post(w(id, '/invites'), input);

export const revokeInvite = (id: string, inviteId: string): Promise<{ ok: true }> =>
  del(w(id, `/invites/${inviteId}`));

// ── Integrations, usage, audit ──────────────────────────────────────────────
export interface Integrations {
  discord_webhook_enabled: boolean;
  has_discord_webhook: boolean;
  discord_notify_new_chat: boolean;
  discord_notify_new_message: boolean;

  /**
   * Email/SMS when a visitor leaves details and nobody is online. Recipients are LISTS
   * rather than the member table because we hold no phone numbers anywhere, and because
   * "should all twenty agents be texted at 3am" is a question only the customer can answer.
   */
  offline_alert_enabled: boolean;
  /** Email only: also send to every member who can see the website. */
  offline_alert_notify_agents: boolean;
  offline_alert_emails: string[];
  /** E.164. The server rejects anything else — a local format is an alert that never lands. */
  offline_alert_phones: string[];
}

export const getIntegrations = (id: string): Promise<{ integrations: Integrations }> =>
  get(w(id, '/integrations'));

export const updateIntegrations = (
  id: string,
  input: Partial<Integrations & { discord_webhook_url: string | null }>,
): Promise<{ ok: true }> => patch(w(id, '/integrations'), input);

export const getUsage = (
  id: string,
): Promise<{ counters: UsageCounter[]; limits: Record<string, number> }> => get(w(id, '/usage'));

export const getAudit = (id: string): Promise<{ entries: AuditEntry[] }> => get(w(id, '/audit'));

// ── Channel endpoints ───────────────────────────────────────────────────────

export interface ChannelEndpoint {
  id: string;
  channel: 'email' | 'sms';
  address: string;
  label: string | null;
  is_active: boolean;
  verified_at: string | null;
  last_inbound_at: string | null;
  created_at: string;
}

export const listChannelEndpoints = (
  id: string,
  websiteId: string,
): Promise<{ endpoints: ChannelEndpoint[]; inbound_mail_domain: string | null }> =>
  get(`/api/v1/w/${id}/websites/${websiteId}/channels`);

export const addChannelEndpoint = (
  id: string,
  websiteId: string,
  input: { channel: 'email' | 'sms'; address: string; label?: string },
): Promise<{ endpoint: ChannelEndpoint }> =>
  post(`/api/v1/w/${id}/websites/${websiteId}/channels`, input);

export const deleteChannelEndpoint = (
  id: string,
  websiteId: string,
  endpointId: string,
): Promise<{ ok: true }> => del(`/api/v1/w/${id}/websites/${websiteId}/channels/${endpointId}`);
