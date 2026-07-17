import { queryOne } from '../db/pool.js';
import { publishMessage, broadcastToAgents } from '../realtime/hub.js';

export interface MessageRow {
  id: string;
  conversation_id: string;
  content: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  sender_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
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
  const row = await queryOne<MessageRow>(
    `INSERT INTO messages (conversation_id, content, sender_type, sender_id, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, conversation_id, content, sender_type, sender_id, metadata, created_at`,
    [
      params.conversationId,
      params.content,
      params.senderType,
      params.senderId ?? null,
      params.metadata ?? {},
    ],
  );
  if (row) {
    publishMessage(params.conversationId, row);
    // Nudge the agent conversation list so ordering/preview refreshes.
    broadcastToAgents({ type: 'conversation:updated', conversation: { id: params.conversationId } });
  }
  return row;
}
