import webpush from 'web-push';
// Push routing resolves the members of a workspace and their devices, which belong
// to users rather than to any one workspace.
// eslint-disable-next-line no-restricted-imports -- routes across members and their devices
import { unscopedPrisma } from '../db/unscoped.js';
import { membersViewing } from '../realtime/hub.js';
import { recordPushFailure } from './platform/metrics.js';
import { settings } from './platform/settings.js';

/**
 * Web Push to a workspace's agents.
 *
 * Two behaviours worth keeping from the original, both about not being annoying:
 *  - an agent whose socket is already VIEWING the conversation gets nothing; a
 *    notification for a message on screen in front of you is noise,
 *  - subscriptions the push service reports as gone (404/410) are pruned, so a
 *    replaced phone stops costing a failed send on every message forever.
 */

/**
 * The keys can now be changed from the ops panel, so the configured pair is
 * remembered rather than a boolean: rotating VAPID keys must take effect without
 * a restart, and `configured = true` would have pinned the old pair forever.
 */
let configuredWith: string | null = null;

function ensureConfigured(): boolean {
  const { publicKey, privateKey, subject } = settings().push;
  if (!publicKey || !privateKey) return false;
  if (configuredWith !== publicKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configuredWith = publicKey;
  }
  return true;
}

export function isPushEnabled(): boolean {
  const { publicKey, privateKey } = settings().push;
  return Boolean(publicKey && privateKey);
}

export interface PushPayload {
  type: 'conversation' | 'message';
  conversationId: string;
  title: string;
  body: string;
  /** Deep link opened on click. Workspace-aware, so it lands in the right inbox. */
  url: string;
}

async function pushToWorkspace(
  workspaceId: string,
  websiteId: string,
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) return;

  const conv = await unscopedPrisma.conversations.findFirst({
    where: { id: payload.conversationId, workspace_id: workspaceId },
    select: { assigned_member_id: true },
  });
  if (!conv) return;

  const viewing = membersViewing(workspaceId, payload.conversationId);

  // An assigned conversation notifies only its owner; an unassigned one notifies
  // the pool. Notifying everyone about an assigned chat trains people to ignore
  // notifications, which costs more than the occasional missed handoff.
  const members = await unscopedPrisma.workspace_members.findMany({
    where: {
      workspace_id: workspaceId,
      status: 'active',
      ...(conv.assigned_member_id ? { id: conv.assigned_member_id } : {}),
      // Respect per-website scoping: a member granted other websites must not be
      // notified about this one.
      OR: [{ all_websites: true }, { websites: { some: { website_id: websiteId } } }],
    },
    select: { id: true, user_id: true },
  });

  const recipients = members.filter((m) => !viewing.has(m.id)).map((m) => m.user_id);
  if (recipients.length === 0) return;

  const subs = await unscopedPrisma.push_subscriptions.findMany({
    where: { user_id: { in: recipients } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // Counted so the ops health page can tell "one dead phone" from "the push
        // service is down"; the send itself still fails silently, as before.
        recordPushFailure(status);
        if (status === 404 || status === 410) {
          await unscopedPrisma.push_subscriptions.delete({ where: { id: sub.id } }).catch(() => undefined);
        }
      }
    }),
  );
}

/** Deep link into the right workspace's inbox. */
function inboxUrl(workspaceSlug: string, conversationId: string): string {
  return `/w/${workspaceSlug}/inbox/${conversationId}`;
}

async function slugOf(workspaceId: string): Promise<string> {
  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  return ws?.slug ?? '';
}

export async function pushNewConversation(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  visitorName: string | null,
): Promise<void> {
  await pushToWorkspace(workspaceId, websiteId, {
    type: 'conversation',
    conversationId,
    title: 'New conversation',
    body: visitorName ? `${visitorName} started a chat` : 'A visitor started a chat',
    url: inboxUrl(await slugOf(workspaceId), conversationId),
  });
}

export async function pushVisitorMessage(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  visitorName: string | null,
  content: string,
): Promise<void> {
  await pushToWorkspace(workspaceId, websiteId, {
    type: 'message',
    conversationId,
    title: visitorName ?? 'Visitor',
    body: content.slice(0, 140),
    url: inboxUrl(await slugOf(workspaceId), conversationId),
  });
}

export async function pushHandoff(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  summary: string | null,
): Promise<void> {
  await pushToWorkspace(workspaceId, websiteId, {
    type: 'message',
    conversationId,
    title: 'Handoff requested',
    body: summary?.slice(0, 140) ?? 'A visitor needs a human.',
    url: inboxUrl(await slugOf(workspaceId), conversationId),
  });
}
