// Notification settings and the conversation are read for a workspace the caller
// resolved from a signed token or an authenticated membership.
// eslint-disable-next-line no-restricted-imports -- reads for a caller-supplied workspace
import { unscopedPrisma } from '../db/unscoped.js';
import { settings as platformSettings } from './platform/settings.js';

/**
 * Discord webhook notifications — an optional second channel per workspace, kept
 * because a small team often lives in Discord and will notice a ping there long
 * before they open the inbox.
 *
 * Settings are PER WORKSPACE now. The env var remains only as a self-host
 * convenience default; in a multi-tenant deployment it must never be used, or one
 * customer's conversations would be announced in another's server.
 */

interface DiscordSettings {
  discord_webhook_url: string | null;
  discord_webhook_enabled: boolean;
  discord_notify_new_chat: boolean;
  discord_notify_new_message: boolean;
}

async function loadSettings(workspaceId: string): Promise<DiscordSettings | null> {
  return unscopedPrisma.workspace_private_settings.findUnique({
    where: { workspace_id: workspaceId },
    select: {
      discord_webhook_url: true,
      discord_webhook_enabled: true,
      discord_notify_new_chat: true,
      discord_notify_new_message: true,
    },
  });
}

/**
 * The workspace's own webhook, or the env fallback for a single-tenant self-host.
 * A workspace that has explicitly disabled the integration gets nothing, even if
 * the env var is set — an install-wide default must not override an explicit "off".
 */
function resolveWebhook(settings: DiscordSettings): string | null {
  if (!settings.discord_webhook_enabled) return null;
  return settings.discord_webhook_url || platformSettings().ops.discordWebhookUrl || null;
}

async function post(url: string, body: unknown): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
  } catch {
    // A third-party webhook must never break the conversation that triggered it.
  }
}

export async function notifyNewChat(workspaceId: string, conversationId: string): Promise<void> {
  const settings = await loadSettings(workspaceId);
  if (!settings || !settings.discord_notify_new_chat) return;
  const url = resolveWebhook(settings);
  if (!url) return;

  const conv = await unscopedPrisma.conversations.findFirst({
    where: { id: conversationId, workspace_id: workspaceId },
    select: {
      visitor_name: true,
      visitor_email: true,
      metadata: true,
      website: { select: { name: true } },
    },
  });
  if (!conv) return;

  const meta = (conv.metadata as Record<string, unknown> | null) ?? {};
  await post(url, {
    embeds: [
      {
        title: 'New conversation',
        color: 0x4f46e5,
        fields: [
          { name: 'Visitor', value: conv.visitor_name || conv.visitor_email || 'Anonymous', inline: true },
          { name: 'Website', value: conv.website.name, inline: true },
          ...(typeof meta.current_page === 'string'
            ? [{ name: 'Page', value: String(meta.current_page).slice(0, 200) }]
            : []),
        ],
        footer: { text: 'Nestled' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

export async function notifyNewMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  from: 'visitor' | 'agent',
): Promise<void> {
  const settings = await loadSettings(workspaceId);
  if (!settings || !settings.discord_notify_new_message) return;
  const url = resolveWebhook(settings);
  if (!url) return;

  await post(url, {
    embeds: [
      {
        title: from === 'visitor' ? 'New visitor message' : 'Agent reply',
        description: content.slice(0, 1500),
        color: from === 'visitor' ? 0x4f46e5 : 0x059669,
        footer: { text: 'Nestled' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
