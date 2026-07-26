// The AI path reads website settings, the knowledge base and conversation history
// for a workspace resolved from a signed widget session.
// eslint-disable-next-line no-restricted-imports -- reads for a caller-supplied workspace
import { unscopedPrisma } from '../../db/unscoped.js';
import { insertMessage } from '../../lib/messages.js';
import { anyAgentOnline, publishToWorkspace } from '../../realtime/hub.js';
import { pushHandoff } from '../push.js';
import { bumpUsage, checkUsageLimit } from '../../lib/usage.js';
import { generateAIReply, summarizeConversation } from './index.js';

/**
 * Decide whether the AI should answer this visitor message, then post it.
 *
 * Reply modes (per website):
 *   off                  — never
 *   first_message        — a greeting only, until ai_greeted
 *   when_no_agent_online — full answers while nobody is connected; the moment an
 *                          agent is online the AI goes quiet and the human takes over
 *   always               — every message
 *
 * The AI also steps aside permanently once a conversation is handed off, assigned,
 * or an agent has replied — talking over an agent mid-conversation is worse than
 * not answering at all.
 *
 * Never throws into the request path: a provider outage must not fail the
 * visitor's message.
 */
export async function maybeAIReply(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
): Promise<void> {
  try {
    const settings = await unscopedPrisma.website_settings.findUnique({
      where: { website_id: websiteId },
      select: { ai_enabled: true, ai_response_mode: true },
    });
    if (!settings?.ai_enabled || settings.ai_response_mode === 'off') return;

    const conv = await unscopedPrisma.conversations.findFirst({
      where: { id: conversationId, workspace_id: workspaceId },
      select: { ai_greeted: true, needs_human: true, assigned_member_id: true },
    });
    if (!conv || conv.needs_human || conv.assigned_member_id) return;

    const agentReplied = await unscopedPrisma.messages.findFirst({
      where: { conversation_id: conversationId, sender_type: 'agent' },
      select: { id: true },
    });
    if (agentReplied) return;
    if (settings.ai_response_mode === 'first_message' && conv.ai_greeted) return;
    // Scoped per workspace AND website: a global check would keep one customer's AI
    // silent because a different customer had an agent online.
    if (settings.ai_response_mode === 'when_no_agent_online' && anyAgentOnline(workspaceId, websiteId)) return;

    // AI replies are a HARD limit — each one has a real per-call cost. Past the
    // quota, degrade to a handoff rather than either silence or an unbounded bill.
    const plan = await unscopedPrisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { plan: { select: { max_ai_replies_month: true } } },
    });
    if (plan) {
      const over = await checkUsageLimit(workspaceId, 'ai_replies', plan.plan.max_ai_replies_month);
      if (over) {
        await flagHandoff(workspaceId, websiteId, conversationId, 'AI reply quota reached');
        return;
      }
    }

    const last = await unscopedPrisma.messages.findFirst({
      where: { conversation_id: conversationId, sender_type: 'visitor' },
      orderBy: { created_at: 'desc' },
      select: { content: true },
    });
    if (!last) return;

    const result = await generateAIReply(workspaceId, websiteId, last.content, conversationId);
    if (!result) return; // provider error / timeout / empty → post nothing

    await insertMessage({
      workspaceId,
      websiteId,
      conversationId,
      content: result.reply,
      senderType: 'ai',
    });
    if (settings.ai_response_mode === 'first_message') {
      await unscopedPrisma.conversations.updateMany({
        where: { id: conversationId, workspace_id: workspaceId },
        data: { ai_greeted: true },
      });
    }

    if (result.needsHuman) {
      const summary = await summarizeConversation(workspaceId, conversationId);
      await flagHandoff(workspaceId, websiteId, conversationId, 'AI handed off', summary, last.content);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ai] reply failed', err);
  }
}

/**
 * Flag a conversation for a human and notify the team. Stamps a summary onto the
 * metadata so the agent picking it up sees what the visitor wants without reading
 * the whole thread.
 */
async function flagHandoff(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  reason: string,
  summary?: string | null,
  request?: string,
): Promise<void> {
  const existing = await unscopedPrisma.conversations.findFirst({
    where: { id: conversationId, workspace_id: workspaceId },
    select: { metadata: true },
  });
  const prev = (existing?.metadata as Record<string, unknown> | null) ?? {};
  const updated = await unscopedPrisma.conversations.update({
    where: { id: conversationId },
    data: {
      needs_human: true,
      status: 'open',
      metadata: {
        ...prev,
        handoff: {
          by: 'ai',
          reason,
          summary: summary ?? undefined,
          request,
          at: new Date().toISOString(),
        },
      } as object,
    },
    select: { id: true, needs_human: true, status: true },
  });
  publishToWorkspace(workspaceId, { type: 'conversation:updated', conversation: updated }, { websiteId });
  void pushHandoff(workspaceId, websiteId, conversationId, summary ?? null);
  void bumpUsage(workspaceId, 'ai_replies', 0);
}
