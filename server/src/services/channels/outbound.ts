// Delivery is driven from the agent route, which already knows its workspace; the
// endpoint and conversation reads below all pass workspace_id explicitly.
// eslint-disable-next-line no-restricted-imports -- writes delivery status for a caller-supplied workspace
import { unscopedPrisma } from '../../db/unscoped.js';
import { publishDelivery } from '../../realtime/hub.js';
import { sendChannelEmail } from '../email.js';
import { sendSms } from './sms.js';
import type { DeliveryResult } from './types.js';

/**
 * Getting an agent's reply out onto whatever channel the conversation is on.
 *
 * The widget never needed this: publishing to a socket IS delivery, and if the
 * visitor's tab is closed the message waits in the thread for them. Every other
 * channel can fail after the agent has pressed send — a bounced address, a landline,
 * an expired credential — and the difference matters more than it sounds.
 *
 * So delivery is recorded ON THE MESSAGE. `delivery_status` is set to `pending` when
 * the row is written and resolved to `sent` or `failed` here, and the inbox shows it.
 * An agent who is not told their reply bounced is an agent who believes they answered,
 * and the customer is waiting for a message that does not exist.
 *
 * Deliberately NOT queued or retried in v1. A retry needs an idempotency key the
 * provider will honour and a place to hold the backlog, and getting that half right
 * means sending a customer the same reply twice. A visible failure the agent can act
 * on beats an invisible retry that might duplicate.
 */

export async function deliverReply(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  content: string;
}): Promise<DeliveryResult> {
  const conv = await unscopedPrisma.conversations.findFirst({
    where: { id: params.conversationId, workspace_id: params.workspaceId },
    select: { channel: true, channel_address: true, website_id: true, visitor_name: true },
  });
  if (!conv) return { ok: false, error: 'Conversation not found', retryable: false };

  // The widget delivers over the socket, which insertMessage already did. Returning
  // ok here rather than branching at every call site keeps one code path.
  if (conv.channel === 'widget') return { ok: true };

  if (!conv.channel_address) {
    return { ok: false, error: 'This conversation has no address to reply to', retryable: false };
  }

  const endpoint = await unscopedPrisma.channel_endpoints.findFirst({
    where: {
      workspace_id: params.workspaceId,
      website_id: conv.website_id,
      channel: conv.channel,
      is_active: true,
    },
    select: { address: true, label: true },
  });
  if (!endpoint) {
    // The endpoint was removed or deactivated after the conversation started. Naming
    // that precisely is the difference between an agent fixing it in settings and an
    // agent filing a bug.
    return {
      ok: false,
      error: `No active ${conv.channel} address is configured for this inbox any more`,
      retryable: false,
    };
  }

  const result = await send(conv.channel, {
    from: endpoint.address,
    // The inbox's label, deliberately NOT the individual agent's name. The customer
    // is talking to a business, and pushing staff names out to strangers is a
    // decision a customer should make rather than one we make for them.
    fromName: endpoint.label,
    to: conv.channel_address,
    text: params.content,
    subject: subjectFor(conv.visitor_name),
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });

  await unscopedPrisma.messages
    .updateMany({
      where: { id: params.messageId, workspace_id: params.workspaceId },
      data: result.ok
        ? { delivery_status: 'sent', delivery_error: null, external_id: result.externalId ?? null }
        : { delivery_status: 'failed', delivery_error: result.error.slice(0, 500) },
    })
    .catch(() => undefined);

  // Announced, not just stored. The row was published as `pending` before this
  // function ran, so without this frame the socket echo and the HTTP response race —
  // and when the socket wins, the agent watches "sending…" on a reply that already
  // bounced. Found by sending one and looking at the screen.
  publishDelivery(
    params.workspaceId,
    conv.website_id,
    params.conversationId,
    params.messageId,
    result.ok ? 'sent' : 'failed',
    result.ok ? null : result.error,
  );

  return result;
}

async function send(
  channel: string,
  args: {
    from: string;
    fromName: string | null;
    to: string;
    text: string;
    subject: string;
    workspaceId: string;
    conversationId: string;
  },
): Promise<DeliveryResult> {
  switch (channel) {
    case 'email': {
      const res = await sendChannelEmail({
        from: args.from,
        fromName: args.fromName,
        to: args.to,
        subject: args.subject,
        text: args.text,
        inReplyTo: await lastInboundMessageId(args.workspaceId, args.conversationId),
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
      });
      return res.ok
        ? { ok: true, externalId: res.messageId }
        : { ok: false, error: res.error, retryable: true };
    }
    case 'sms':
      return sendSms({ from: args.from, to: args.to, text: args.text });
    default:
      // whatsapp and instagram are in the schema and not yet implemented. Saying so
      // is better than a generic failure that reads like a bug.
      return {
        ok: false,
        error: `Replying on ${channel} is not supported yet`,
        retryable: false,
      };
  }
}

/**
 * The provider id of the last message that came IN, for email threading.
 *
 * Threading off the most recent inbound rather than the first is what keeps a long
 * exchange in one thread in the customer's client — replying to the original message
 * of a twenty-message conversation is how a client decides to start a new one.
 */
async function lastInboundMessageId(
  workspaceId: string,
  conversationId: string,
): Promise<string | null> {
  const row = await unscopedPrisma.messages.findFirst({
    where: {
      workspace_id: workspaceId,
      conversation_id: conversationId,
      sender_type: 'visitor',
      external_id: { not: null },
    },
    orderBy: { created_at: 'desc' },
    select: { external_id: true },
  });
  return row?.external_id ?? null;
}

/**
 * A stable subject line.
 *
 * Stable is the requirement, not clever: mail clients group on subject as well as on
 * References, so a subject that changes per message scatters one conversation across
 * a customer's inbox.
 */
function subjectFor(visitorName: string | null): string {
  return visitorName ? `Re: your message (${visitorName})` : 'Re: your message';
}
