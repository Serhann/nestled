import { env } from '../env.js';
import { queryOne } from '../db/pool.js';

interface DiscordSettings {
  discord_webhook_url: string | null;
  discord_webhook_enabled: boolean;
  discord_notify_new_chat: boolean;
  discord_notify_new_message: boolean;
}

interface ConversationRow {
  visitor_name: string | null;
  visitor_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

async function loadSettings(): Promise<DiscordSettings | null> {
  return queryOne<DiscordSettings>(
    `SELECT discord_webhook_url, discord_webhook_enabled, discord_notify_new_chat, discord_notify_new_message
       FROM private_settings WHERE id = 1`,
  );
}

/** Webhook URL comes from private_settings, falling back to the server .env. */
function resolveWebhook(settings: DiscordSettings): string | null {
  return settings.discord_webhook_url || env.DISCORD_WEBHOOK_URL || null;
}

async function post(url: string, embed: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[discord] webhook error', res.status, await res.text());
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[discord] webhook failed', err);
  }
}

export async function notifyNewChat(conversationId: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings || !settings.discord_webhook_enabled || !settings.discord_notify_new_chat) return;
  const url = resolveWebhook(settings);
  if (!url) return;

  const conv = await queryOne<ConversationRow>(
    `SELECT visitor_name, visitor_email, metadata, created_at FROM conversations WHERE id = $1`,
    [conversationId],
  );
  if (!conv) return;

  const location = (conv.metadata?.location ?? null) as { city?: string; country?: string } | null;
  const currentPage = (conv.metadata?.current_page as string) ?? 'Unknown';

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Visitor', value: conv.visitor_name || 'Anonymous', inline: true },
    { name: 'Email', value: conv.visitor_email || 'Not provided', inline: true },
    { name: 'Current Page', value: currentPage, inline: false },
  ];
  if (location) {
    fields.push({
      name: 'Location',
      value: `${location.city || 'Unknown'}, ${location.country || 'Unknown'}`,
      inline: true,
    });
  }

  await post(url, {
    title: '🆕 New Chat Started',
    color: 3447003,
    fields,
    timestamp: conv.created_at,
    footer: { text: 'JetChat' },
  });
}

export async function notifyNewMessage(
  conversationId: string,
  content: string,
  senderType: 'visitor' | 'agent' | 'ai',
): Promise<void> {
  if (senderType !== 'visitor') return; // only visitor messages notify
  const settings = await loadSettings();
  if (!settings || !settings.discord_webhook_enabled || !settings.discord_notify_new_message) return;
  const url = resolveWebhook(settings);
  if (!url) return;

  const conv = await queryOne<ConversationRow>(
    `SELECT visitor_name, visitor_email, metadata, created_at FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const visitorName = conv?.visitor_name || 'Anonymous';
  const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;

  await post(url, {
    title: '💬 New Message',
    description: preview,
    color: 15844367,
    fields: [{ name: 'From', value: visitorName, inline: true }],
    footer: { text: 'JetChat' },
  });
}
