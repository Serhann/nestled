import webpush from 'web-push';
// Push routing resolves the members of a workspace and their devices, which belong
// to users rather than to any one workspace.
// eslint-disable-next-line no-restricted-imports -- routes across members and their devices
import { unscopedPrisma } from '../db/unscoped.js';
import { membersViewing } from '../realtime/hub.js';
import { bump, recordPushFailure } from './platform/metrics.js';
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
/** The pair we could not load, so the failure is reported once rather than per send. */
let rejectedKey: { fingerprint: string; reason: string } | null = null;

/**
 * Identity of a key pair, for "is this the one we already loaded / already refused?".
 *
 * All three fields, not just the public key. Keying on the public key alone — which this
 * did at first, and a test caught — means correcting a mistyped PRIVATE key in the ops
 * panel changes nothing, because the memo still matches and the retry never happens. The
 * same bug applied to `configuredWith`: rotating only the private key or the subject
 * would not have taken effect.
 */
function fingerprint(subject: string, publicKey: string, privateKey: string): string {
  return `${subject}\n${publicKey}\n${privateKey}`;
}

/**
 * Hand the keys to web-push, or report that push is unavailable.
 *
 * `setVapidDetails` VALIDATES and THROWS — a private key that is not 32 bytes when
 * decoded raises synchronously. This function used to let that through, and because
 * every caller is invoked as `void pushSomething(…)`, the throw became an unhandled
 * rejection and Node terminated the process. A visitor sending their first message got a
 * 502, the widget said "something went wrong", and the cause was a mistyped key in the
 * ops panel. See lib/crashGuard.ts.
 *
 * So a bad key means exactly what a missing key means: no push. It is remembered so the
 * log gets one line rather than one per message, re-checked whenever the pair changes (so
 * fixing it in the panel takes effect with no restart), and reported to ops → Health as
 * MISCONFIGURED rather than as absent — those need different actions from an operator.
 */
function ensureConfigured(): boolean {
  const { publicKey, privateKey, subject } = settings().push;
  if (!publicKey || !privateKey) return false;

  const id = fingerprint(subject, publicKey, privateKey);
  if (rejectedKey?.fingerprint === id) return false;

  if (configuredWith !== id) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      configuredWith = id;
      rejectedKey = null;
    } catch (err) {
      rejectedKey = { fingerprint: id, reason: (err as Error).message };
      configuredWith = null;
      // eslint-disable-next-line no-console
      console.error(
        `[push] the configured VAPID key pair was refused, so push is off: ${rejectedKey.reason} ` +
          `Fix it in the ops panel under Settings → Web Push (\`npm run vapid\` prints a valid pair).`,
      );
      return false;
    }
  }
  return true;
}

/** Configured AND loadable. A pair that cannot be loaded is not enabled. */
export function isPushEnabled(): boolean {
  const { publicKey, privateKey } = settings().push;
  if (!publicKey || !privateKey) return false;
  return ensureConfigured();
}

/**
 * Why push is off, when it is off despite keys being present. For ops → Health: "not
 * configured" and "configured wrongly" are the same symptom and different jobs.
 */
export function pushKeyError(): string | null {
  const { publicKey, privateKey, subject } = settings().push;
  if (!publicKey || !privateKey) return null;
  ensureConfigured();
  const id = fingerprint(subject, publicKey, privateKey);
  return rejectedKey?.fingerprint === id ? rejectedKey.reason : null;
}

/**
 * Does this pair load? Used by the ops panel to refuse a bad key at the point somebody
 * pastes it, rather than storing a value that silently disables push.
 */
export function validateVapidPair(
  subject: string,
  publicKey: string,
  privateKey: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    // Validating replaced the live details with the candidate pair, so put the loaded
    // one back. Without this, a rejected save would leave the process holding keys it
    // never accepted.
    configuredWith = null;
    return { ok: true };
  } catch (err) {
    configuredWith = null;
    return { ok: false, reason: (err as Error).message };
  }
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

/**
 * Deep link into the right workspace's inbox. RELATIVE, because a push payload is resolved
 * by the service worker against its own origin.
 *
 * Exported so the offline email/SMS alerts point at the same place. They need it absolute —
 * an email cannot resolve a relative path — but the PATH must have one definition, or the
 * day the inbox route changes only one of the two notification channels follows.
 */
export function inboxPath(workspaceSlug: string, conversationId: string): string {
  return `/w/${workspaceSlug}/inbox/${conversationId}`;
}

/** Same, prefixed with the install's app URL, for anything read outside the browser. */
export async function absoluteInboxUrl(
  workspaceId: string,
  conversationId: string,
): Promise<string> {
  return `${settings().urls.app}${inboxPath(await slugOf(workspaceId), conversationId)}`;
}

async function slugOf(workspaceId: string): Promise<string> {
  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  return ws?.slug ?? '';
}

/**
 * Every exported notification below is called as `void push…(…)`, which makes each one a
 * promise nobody awaits. That is the right shape — whether an agent's phone buzzes is not
 * part of whether a visitor's message was accepted — but it carries an obligation: a
 * rejection from an unawaited promise terminates the process (Node ≥15). A malformed
 * VAPID key once did exactly that, mid-request, to every customer at once.
 *
 * So the fire-and-forget boundary is where failure stops. `contained` is that boundary,
 * applied at each entry point rather than trusted to every line inside them.
 */
async function contained(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    bump('push.error');
    // eslint-disable-next-line no-console
    console.error(`[push] ${what} failed`, err);
  }
}

export async function pushNewConversation(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  visitorName: string | null,
): Promise<void> {
  await contained('new-conversation notification', async () => {
    await pushToWorkspace(workspaceId, websiteId, {
      type: 'conversation',
      conversationId,
      title: 'New conversation',
      body: visitorName ? `${visitorName} started a chat` : 'A visitor started a chat',
      url: inboxPath(await slugOf(workspaceId), conversationId),
    });
  });
}

export async function pushVisitorMessage(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  visitorName: string | null,
  content: string,
): Promise<void> {
  await contained('visitor-message notification', async () => {
    await pushToWorkspace(workspaceId, websiteId, {
      type: 'message',
      conversationId,
      title: visitorName ?? 'Visitor',
      body: content.slice(0, 140),
      url: inboxPath(await slugOf(workspaceId), conversationId),
    });
  });
}

export async function pushHandoff(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  summary: string | null,
): Promise<void> {
  await contained('handoff notification', async () => {
    await pushToWorkspace(workspaceId, websiteId, {
      type: 'message',
      conversationId,
      title: 'Handoff requested',
      body: summary?.slice(0, 140) ?? 'A visitor needs a human.',
      url: inboxPath(await slugOf(workspaceId), conversationId),
    });
  });
}
