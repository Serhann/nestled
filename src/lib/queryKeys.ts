import type { InboxFilters } from './api/inbox';

/**
 * Query keys, in one place.
 *
 * Every workspace-scoped key starts `['w', workspaceId, …]`, which is what makes
 * "throw away everything for this workspace" a one-line invalidation — needed on
 * a realtime resync, and needed again when a workspace switch must not leave the
 * previous tenant's rows on screen for a frame.
 */
export const qk = {
  me: () => ['me'] as const,
  plans: () => ['plans'] as const,

  workspace: (id: string) => ['w', id] as const,
  websites: (id: string) => ['w', id, 'websites'] as const,
  websiteSettings: (id: string, websiteId: string) => ['w', id, 'websites', websiteId, 'settings'] as const,
  installStatus: (id: string, websiteId: string) => ['w', id, 'websites', websiteId, 'install'] as const,

  conversations: (id: string, filters: InboxFilters) => ['w', id, 'conversations', filters] as const,
  conversation: (id: string, conversationId: string) => ['w', id, 'conversation', conversationId] as const,
  notes: (id: string, conversationId: string) => ['w', id, 'conversation', conversationId, 'notes'] as const,

  presence: (id: string) => ['w', id, 'presence'] as const,
  visitorPerson: (id: string, visitorId: string) => ['w', id, 'visitor', visitorId, 'person'] as const,
  visitorIps: (id: string, visitorId: string) => ['w', id, 'visitor', visitorId, 'ips'] as const,

  members: (id: string) => ['w', id, 'members'] as const,
  invites: (id: string) => ['w', id, 'invites'] as const,

  kb: (id: string) => ['w', id, 'kb'] as const,
  canned: (id: string) => ['w', id, 'canned'] as const,
  starters: (id: string) => ['w', id, 'starters'] as const,

  triggers: (id: string) => ['w', id, 'triggers'] as const,
  routing: (id: string) => ['w', id, 'routing'] as const,
  bots: (id: string) => ['w', id, 'bots'] as const,
  bot: (id: string, flowId: string) => ['w', id, 'bots', flowId] as const,

  billing: (id: string) => ['w', id, 'billing'] as const,
  usage: (id: string) => ['w', id, 'usage'] as const,
  integrations: (id: string) => ['w', id, 'integrations'] as const,
  audit: (id: string) => ['w', id, 'audit'] as const,
} as const;
