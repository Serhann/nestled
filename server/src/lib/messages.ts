import { prisma } from '../db/prisma.js';
import { publishMessage, broadcastToAgents } from '../realtime/hub.js';

export interface MessageRow {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  sender_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Insert a message and fan it out over realtime. Centralized so every writer
 * (visitor route, agent route, AI service) produces identical events. The
 * bump-conversation trigger keeps updated_at / message_count in sync.
 */
export async function insertMessage(params: {
  conversationId: string;
  content: string;
  senderType: 'visitor' | 'agent' | 'ai';
  senderId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<MessageRow | null> {
  const row = (await prisma.messages.create({
    data: {
      conversation_id: params.conversationId,
      content: params.content,
      sender_type: params.senderType,
      sender_id: params.senderId ?? null,
      metadata: (params.metadata ?? {}) as object,
    },
    select: {
      id: true,
      conversation_id: true,
      content: true,
      sender_type: true,
      sender_id: true,
      metadata: true,
      created_at: true,
    },
  })) as unknown as MessageRow;

  if (row) {
    publishMessage(params.conversationId, row);
    // Nudge the agent conversation list so ordering/preview refreshes.
    broadcastToAgents({ type: 'conversation:updated', conversation: { id: params.conversationId } });
  }
  return row;
}
