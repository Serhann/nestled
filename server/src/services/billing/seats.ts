// Seats span members and pending invites for one workspace, and are pushed to a
// subscription row that db/tenant.ts deliberately leaves unscoped (see
// INTENTIONALLY_UNSCOPED). Every query below names its workspace_id explicitly.
// eslint-disable-next-line no-restricted-imports -- billing writes subscriptions, which are not tenant-scoped
import { unscopedPrisma } from '../../db/unscoped.js';
import { stripeClient } from './stripe.js';

/**
 * Seat accounting.
 *
 * A seat is an active member OR an outstanding invite. Counting only members would
 * let a workspace on a 3-seat plan invite thirty people at once and be within its
 * limit the whole time — the plan is exceeded the moment they accept, which is the
 * moment it is too late to say no politely.
 */
export async function seatsInUse(workspaceId: string): Promise<number> {
  const [members, pending] = await Promise.all([
    unscopedPrisma.workspace_members.count({
      where: { workspace_id: workspaceId, status: 'active' },
    }),
    unscopedPrisma.invites.count({
      where: {
        workspace_id: workspaceId,
        accepted_at: null,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    }),
  ]);
  return members + pending;
}

/**
 * Recount seats and push the number to Stripe.
 *
 * Called from every membership change. It is deliberately AWAITED at those call
 * sites rather than fired and forgotten: a lost seat sync is an invoice that
 * silently disagrees with reality, and the customer only finds out on the bill —
 * the single worst moment to discover a billing bug. Team changes are rare enough
 * that the round trip does not matter.
 *
 * Everything inside is best-effort against Stripe. If Stripe is down or
 * unconfigured, the local `subscriptions.quantity` is still corrected, so the
 * nightly reconciliation has something true to push later.
 */
export async function syncSeats(workspaceId: string): Promise<number> {
  const seats = await seatsInUse(workspaceId);

  const sub = await unscopedPrisma.subscriptions.findUnique({
    where: { workspace_id: workspaceId },
    select: { id: true, quantity: true, stripe_subscription_id: true, stripe_item_id: true, status: true },
  });
  // No subscription is the normal state for a trialing or free workspace — trials
  // are card-free by design, so there is nothing to bill for.
  if (!sub || sub.quantity === seats) return seats;

  await unscopedPrisma.subscriptions.update({ where: { id: sub.id }, data: { quantity: seats } });

  const stripe = stripeClient();
  // A cancelled subscription must not be poked: Stripe rejects the update and,
  // if it did not, we would be re-pricing something the customer already left.
  if (!stripe || !sub.stripe_item_id || sub.status === 'canceled') return seats;

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: sub.stripe_item_id, quantity: seats }],
      // Seats are prorated: adding a teammate mid-month should cost the part of the
      // month they are actually there for, which is also what the customer expects.
      proration_behavior: 'create_prorations',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[billing] seat sync to Stripe failed for workspace ${workspaceId}`, err);
  }
  return seats;
}
