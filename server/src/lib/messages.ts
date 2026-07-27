// Message insertion is called from the visitor plane, the agent plane and the AI
// service, each of which already knows its workspace; taking a scoped client as an
// argument would force three different call shapes for one operation.
// eslint-disable-next-line no-restricted-imports -- writes for a caller-supplied workspace
import { unscopedPrisma } from '../db/unscoped.js';
import { Prisma } from '@prisma/client';
import { publishMessage, publishToWorkspace, rememberConversationOwner } from '../realtime/hub.js';
import { bumpUsage } from './usage.js';

export interface MessageRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai' | 'bot' | 'system';
  sender_member_id: string | null;
  metadata: Record<string, unknown>;
  external_id: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  created_at: Date;
}

/**
 * Insert a message and fan it out over realtime.
 *
 * Centralized so every writer — visitor route, agent route, AI service, bot
 * runtime — produces identical events, and so the tenant ids are always carried
 * onto the row. The `bump_conversation_on_message` trigger keeps `updated_at` and
 * `message_count` in sync, which is why neither is written here.
 */
export async function insertMessage(params: {
  workspaceId: string;
  websiteId: string;
  conversationId: string;
  content: string;
  senderType: MessageRow['sender_type'];
  senderMemberId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * The provider's id, for messages that came from outside.
   *
   * Passing one makes this insert IDEMPOTENT: a unique constraint covers
   * (workspace_id, external_id), and a collision returns null rather than throwing.
   * That is the contract inbound webhooks need — every provider redelivers, and a
   * redelivery must be a no-op that still answers 2xx, not a duplicate in the
   * customer's thread and not a 500 that makes the provider retry harder.
   */
  externalId?: string | null;
  deliveryStatus?: 'pending' | 'sent' | 'failed' | null;
}): Promise<MessageRow | null> {
  let row: MessageRow;
  try {
    row = (await unscopedPrisma.messages.create({
      data: {
        workspace_id: params.workspaceId,
        conversation_id: params.conversationId,
        content: params.content,
        sender_type: params.senderType,
        sender_member_id: params.senderMemberId ?? null,
        metadata: (params.metadata ?? {}) as object,
        external_id: params.externalId ?? null,
        delivery_status: params.deliveryStatus ?? null,
      },
      select: {
        id: true,
        workspace_id: true,
        conversation_id: true,
        content: true,
        sender_type: true,
        sender_member_id: true,
        metadata: true,
        external_id: true,
        delivery_status: true,
        delivery_error: true,
        created_at: true,
      },
    })) as unknown as MessageRow;
  } catch (err) {
    // The database, not a prior lookup, is what makes redelivery safe: two concurrent
    // deliveries of the same webhook both pass a findFirst and only one survives an
    // insert. Null means "already in the thread", which the caller reports as success.
    if (
      params.externalId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return null;
    }
    throw err;
  }

  if (row) {
    rememberConversationOwner(params.conversationId, params.workspaceId, params.websiteId);
    publishMessage(params.workspaceId, params.websiteId, params.conversationId, row);
    // Nudge this workspace's conversation list so ordering and the preview refresh.
    publishToWorkspace(
      params.workspaceId,
      { type: 'conversation:updated', conversation: { id: params.conversationId } },
      { websiteId: params.websiteId },
    );
    if (params.senderType === 'ai') void bumpUsage(params.workspaceId, 'ai_replies', 1);
  }
  return row;
}
