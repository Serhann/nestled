// Reads and writes the workspaces billing mirror, and runs from the nightly job as
// well as from a request. There is no scoped client in the job.
// eslint-disable-next-line no-restricted-imports -- billing mirror columns, workspace named explicitly
import { unscopedPrisma } from '../../db/unscoped.js';
import { stripeClient } from './stripe.js';

/**
 * The Stripe Customer.
 *
 * Trials are CARD-FREE: signup creates a `trialing` workspace with no Stripe
 * anything, because asking for a card before the product has proved itself is the
 * single largest drop-off in a self-serve funnel. The Customer is therefore created
 * lazily and out of band, which is what makes the rest of billing boring later —
 * the portal, dunning emails and tax location all need a Customer to exist, and
 * none of them are a good moment to discover it does not.
 */
export async function ensureStripeCustomer(workspaceId: string): Promise<string | null> {
  const ws = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      stripe_customer_id: true,
      members: {
        where: { role: 'owner', status: 'active' },
        orderBy: { created_at: 'asc' },
        take: 1,
        select: { user: { select: { email: true, name: true } } },
      },
    },
  });
  if (!ws) return null;
  if (ws.stripe_customer_id) return ws.stripe_customer_id;

  const stripe = stripeClient();
  if (!stripe) return null;

  const owner = ws.members[0]?.user;
  const customer = await stripe.customers.create({
    name: ws.name,
    ...(owner ? { email: owner.email } : {}),
    // The workspace id travels on the Customer so a webhook that arrives with
    // nothing but a customer id can still find its tenant.
    metadata: { workspace_id: ws.id, workspace_slug: ws.slug },
  });

  // Conditional write: two concurrent callers would otherwise each create a Customer
  // and the second would overwrite the first, leaving an invoice trail on an id we
  // no longer reference. The loser here abandons its Customer in Stripe — an empty,
  // unreferenced record, which is the cheap side of this trade.
  const { count } = await unscopedPrisma.workspaces.updateMany({
    where: { id: workspaceId, stripe_customer_id: null },
    data: { stripe_customer_id: customer.id },
  });
  if (count === 1) return customer.id;

  const fresh = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { stripe_customer_id: true },
  });
  return fresh?.stripe_customer_id ?? customer.id;
}

/**
 * Give every workspace that still lacks one a Stripe Customer.
 *
 * Run nightly. Doing it here rather than at signup keeps the signup path free of a
 * third-party call that can fail, be slow, or be entirely absent on a self-hosted
 * install.
 */
export async function backfillStripeCustomers(limit = 100): Promise<number> {
  if (!stripeClient()) return 0;
  const pending = await unscopedPrisma.workspaces.findMany({
    where: { stripe_customer_id: null, deleted_at: null },
    orderBy: { created_at: 'asc' },
    take: limit,
    select: { id: true },
  });
  let created = 0;
  for (const ws of pending) {
    try {
      if (await ensureStripeCustomer(ws.id)) created += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[billing] could not create a Stripe customer for workspace ${ws.id}`, err);
    }
  }
  return created;
}
