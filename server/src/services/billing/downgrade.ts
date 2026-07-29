// A downgrade assessment counts durable resources across one workspace and, on
// confirmation, deactivates the surplus. It runs both from a request and from the
// nightly job, so it takes a workspace id rather than a scoped client.
// eslint-disable-next-line no-restricted-imports -- runs from the job as well as from a request
import { unscopedPrisma } from '../../db/unscoped.js';
import { seatsInUse } from './seats.js';

/**
 * Downgrade validation.
 *
 * Plan CHANGES stay in the app rather than in Stripe's portal for exactly this
 * reason: by the time Stripe tells us the plan changed, the customer is already on
 * the cheaper plan and we are holding four websites that only one is paid for. The
 * only remaining options at that point are all bad — bill them anyway, or delete
 * something. Validating first means the customer chooses.
 *
 * Two rules govern what happens to the surplus:
 *
 *   NOTHING IS EVER DELETED. Websites, knowledge base entries, triggers and bot
 *   flows are deactivated. A downgrade is frequently a cash-flow decision that gets
 *   reversed in six weeks, and "we deleted your knowledge base" is not reversible.
 *
 *   PEOPLE ARE NOT DEACTIVATED AUTOMATICALLY. Silently suspending a colleague, and
 *   letting them find out when they cannot log in, is not a thing software should do
 *   on its own. Seat overage therefore blocks the downgrade even with `confirm`,
 *   and the response names the members so the customer picks.
 */

/** Deactivation order is newest-first: the oldest resources are the load-bearing ones. */
const NEWEST_FIRST = { created_at: 'desc' } as const;

export interface DowngradeItem {
  id: string;
  label: string;
}

export interface DowngradeBlocker {
  resource: 'seats' | 'websites' | 'kb_entries' | 'triggers' | 'bot_flows';
  used: number;
  limit: number;
  /** How many must go. */
  surplus: number;
  /** True when the customer must act; false when `confirm: true` handles it. */
  manual: boolean;
  /** The exact rows that would be deactivated, newest first. */
  items: DowngradeItem[];
}

export interface TargetLimits {
  max_seats: number;
  max_websites: number;
  max_kb_entries: number;
  max_triggers: number;
  max_bot_flows: number;
}

/**
 * What exceeds the target plan today.
 *
 * Metered flows (conversations, AI replies) are deliberately absent: they reset
 * next period and cannot be "reduced" by the customer, so listing them would be a
 * blocker nobody can clear.
 */
export async function assessDowngrade(
  workspaceId: string,
  target: TargetLimits,
): Promise<DowngradeBlocker[]> {
  const blockers: DowngradeBlocker[] = [];

  const seats = await seatsInUse(workspaceId);
  if (target.max_seats > 0 && seats > target.max_seats) {
    const members = await unscopedPrisma.workspace_members.findMany({
      where: { workspace_id: workspaceId, status: 'active' },
      orderBy: NEWEST_FIRST,
      select: { id: true, user: { select: { name: true, email: true } } },
    });
    blockers.push({
      resource: 'seats',
      used: seats,
      limit: target.max_seats,
      surplus: seats - target.max_seats,
      manual: true,
      items: members.map((m) => ({ id: m.id, label: m.user.name || m.user.email })),
    });
  }

  const websites = await unscopedPrisma.websites.findMany({
    where: { workspace_id: workspaceId, deleted_at: null, is_active: true },
    orderBy: NEWEST_FIRST,
    select: { id: true, name: true },
  });
  if (target.max_websites > 0 && websites.length > target.max_websites) {
    blockers.push({
      resource: 'websites',
      used: websites.length,
      limit: target.max_websites,
      surplus: websites.length - target.max_websites,
      manual: false,
      items: websites.slice(0, websites.length - target.max_websites).map((w) => ({
        id: w.id,
        label: w.name,
      })),
    });
  }

  const kb = await unscopedPrisma.knowledge_base.findMany({
    where: { workspace_id: workspaceId, is_active: true },
    orderBy: NEWEST_FIRST,
    select: { id: true, question: true },
  });
  if (target.max_kb_entries > 0 && kb.length > target.max_kb_entries) {
    blockers.push({
      resource: 'kb_entries',
      used: kb.length,
      limit: target.max_kb_entries,
      surplus: kb.length - target.max_kb_entries,
      manual: false,
      items: kb.slice(0, kb.length - target.max_kb_entries).map((k) => ({
        id: k.id,
        label: k.question,
      })),
    });
  }

  const triggers = await unscopedPrisma.triggers.findMany({
    where: { workspace_id: workspaceId, is_active: true },
    orderBy: NEWEST_FIRST,
    select: { id: true, name: true },
  });
  if (target.max_triggers > 0 && triggers.length > target.max_triggers) {
    blockers.push({
      resource: 'triggers',
      used: triggers.length,
      limit: target.max_triggers,
      surplus: triggers.length - target.max_triggers,
      manual: false,
      items: triggers.slice(0, triggers.length - target.max_triggers).map((t) => ({
        id: t.id,
        label: t.name,
      })),
    });
  }

  const flows = await unscopedPrisma.bot_flows.findMany({
    where: { workspace_id: workspaceId, is_active: true },
    orderBy: NEWEST_FIRST,
    select: { id: true, name: true },
  });
  // max_bot_flows of 0 is a real limit here, not "unlimited": the free plan sells no
  // bot at all, so an existing flow must be switched off rather than left running.
  if (flows.length > target.max_bot_flows) {
    blockers.push({
      resource: 'bot_flows',
      used: flows.length,
      limit: target.max_bot_flows,
      surplus: flows.length - target.max_bot_flows,
      manual: false,
      items: flows.slice(0, flows.length - target.max_bot_flows).map((f) => ({
        id: f.id,
        label: f.name,
      })),
    });
  }

  return blockers;
}

/** Blockers the customer has to clear themselves. A non-empty list means 409 stands. */
export function manualBlockers(blockers: DowngradeBlocker[]): DowngradeBlocker[] {
  return blockers.filter((b) => b.manual);
}

/**
 * Deactivate the surplus named by an assessment.
 *
 * Takes the assessment rather than recomputing it, so what the customer confirmed is
 * exactly what happens — recomputing here would let a race deactivate a resource the
 * 409 never mentioned.
 */
export async function applyDowngrade(
  workspaceId: string,
  blockers: DowngradeBlocker[],
): Promise<{ deactivated: Record<string, string[]> }> {
  const deactivated: Record<string, string[]> = {};

  for (const blocker of blockers) {
    if (blocker.manual) continue;
    const ids = blocker.items.map((i) => i.id);
    if (ids.length === 0) continue;

    // Every statement carries workspace_id as well as the id list. The ids came from
    // a scoped read a moment ago, but a deactivation that trusts an id alone is one
    // refactor away from being driven by a request body.
    const where = { workspace_id: workspaceId, id: { in: ids } };
    switch (blocker.resource) {
      case 'websites':
        await unscopedPrisma.websites.updateMany({ where, data: { is_active: false } });
        break;
      case 'kb_entries':
        await unscopedPrisma.knowledge_base.updateMany({ where, data: { is_active: false } });
        break;
      case 'triggers':
        await unscopedPrisma.triggers.updateMany({ where, data: { is_active: false } });
        break;
      case 'bot_flows':
        await unscopedPrisma.bot_flows.updateMany({ where, data: { is_active: false } });
        break;
      case 'seats':
        continue;
    }
    deactivated[blocker.resource] = ids;
  }

  return { deactivated };
}
