import webpush from 'web-push';
import { env } from '../env.js';
import { query, queryOne } from '../db/pool.js';
import { agentsViewing } from '../realtime/hub.js';

let configured = false;

/** Configure web-push with VAPID details once. No-op (disabled) if keys unset. */
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function isPushEnabled(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  type: 'conversation' | 'message';
  conversationId: string;
  title: string;
  body: string;
  // Deep link opened on notification click (relative to the admin origin).
  url: string;
}

interface SubscriptionRow {
  id: string;
  agent_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send a push to every subscribed agent, EXCEPT agents currently viewing this
 * conversation over WS (they can already see it). Subscriptions rejected by the
 * push service with 404/410 (gone) are pruned so we stop trying.
 */
export async function pushToAgents(payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const viewers = agentsViewing(payload.conversationId);
  // If the conversation is assigned, only its owner is pushed; otherwise the
  // whole team (the unassigned pool) is notified.
  const conv = await queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM conversations WHERE id = $1',
    [payload.conversationId],
  );
  const assignedTo = conv?.assigned_agent_id ?? null;

  const subs = await query<SubscriptionRow>(
    'SELECT id, agent_id, endpoint, p256dh, auth FROM push_subscriptions',
  );

  const body = JSON.stringify(payload);
  const stale: string[] = [];

  await Promise.all(
    subs.rows.map(async (sub) => {
      if (assignedTo && sub.agent_id !== assignedTo) return; // assigned elsewhere
      if (viewers.has(sub.agent_id)) return; // actively viewing — skip
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          stale.push(sub.id); // subscription is gone — prune it
        } else {
          // eslint-disable-next-line no-console
          console.error('[push] send failed', statusCode ?? err);
        }
      }
    }),
  );

  if (stale.length > 0) {
    await query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [stale]);
  }
}

/** Push for a brand-new conversation (no one is viewing it yet). */
export async function pushNewConversation(
  conversationId: string,
  visitorName: string | null,
  page: string | null,
): Promise<void> {
  const who = visitorName || 'A visitor';
  await pushToAgents({
    type: 'conversation',
    conversationId,
    title: 'New chat started',
    body: page ? `${who} on ${page}` : `${who} started a chat`,
    url: `/?conversation=${conversationId}`,
  });
}

/** Push for a new visitor message; suppressed for agents viewing it. */
export async function pushVisitorMessage(
  conversationId: string,
  visitorName: string | null,
  preview: string,
): Promise<void> {
  const who = visitorName || 'Visitor';
  const short = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
  await pushToAgents({
    type: 'message',
    conversationId,
    title: who,
    body: short,
    url: `/?conversation=${conversationId}`,
  });
}
