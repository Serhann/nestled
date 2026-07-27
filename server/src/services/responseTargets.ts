// The clock is set from the visitor plane, the channel plane and the agent plane,
// each of which already knows its workspace; and the sweep is cross-tenant by
// definition.
// eslint-disable-next-line no-restricted-imports -- writes for a caller-supplied workspace; the sweep spans workspaces
import { unscopedPrisma } from '../db/unscoped.js';
import { addBusinessMinutes, type BusinessHoursRow } from '../lib/businessHours.js';
import { publishToWorkspace } from '../realtime/hub.js';
import { notifyBreach } from './discord.js';

/**
 * Response-time targets: starting the clock, stopping it, and escalating a miss.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The product this implements is "nothing gets missed", not "here is a report".
 *
 * A weekly report telling a team that eleven conversations went unanswered is a
 * post-mortem. What a support manager actually needs is for the eleventh one to be
 * reassigned and announced while it can still be answered. So the deadline is stored
 * on the conversation, the inbox can sort by it, and a sweep escalates on breach.
 *
 * Three rules that keep it trustworthy — and trust is the whole feature, because a
 * team that stops believing the alerts is worse off than a team that never had them:
 *
 *   1. **The clock only runs in open hours** (unless the customer says otherwise).
 *      See lib/businessHours. A clock that runs overnight cries wolf every morning.
 *   2. **No target, no deadline.** A schedule that never opens, a website with
 *      targets switched off, a conversation nobody is waiting on: `response_due_at`
 *      is NULL and the row simply is not in the queue. Never an invented deadline.
 *   3. **A breach is stamped once and kept.** It survives the eventual reply, because
 *      a breach that vanishes when somebody finally answers is a breach nobody learns
 *      from. Escalation fires once, guarded by `escalated_at`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface TargetRow {
  enabled: boolean;
  first_response_minutes: number | null;
  next_response_minutes: number | null;
  business_hours_only: boolean;
  escalate_enabled: boolean;
  escalate_to_member_id: string | null;
  notify_owners: boolean;
}

/**
 * Start (or restart) the clock because the customer said something.
 *
 * Called from every path that inserts a visitor message — the widget, and inbound
 * email and SMS. Restarting rather than leaving an existing deadline alone is
 * deliberate: if they wrote at 09:00 and again at 09:30, the thing we owe them an
 * answer to is the second message, and holding the older deadline would report a
 * breach for a question that has been superseded.
 *
 * Except when the deadline has already been missed. Then the original stands, so
 * a customer sending three follow-ups cannot reset the clock they are chasing.
 */
export async function onCustomerMessage(params: {
  workspaceId: string;
  websiteId: string;
  conversationId: string;
  at?: Date;
}): Promise<void> {
  const at = params.at ?? new Date();
  try {
    const conv = await unscopedPrisma.conversations.findFirst({
      where: { id: params.conversationId, workspace_id: params.workspaceId },
      select: {
        first_response_at: true,
        response_due_at: true,
        response_breached_at: true,
        awaiting_reply_since: true,
      },
    });
    if (!conv) return;

    // Already late: keep the original deadline and the original start. A stream of
    // follow-ups must not push the deadline they are complaining about into the future.
    if (conv.response_breached_at) return;

    const target = await targetsFor(params.workspaceId, params.websiteId);
    if (!target?.enabled) {
      // Targets off. `awaiting_reply_since` is still recorded, because the report
      // measures response time whether or not a promise was made about it.
      await unscopedPrisma.conversations.updateMany({
        where: { id: params.conversationId, workspace_id: params.workspaceId },
        data: { awaiting_reply_since: conv.awaiting_reply_since ?? at, response_due_at: null },
      });
      return;
    }

    // First reply versus follow-up. `first_response_at` is the existing stamp for
    // "a human has answered in here at least once", so it is the right discriminator
    // and needs no new column.
    const minutes = conv.first_response_at
      ? target.next_response_minutes
      : target.first_response_minutes;

    const dueAt =
      minutes && minutes > 0
        ? await computeDue(params.workspaceId, params.websiteId, at, minutes, target)
        : null;

    await unscopedPrisma.conversations.updateMany({
      where: { id: params.conversationId, workspace_id: params.workspaceId },
      data: {
        awaiting_reply_since: at,
        response_due_at: dueAt,
        // A new question after an escalated one deserves a fresh escalation.
        escalated_at: null,
      },
    });

    if (dueAt) publishClock(params.workspaceId, params.websiteId, params.conversationId, dueAt);
  } catch (err) {
    // The clock must never break the message it is timing.
    // eslint-disable-next-line no-console
    console.error('[targets] failed to start the clock', err);
  }
}

/**
 * Stop the clock: a human answered, or the conversation was resolved.
 *
 * `response_breached_at` is deliberately NOT cleared. The deadline is gone, the queue
 * entry is gone, but the fact that it was missed stays on the row for the report.
 */
export async function onAgentReply(params: {
  workspaceId: string;
  conversationId: string;
}): Promise<void> {
  try {
    await unscopedPrisma.conversations.updateMany({
      where: { id: params.conversationId, workspace_id: params.workspaceId },
      data: {
        awaiting_reply_since: null,
        response_due_at: null,
        escalated_at: null,
        // Answering is also the moment it stops being unread, whoever marked it.
        unread_at: null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[targets] failed to stop the clock', err);
  }
}

async function targetsFor(workspaceId: string, websiteId: string): Promise<TargetRow | null> {
  return unscopedPrisma.website_response_targets.findFirst({
    where: { workspace_id: workspaceId, website_id: websiteId },
    select: {
      enabled: true,
      first_response_minutes: true,
      next_response_minutes: true,
      business_hours_only: true,
      escalate_enabled: true,
      escalate_to_member_id: true,
      notify_owners: true,
    },
  });
}

async function computeDue(
  workspaceId: string,
  websiteId: string,
  from: Date,
  minutes: number,
  target: TargetRow,
): Promise<Date | null> {
  if (!target.business_hours_only) return new Date(from.getTime() + minutes * 60_000);
  const hours = await unscopedPrisma.website_business_hours.findFirst({
    where: { workspace_id: workspaceId, website_id: websiteId },
    select: { enabled: true, timezone: true, rules: true, holidays: true },
  });
  // No hours row means no schedule to pause for, which addBusinessMinutes treats as
  // always open — the same convention the widget uses.
  return addBusinessMinutes(from, minutes, hours as BusinessHoursRow | null);
}

function publishClock(
  workspaceId: string,
  websiteId: string,
  conversationId: string,
  dueAt: Date | null,
): void {
  publishToWorkspace(
    workspaceId,
    { type: 'conversation:updated', conversation: { id: conversationId, response_due_at: dueAt } },
    { websiteId },
  );
}

// ── The sweep ───────────────────────────────────────────────────────────────

/** How many breaches one pass will handle. A bound, so a backlog cannot stall the loop. */
const SWEEP_LIMIT = 200;

/**
 * Find missed deadlines, stamp them, and escalate.
 *
 * Returns the number escalated, so the ops health view can show that this is alive —
 * a silently dead sweep is invisible until a customer asks why nobody was told.
 */
export async function sweepResponseTargets(now = new Date()): Promise<number> {
  const due = await unscopedPrisma.conversations.findMany({
    where: {
      response_due_at: { lte: now },
      escalated_at: null,
      status: { not: 'resolved' },
    },
    orderBy: { response_due_at: 'asc' },
    take: SWEEP_LIMIT,
    select: {
      id: true,
      workspace_id: true,
      website_id: true,
      visitor_name: true,
      assigned_member_id: true,
      response_due_at: true,
      response_breached_at: true,
    },
  });

  let escalated = 0;
  for (const conv of due) {
    try {
      const target = await targetsFor(conv.workspace_id, conv.website_id);

      await unscopedPrisma.conversations.updateMany({
        where: { id: conv.id, workspace_id: conv.workspace_id },
        data: {
          // Stamped once. A conversation breached last week that is still open should
          // not have its breach time rewritten to today.
          response_breached_at: conv.response_breached_at ?? conv.response_due_at ?? now,
          escalated_at: now,
          // Unread, so it cannot quietly sit at the bottom of a list sorted by recency.
          unread_at: now,
        },
      });

      // Reassignment is what actually gets it answered. A notification on its own is
      // one more thing to miss, which is the complaint this feature exists to answer.
      if (
        target?.escalate_enabled &&
        target.escalate_to_member_id &&
        target.escalate_to_member_id !== conv.assigned_member_id
      ) {
        await unscopedPrisma.conversations.updateMany({
          where: { id: conv.id, workspace_id: conv.workspace_id },
          data: { assigned_member_id: target.escalate_to_member_id },
        });
      }

      publishToWorkspace(
        conv.workspace_id,
        {
          type: 'conversation:breached',
          conversationId: conv.id,
          dueAt: conv.response_due_at,
        },
        { websiteId: conv.website_id },
      );

      if (target?.notify_owners !== false) {
        void notifyBreach(conv.workspace_id, conv.id, conv.visitor_name, conv.response_due_at);
      }
      escalated += 1;
    } catch (err) {
      // One bad row must not stop the rest of the sweep.
      // eslint-disable-next-line no-console
      console.error(`[targets] escalation failed for ${conv.id}`, err);
    }
  }
  return escalated;
}

let timer: NodeJS.Timeout | null = null;
/** Last run, for the ops health view. */
export let lastSweepAt: Date | null = null;
export let lastSweepEscalated = 0;

/**
 * Run the sweep every minute.
 *
 * A minute is the resolution of the promise: a target of "within 30 minutes" that
 * alerts up to 60 seconds late is fine, and a tighter loop buys nothing an agent
 * could act on.
 */
export function startResponseTargetSweep(intervalMs = 60_000): void {
  if (timer) return;
  const run = async (): Promise<void> => {
    try {
      lastSweepEscalated = await sweepResponseTargets();
      lastSweepAt = new Date();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[targets] sweep failed', err);
    }
  };
  timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
}

export function stopResponseTargetSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
