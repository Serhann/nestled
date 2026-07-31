// Settings, the conversation and its transcript are read for a workspace the caller
// resolved from a signed widget session or an authenticated membership.
// eslint-disable-next-line no-restricted-imports -- reads/writes for a caller-supplied workspace
import { unscopedPrisma } from '../../db/unscoped.js';
import { isWithinBusinessHours } from '../../lib/businessHours.js';
import { anyAgentOnline } from '../../realtime/hub.js';
import { absoluteInboxUrl } from '../push.js';
import { sendEmail } from '../email.js';
import { sendSms } from '../channels/sms.js';
import {
  assembleData,
  emailBody,
  hasSomethingToReport,
  isOffline,
  smsBody,
  type CollectedData,
} from './data.js';

export * from './data.js';

/**
 * "A visitor left their details and nobody was there."
 *
 * The gap: a bot flow collects a name, an email and a question at 02:00. The inbox says so,
 * and nobody has the inbox open; a web push says so, and most teams never granted the
 * permission. Email and SMS are the two channels that reach somebody who is not looking at
 * our app, and that is the whole feature.
 *
 * -- Three decisions worth knowing -------------------------------------------
 *
 * **Offline means either.** No agent connected OR outside business hours. They catch
 * different real cases -- a daytime gap where everyone stepped away, and 3am where the
 * schedule already says nobody is coming -- and a team that has to reason about which
 * definition applied to a given alert stops trusting the alerts.
 *
 * **One alert per conversation, claimed in the database.** Data arrives a field at a time,
 * so the naive version sends one message per field. The claim is a conditional UPDATE on
 * `offline_alert_at IS NULL`, which also settles the race between two fields collected in
 * the same instant -- a check-then-send would send twice.
 *
 * **Nothing here throws.** Every caller is a visitor's request finishing their form or
 * answering a bot. A Twilio outage must not fail the thing the visitor just did, and an
 * alert nobody receives is strictly better than a form that appears broken.
 */

interface AlertSettings {
  offline_alert_enabled: boolean;
  offline_alert_notify_agents: boolean;
  offline_alert_emails: string[];
  offline_alert_phones: string[];
}

/**
 * Alert the team that this visitor left details, if they asked to be alerted and nobody
 * was there to see it.
 *
 * Call this from anywhere a detail gets captured — a bot `collect` node, a pre-chat form, the
 * offline form. Calling it more often than necessary is safe and expected: the conversation
 * claim makes every call after the first a no-op.
 */
export async function maybeOfflineDataAlert(params: {
  workspaceId: string;
  websiteId: string;
  conversationId: string;
}): Promise<void> {
  const { workspaceId, websiteId, conversationId } = params;
  try {
    const config = (await unscopedPrisma.workspace_private_settings.findUnique({
      where: { workspace_id: workspaceId },
      select: {
        offline_alert_enabled: true,
        offline_alert_notify_agents: true,
        offline_alert_emails: true,
        offline_alert_phones: true,
      },
    })) as AlertSettings | null;
    if (!config?.offline_alert_enabled) return;

    const hours = await unscopedPrisma.website_business_hours.findUnique({
      where: { website_id: websiteId },
      select: { enabled: true, timezone: true, rules: true, holidays: true },
    });
    if (!isOffline(anyAgentOnline(workspaceId, websiteId), isWithinBusinessHours(hours))) return;

    const conv = await unscopedPrisma.conversations.findFirst({
      where: { id: conversationId, workspace_id: workspaceId },
      select: {
        visitor_name: true,
        visitor_email: true,
        custom_attributes: true,
        metadata: true,
        offline_alert_at: true,
        website: { select: { name: true } },
      },
    });
    if (!conv || conv.offline_alert_at) return;

    const metadata = (conv.metadata as Record<string, unknown> | null) ?? {};
    const handoff = (metadata.handoff ?? {}) as { summary?: string | null };
    const run = await unscopedPrisma.bot_flow_runs.findFirst({
      where: { workspace_id: workspaceId, conversation_id: conversationId },
      orderBy: { started_at: 'desc' },
      select: { state: true },
    });
    const runState = (run?.state as { collected?: Record<string, unknown> } | null) ?? null;
    const lastVisitor = await unscopedPrisma.messages.findFirst({
      where: { workspace_id: workspaceId, conversation_id: conversationId, sender_type: 'visitor' },
      orderBy: { created_at: 'desc' },
      select: { content: true },
    });

    const data = assembleData({
      visitorName: conv.visitor_name,
      visitorEmail: conv.visitor_email,
      collected: runState?.collected ?? {},
      prechat: (metadata.prechat ?? {}) as Record<string, unknown>,
      attributes: (conv.custom_attributes as Record<string, unknown> | null) ?? {},
      summary: handoff.summary ?? null,
      lastMessage: lastVisitor?.content?.slice(0, 500) ?? null,
    });
    // Nothing was actually collected — an empty alert trains people to ignore them, and the
    // claim is deliberately NOT taken so a later field can still produce the real one.
    if (!hasSomethingToReport(data)) return;

    // Claim it. The conditional write is what makes this once-per-conversation even when two
    // fields land in the same tick, and it is taken BEFORE sending: a duplicate SMS is worse
    // than a missed one, so the failure mode chosen here is "sent nothing" rather than "sent
    // twice".
    const claim = await unscopedPrisma.conversations.updateMany({
      where: { id: conversationId, workspace_id: workspaceId, offline_alert_at: null },
      data: { offline_alert_at: new Date() },
    });
    if (claim.count === 0) return;

    const websiteName = conv.website?.name ?? 'your website';
    const url = await absoluteInboxUrl(workspaceId, conversationId);

    await Promise.all([
      sendAlertEmails(workspaceId, websiteId, conversationId, config, data, websiteName, url),
      sendAlertTexts(workspaceId, websiteId, config, data, websiteName, url),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[offline-alert] failed', err);
  }
}

/**
 * Who gets the email.
 *
 * The agents, resolved exactly as `pushToWorkspace` resolves them — active members scoped
 * to this website — plus whatever extra addresses the customer listed. Deliberately the
 * same rule as push rather than a second one: a member removed from a website should stop
 * getting alerts about it, and two independent copies of that rule is how one of them ends
 * up wrong.
 *
 * `assigned_member_id` is NOT narrowed to here, unlike push. An alert fires because nobody
 * is online; the assignee being the one person notified is only correct when somebody is
 * around to be assigned to.
 */
async function sendAlertEmails(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  config: AlertSettings,
  data: CollectedData,
  websiteName: string,
  url: string,
): Promise<void> {
  const recipients = new Set(
    config.offline_alert_emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
  );

  if (config.offline_alert_notify_agents) {
    const members = await unscopedPrisma.workspace_members.findMany({
      where: {
        workspace_id: workspaceId,
        status: 'active',
        OR: [{ all_websites: true }, { websites: { some: { website_id: websiteId } } }],
      },
      select: { user: { select: { email: true, deleted_at: true } } },
    });
    for (const member of members) {
      if (member.user.deleted_at) continue;
      recipients.add(member.user.email.toLowerCase());
    }
  }
  if (recipients.size === 0) return;

  await Promise.all(
    [...recipients].map((to) =>
      sendEmail({
        to,
        template: 'offline_data_alert',
        vars: {
          websiteName,
          who: data.name ?? data.email ?? data.phone ?? 'A visitor',
          details: emailBody(data),
          url,
        },
        workspaceId,
        relatedType: 'conversation',
        relatedId: conversationId,
      }),
    ),
  );
}

/**
 * Who gets the text, and what it is sent FROM.
 *
 * The from-number is the website's own SMS endpoint — the Twilio number they already own
 * for SMS conversations. There is no platform-wide sender: `settings().sms` holds only the
 * account credentials, and inventing a number would either fail at Twilio or send from a
 * number the recipient cannot reply to. No SMS channel configured means no SMS alerts,
 * which the settings screen says out loud rather than failing silently at 3am.
 */
async function sendAlertTexts(
  workspaceId: string,
  websiteId: string,
  config: AlertSettings,
  data: CollectedData,
  websiteName: string,
  url: string,
): Promise<void> {
  const numbers = config.offline_alert_phones.map((p) => p.trim()).filter(Boolean);
  if (numbers.length === 0) return;

  const endpoint = await unscopedPrisma.channel_endpoints.findFirst({
    where: { workspace_id: workspaceId, website_id: websiteId, channel: 'sms', is_active: true },
    select: { address: true },
  });
  if (!endpoint?.address) return;

  const text = smsBody(data, websiteName, url);
  await Promise.all(
    numbers.map(async (to) => {
      const result = await sendSms({ from: endpoint.address, to, text });
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error('[offline-alert] sms failed', { to, error: result.error });
      }
    }),
  );
}
