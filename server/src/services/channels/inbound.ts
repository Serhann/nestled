// Inbound arrives from an unauthenticated webhook, before any tenant is known —
// resolving which workspace it belongs to is this module's first job, so it cannot
// use a scoped client to do it.
// eslint-disable-next-line no-restricted-imports -- resolves the tenant; every write below passes workspace_id explicitly
import { unscopedPrisma } from '../../db/unscoped.js';
import { insertMessage } from '../../lib/messages.js';
import { publishToWorkspace, rememberConversationOwner } from '../../realtime/hub.js';
import { bumpUsage, checkUsageLimit } from '../../lib/usage.js';
import { resolveIdentity } from '../identity.js';
import { notifyNewMessage } from '../discord.js';
import { routeConversation } from '../routing.js';
import { maybeAIReply } from '../ai/reply.js';
import { onCustomerMessage } from '../responseTargets.js';
import type { InboundMessage } from './types.js';

/**
 * Taking a message in from a channel that is not the widget.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Four properties this function exists to guarantee. Each one is a way inbound
 * messaging goes wrong that the widget plane never had to think about:
 *
 * 1. **The tenant comes from OUR address, never from the sender.** An inbound email
 *    carries a From: header a stranger controls and a To: header they do not. The
 *    endpoint lookup on `toAddress` is the only thing that decides whose workspace
 *    this lands in, and the unique index behind it means that answer cannot be
 *    ambiguous.
 * 2. **Redelivery is expected, not exceptional.** Every provider here retries until
 *    it gets a 2xx, and will sometimes retry after one. `external_id` carries a
 *    unique constraint and a duplicate is a SUCCESS, not an error — a webhook that
 *    500s on a redelivery gets retried harder, and the customer's thread fills with
 *    the same message.
 * 3. **A message is never dropped for being over a plan limit.** Conversations are a
 *    soft limit and there is no "leave your email" fallback on a channel where they
 *    already emailed you. We take it and warn.
 * 4. **Failure is loud on our side and silent on theirs.** Nothing here writes an
 *    error back to the sender: an auto-reply to a spoofed From: makes us a spam
 *    relay, and mail loops are the classic version of this outage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type IngestOutcome =
  | { status: 'accepted'; conversationId: string; messageId: string }
  /** Already seen. The webhook must still be answered 2xx. */
  | { status: 'duplicate'; conversationId: string }
  /** No endpoint owns that address. Answered 2xx too — see the note below. */
  | { status: 'unrouted' }
  | { status: 'rejected'; reason: string };

/**
 * A synthetic visitor id for someone who has no browser.
 *
 * `visitor_id` is how the identity graph — persons, visitor_links, person_signals —
 * is keyed, and it is NOT NULL. Deriving a stable one from the channel and address
 * means an email correspondent and a widget visitor merge into the same person
 * exactly as two widget visitors do, with no new code in the identity service.
 * Lower-cased because addresses are case-insensitive in practice and two casings of
 * one address must not become two people.
 */
export function channelVisitorId(channel: string, address: string): string {
  return `${channel}:${address.trim().toLowerCase()}`;
}

export async function ingestInbound(msg: InboundMessage): Promise<IngestOutcome> {
  const to = msg.toAddress.trim().toLowerCase();
  const from = msg.fromAddress.trim();
  if (!to || !from || !msg.text.trim() || !msg.externalId) {
    return { status: 'rejected', reason: 'incomplete message' };
  }

  const endpoint = await unscopedPrisma.channel_endpoints.findFirst({
    where: { channel: msg.channel, address: { equals: to, mode: 'insensitive' }, is_active: true },
    select: { id: true, workspace_id: true, website_id: true },
  });
  // Unrouted is not an error to retry. A provider that receives a 4xx or 5xx here
  // keeps redelivering a message that will never have a home, and mail to a deleted
  // address is a completely ordinary event.
  if (!endpoint) return { status: 'unrouted' };

  const { workspace_id: workspaceId, website_id: websiteId } = endpoint;

  const workspace = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: {
      subscription_status: true,
      grace_until: true,
      deleted_at: true,
      plan: { select: { max_conversations_month: true } },
    },
  });
  if (!workspace || workspace.deleted_at) return { status: 'rejected', reason: 'workspace gone' };

  const visitorId = channelVisitorId(msg.channel, from);

  // An existing unresolved thread for this person on this channel, or a new one.
  // Resolved threads are left closed and a new one is opened: a reply three months
  // later to a settled conversation is a new question, and reopening buries it under
  // history the agent has to scroll past.
  let conversation = await unscopedPrisma.conversations.findFirst({
    where: {
      workspace_id: workspaceId,
      channel: msg.channel,
      channel_address: { equals: from, mode: 'insensitive' },
      status: { not: 'resolved' },
    },
    orderBy: { updated_at: 'desc' },
    select: { id: true, website_id: true, visitor_name: true, status: true },
  });

  let isNew = false;
  if (!conversation) {
    const over = await checkUsageLimit(
      workspaceId,
      'conversations',
      workspace.plan.max_conversations_month,
    );
    // Warned, not refused. See property 3 above: there is no fallback to offer
    // somebody who has already written to us.
    if (over) {
      // eslint-disable-next-line no-console
      console.warn(
        `[channels] workspace ${workspaceId} is over its conversation limit; accepting inbound ${msg.channel} anyway`,
      );
    }

    const created = await unscopedPrisma.$transaction(async (tx) => {
      const row = await tx.conversations.create({
        data: {
          workspace_id: workspaceId,
          website_id: websiteId,
          visitor_id: visitorId,
          visitor_name: msg.fromName?.trim() || null,
          // Only for email, where the channel address IS an email address. Writing a
          // phone number into visitor_email would break every "email the transcript"
          // path that trusts this column.
          visitor_email: msg.channel === 'email' ? from : null,
          // No visitor token: nothing on these channels can present one, and
          // tokenMatchesHash refuses a null hash for exactly this reason.
          visitor_token_hash: null,
          channel: msg.channel,
          channel_address: from,
          source: 'inbound',
          metadata: { ...(msg.hints ?? {}), channel: msg.channel } as object,
        },
        select: { id: true, website_id: true, visitor_name: true, status: true },
      });
      // Same transaction as the insert, so the metered number cannot drift from the
      // rows it counts.
      await bumpUsage(workspaceId, 'conversations', 1, tx);
      return row;
    });
    conversation = created;
    isNew = true;
  }

  const message = await insertMessage({
    workspaceId,
    websiteId: conversation.website_id,
    conversationId: conversation.id,
    content: msg.text,
    senderType: 'visitor',
    externalId: msg.externalId,
    metadata: { channel: msg.channel },
  });

  // insertMessage returns null for a unique-constraint collision on external_id,
  // which means this exact provider message is already in the thread. Property 2:
  // that is a success. Anything else would have the provider redeliver forever.
  if (!message) {
    return { status: 'duplicate', conversationId: conversation.id };
  }

  if (isNew) {
    rememberConversationOwner(conversation.id, workspaceId, conversation.website_id);
    publishToWorkspace(
      workspaceId,
      {
        type: 'conversation:new',
        conversation: {
          id: conversation.id,
          website_id: conversation.website_id,
          visitor_id: visitorId,
          visitor_name: conversation.visitor_name,
          created_at: new Date(),
        },
      },
      { websiteId: conversation.website_id },
    );
  } else if (conversation.status === 'pending') {
    await unscopedPrisma.conversations.updateMany({
      where: { id: conversation.id, workspace_id: workspaceId },
      data: { status: 'open' },
    });
  }

  await unscopedPrisma.channel_endpoints
    .update({ where: { id: endpoint.id }, data: { last_inbound_at: new Date() } })
    .catch(() => undefined);

  // The identity graph does not care that this person has no browser: a synthetic
  // visitor id and an email address are all resolveIdentity needs to merge them with
  // whoever already chatted from the widget.
  void resolveIdentity(workspaceId, visitorId, {
    fingerprint: null,
    email: msg.channel === 'email' ? from : null,
    websiteId: conversation.website_id,
  });

  // An email or a text is somebody waiting, exactly like a widget message.
  await onCustomerMessage({
    workspaceId,
    websiteId: conversation.website_id,
    conversationId: conversation.id,
  });

  void notifyNewMessage(workspaceId, conversation.id, msg.text, 'visitor');

  if (isNew) {
    // Awaited so the agent's first view of the conversation already names its
    // assignee, the same reasoning as the widget path.
    await routeConversation({
      workspaceId,
      websiteId: conversation.website_id,
      conversationId: conversation.id,
      // No page and no verified attributes: an email has no current page and nothing
      // in it is signed. Routing rules keyed on those simply will not match, which is
      // the correct outcome rather than a guess.
      page: null,
      countryCode: null,
      attributes: {},
    }).catch(() => undefined);
  }

  // No bot flows on these channels yet: flows are authored against a widget's
  // buttons and forms, and rendering a choice list into an SMS is a design decision
  // nobody has made. The plain assistant does work here, and says so in the thread.
  void maybeAIReply(workspaceId, conversation.website_id, conversation.id);

  return { status: 'accepted', conversationId: conversation.id, messageId: message.id };
}
