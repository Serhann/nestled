import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { USAGE_METRICS, periodStart } from '../../lib/limits.js';
import { invalidateWorkspaceCache } from '../../plugins/auth.js';
import { platformRead, platformWrite } from './guards.js';

/**
 * Workspace list and detail — the panel's spine.
 *
 * The detail is split into one endpoint per tab rather than one fat payload. A
 * support agent opening a customer almost always wants the overview and nothing
 * else; loading their conversations and audit history to satisfy that is a
 * cross-tenant read nobody asked for, and on the vendor plane an unnecessary read
 * of customer data is not merely slow, it is a thing that appears in an audit.
 *
 * Note what is NOT here: the live-visitor board and session replay. Watching a
 * visitor's screen requires going through impersonation with a recorded reason, on
 * the tenant surface. That is a privacy line, not an omission — a convenience
 * shortcut around it would quietly delete the record that makes the capability
 * defensible to the customer whose visitors are being watched.
 */

const listQuery = z.object({
  q: z.string().max(200).optional(),
  status: z
    .enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'trial_expired', 'suspended'])
    .optional(),
  plan: z.string().max(60).optional(),
  /** Soft-deleted workspaces are hidden unless asked for — they are still billable history. */
  include_deleted: z.coerce.boolean().default(false),
  sort: z.enum(['created', 'name', 'activity']).default('created'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

/** Staff notes about a workspace. See the notes routes at the bottom for why. */
const NOTE_ACTION = 'platform.note';

export async function platformWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/workspaces', { preHandler: platformRead }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.issues });
    }
    const { q, status, plan, include_deleted, sort, page, per_page } = parsed.data;

    const where = {
      ...(include_deleted ? {} : { deleted_at: null }),
      ...(status ? { subscription_status: status } : {}),
      ...(plan ? { plan: { code: plan } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { slug: { contains: q, mode: 'insensitive' as const } },
              // Reaching a workspace by a member's address is the single most
              // common list search: the ticket names a person, not a company.
              { members: { some: { user: { email: { contains: q, mode: 'insensitive' as const } } } } },
              { websites: { some: { primary_domain: { contains: q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      unscopedPrisma.workspaces.count({ where }),
      unscopedPrisma.workspaces.findMany({
        where,
        orderBy:
          sort === 'name'
            ? { name: 'asc' }
            : sort === 'activity'
              ? { updated_at: 'desc' }
              : { created_at: 'desc' },
        skip: (page - 1) * per_page,
        take: per_page,
        select: {
          id: true,
          name: true,
          slug: true,
          subscription_status: true,
          trial_ends_at: true,
          grace_until: true,
          deleted_at: true,
          created_at: true,
          plan: { select: { code: true, name: true } },
          _count: { select: { members: true, websites: true, conversations: true } },
        },
      }),
    ]);

    return reply.send({
      workspaces: rows,
      page,
      per_page,
      total,
      total_pages: Math.max(1, Math.ceil(total / per_page)),
    });
  });

  // ── Detail: overview ───────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = await unscopedPrisma.workspaces.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        subscription_status: true,
        trial_ends_at: true,
        grace_until: true,
        purge_after: true,
        deleted_at: true,
        stripe_customer_id: true,
        created_at: true,
        updated_at: true,
        plan: true,
        subscription: {
          select: {
            status: true,
            interval: true,
            quantity: true,
            current_period_end: true,
            cancel_at_period_end: true,
            canceled_at: true,
          },
        },
        _count: { select: { members: true, websites: true, conversations: true, invites: true } },
      },
    });
    if (!ws) return reply.code(404).send({ error: 'Not found' });

    // The owner is who support should be talking to, so it is on the overview
    // rather than one tab away.
    const owners = await unscopedPrisma.workspace_members.findMany({
      where: { workspace_id: id, role: 'owner', status: 'active' },
      select: { user: { select: { id: true, name: true, email: true, last_login_at: true } } },
    });

    const lastConversation = await unscopedPrisma.conversations.findFirst({
      where: { workspace_id: id },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });

    return reply.send({
      workspace: ws,
      owners: owners.map((o) => o.user),
      signals: {
        last_conversation_at: lastConversation?.created_at ?? null,
        // "Installed" is the onboarding milestone that predicts whether they will
        // ever convert, so it is the first thing on the page.
        installed_websites: await unscopedPrisma.websites.count({
          where: { workspace_id: id, deleted_at: null, installed_at: { not: null } },
        }),
      },
    });
  });

  // ── Detail: plan ───────────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/plan', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = await unscopedPrisma.workspaces.findUnique({
      where: { id },
      select: {
        plan: true,
        subscription_status: true,
        trial_ends_at: true,
        grace_until: true,
        billing_mode: true,
        subscription: true,
        invoices: {
          orderBy: { created_at: 'desc' },
          take: 12,
          select: {
            id: true,
            number: true,
            status: true,
            amount_due: true,
            amount_paid: true,
            currency: true,
            hosted_invoice_url: true,
            created_at: true,
          },
        },
      },
    });
    if (!ws) return reply.code(404).send({ error: 'Not found' });

    const catalog = await unscopedPrisma.plans.findMany({ orderBy: { sort_order: 'asc' } });
    return reply.send({
      plan: ws.plan,
      // A private plan whose only member is this workspace IS the override — see
      // routes/platform/plans.ts for the reasoning.
      is_override: !ws.plan.is_public,
      subscription: ws.subscription,
      subscription_status: ws.subscription_status,
      // Who owns `plan_id` here. The panel badges it, and the assign-plan dialog needs
      // to know whether it is about to hand the workspace back to Stripe.
      billing_mode: ws.billing_mode,
      trial_ends_at: ws.trial_ends_at,
      grace_until: ws.grace_until,
      invoices: ws.invoices,
      catalog,
    });
  });

  // ── Detail: usage ──────────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/usage', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = await unscopedPrisma.workspaces.findUnique({
      where: { id },
      select: { plan: true },
    });
    if (!ws) return reply.code(404).send({ error: 'Not found' });

    const [counters, aiRecent, seats, websites] = await Promise.all([
      unscopedPrisma.usage_counters.findMany({
        where: { workspace_id: id },
        orderBy: { period_start: 'desc' },
        take: 120,
      }),
      unscopedPrisma.ai_usage.aggregate({
        where: { workspace_id: id, created_at: { gte: periodStart('ai_replies') } },
        _sum: { input_tokens: true, output_tokens: true, cost_micros: true },
        _count: { _all: true },
      }),
      unscopedPrisma.workspace_members.count({ where: { workspace_id: id, status: 'active' } }),
      unscopedPrisma.websites.count({ where: { workspace_id: id, deleted_at: null } }),
    ]);

    const thisPeriod = new Map<string, number>();
    for (const metric of USAGE_METRICS) {
      const start = periodStart(metric).getTime();
      const row = counters.find(
        (c) => c.metric === metric && c.period_start.getTime() === start,
      );
      // BigInt does not survive JSON — narrowed here rather than at a serializer
      // boundary where the failure would be a 500 with no clue.
      thisPeriod.set(metric, Number(row?.value ?? 0n));
    }

    return reply.send({
      current: Object.fromEntries(thisPeriod),
      history: counters.map((c) => ({ ...c, value: Number(c.value) })),
      // Seats and websites are levels, counted live rather than metered, so they are
      // reported next to the metered numbers to keep the plan page one table.
      levels: { seats, websites },
      limits: {
        conversations: ws.plan.max_conversations_month,
        ai_replies: ws.plan.max_ai_replies_month,
        storage_mb: ws.plan.storage_mb,
        seats: ws.plan.max_seats,
        websites: ws.plan.max_websites,
        kb_entries: ws.plan.max_kb_entries,
        bot_flows: ws.plan.max_bot_flows,
        triggers: ws.plan.max_triggers,
      },
      ai_this_period: {
        calls: aiRecent._count._all,
        input_tokens: aiRecent._sum.input_tokens ?? 0,
        output_tokens: aiRecent._sum.output_tokens ?? 0,
        // The number that decides whether a customer is worth their plan.
        cost_micros: aiRecent._sum.cost_micros ?? 0,
      },
    });
  });

  // ── Detail: websites ───────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/websites', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const websites = await unscopedPrisma.websites.findMany({
      where: { workspace_id: id },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        name: true,
        public_key: true,
        primary_domain: true,
        allowed_domains: true,
        enforce_domains: true,
        is_active: true,
        installed_at: true,
        deleted_at: true,
        created_at: true,
        // Whether a signing secret EXISTS is a support-relevant fact; the value is
        // a customer credential and never leaves the tenant plane.
        identity_secret: true,
        _count: { select: { conversations: true } },
        domains: {
          orderBy: { hits: 'desc' },
          take: 10,
          select: { host: true, hits: true, authorized: true, last_seen: true },
        },
      },
    });
    return reply.send({
      websites: websites.map((w) => ({
        ...w,
        identity_secret: undefined,
        has_identity_secret: Boolean(w.identity_secret),
      })),
    });
  });

  // ── Detail: members ────────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/members', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [members, invites] = await Promise.all([
      unscopedPrisma.workspace_members.findMany({
        where: { workspace_id: id },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          role: true,
          status: true,
          all_websites: true,
          is_online: true,
          last_seen: true,
          created_at: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              email_verified_at: true,
              last_login_at: true,
              deleted_at: true,
            },
          },
          websites: { select: { website_id: true } },
        },
      }),
      unscopedPrisma.invites.findMany({
        where: { workspace_id: id, accepted_at: null, revoked_at: null },
        orderBy: { created_at: 'desc' },
        select: { id: true, email: true, role: true, expires_at: true, created_at: true },
      }),
    ]);
    return reply.send({ members, pending_invites: invites });
  });

  // ── Detail: conversations ──────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/conversations', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        status: z.enum(['open', 'pending', 'resolved']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        per_page: z.coerce.number().int().min(1).max(100).default(25),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.issues });
    }
    const { status, page, per_page } = parsed.data;

    const where = { workspace_id: id, ...(status ? { status } : {}) };
    const [total, conversations] = await Promise.all([
      unscopedPrisma.conversations.count({ where }),
      unscopedPrisma.conversations.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip: (page - 1) * per_page,
        take: per_page,
        // METADATA ONLY. Support can see that a conversation exists, how big it is
        // and how it ended; reading what was actually said requires impersonation
        // with a recorded reason, on the customer's own surface.
        select: {
          id: true,
          status: true,
          source: true,
          visitor_name: true,
          visitor_email: true,
          message_count: true,
          needs_human: true,
          rating_stars: true,
          created_at: true,
          updated_at: true,
          resolved_at: true,
          website: { select: { id: true, name: true } },
        },
      }),
    ]);
    return reply.send({ conversations, page, per_page, total });
  });

  // ── Detail: activity ───────────────────────────────────────────────────────
  app.get('/platform/workspaces/:id/activity', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [entries, impersonations] = await Promise.all([
      unscopedPrisma.audit_log.findMany({
        where: { workspace_id: id, action: { not: NOTE_ACTION } },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
      // Shown alongside, because "who from our side has been in here" is the
      // question this tab is usually opened to answer.
      unscopedPrisma.impersonation_sessions.findMany({
        where: { workspace_id: id },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          id: true,
          reason: true,
          scope: true,
          created_at: true,
          expires_at: true,
          ended_at: true,
          platform_user: { select: { id: true, email: true, name: true } },
        },
      }),
    ]);
    return reply.send({ entries, impersonations });
  });

  // ── Detail: notes ──────────────────────────────────────────────────────────
  /**
   * Staff notes live in `audit_log`, not in a table of their own.
   *
   * That is a deliberate choice, not a shortcut around the schema freeze. A note a
   * support agent writes about a customer ("asked us to look at their bill", "this
   * is the account behind the abuse report") has exactly the properties audit_log
   * already guarantees: attributable to a named actor, timestamped, scoped to one
   * workspace, and APPEND-ONLY. A notes table would have to reinvent all four, and
   * would additionally offer a delete — which is precisely the affordance you do not
   * want on the record of what staff said about a customer.
   *
   * They are filtered out of the activity tab so the two lists stay legible.
   */
  app.get('/platform/workspaces/:id/notes', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const notes = await unscopedPrisma.audit_log.findMany({
      where: { workspace_id: id, action: NOTE_ACTION },
      orderBy: { created_at: 'desc' },
      take: 200,
      select: { id: true, actor_id: true, actor_email: true, details: true, created_at: true },
    });
    return reply.send({ notes });
  });

  app.post('/platform/workspaces/:id/notes', { preHandler: platformWrite() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ body: z.string().min(1).max(4000) }), req.body, reply);
    if (!body) return;

    const exists = await unscopedPrisma.workspaces.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Not found' });

    await audit(req, { action: NOTE_ACTION, workspaceId: id, details: { body: body.body } });
    return reply.code(201).send({ ok: true });
  });

  // ── Lifecycle actions ──────────────────────────────────────────────────────
  /**
   * The three levers support actually pulls, and nothing else.
   *
   * Extending a trial and lifting a suspension are the daily ones; cancelling the
   * scheduled purge of a workspace that cancelled by mistake is the rare one that
   * matters most, because it is the only action here that is otherwise irreversible.
   */
  app.post(
    '/platform/workspaces/:id/lifecycle',
    { preHandler: platformWrite('support', 'billing') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({
          action: z.enum(['extend_trial', 'set_status', 'grant_grace', 'cancel_purge', 'restore']),
          /** Mandatory on every lever: a support action with no stated reason is a mystery later. */
          reason: z.string().min(3).max(500),
          days: z.number().int().min(1).max(90).optional(),
          status: z
            .enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'trial_expired', 'suspended'])
            .optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const ws = await unscopedPrisma.workspaces.findUnique({
        where: { id },
        select: { id: true, trial_ends_at: true, subscription_status: true },
      });
      if (!ws) return reply.code(404).send({ error: 'Not found' });

      const data: Record<string, unknown> = {};
      switch (body.action) {
        case 'extend_trial': {
          const days = body.days ?? 14;
          // Extend from whichever is later, so extending an already-expired trial
          // gives the customer the full window rather than a date in the past.
          const from = ws.trial_ends_at && ws.trial_ends_at > new Date() ? ws.trial_ends_at : new Date();
          data.trial_ends_at = new Date(from.getTime() + days * 86_400_000);
          data.subscription_status = 'trialing';
          break;
        }
        case 'set_status':
          if (!body.status) return reply.code(400).send({ error: 'status is required' });
          data.subscription_status = body.status;
          break;
        case 'grant_grace':
          data.grace_until = new Date(Date.now() + (body.days ?? 7) * 86_400_000);
          break;
        case 'cancel_purge':
          data.purge_after = null;
          break;
        case 'restore':
          data.deleted_at = null;
          data.purge_after = null;
          break;
      }

      const updated = await unscopedPrisma.workspaces.update({
        where: { id },
        data,
        select: {
          id: true,
          subscription_status: true,
          trial_ends_at: true,
          grace_until: true,
          purge_after: true,
          deleted_at: true,
        },
      });
      // The auth plugin caches the workspace's plan and status for 30s; a support
      // action must take effect before the customer refreshes, not after.
      invalidateWorkspaceCache(id);

      await audit(req, {
        action: `platform.workspace_${body.action}`,
        workspaceId: id,
        targetType: 'workspace',
        targetId: id,
        details: { reason: body.reason, ...data },
      });
      return reply.send({ workspace: updated });
    },
  );

  /**
   * Set a workspace's plan by hand.
   *
   * `workspaces.plan_id` is documented as written only by the Stripe webhook and the
   * trial/dunning job, and this is the third writer — declared, not smuggled in. It
   * exists because not every customer pays through Stripe: bank transfer, an invoice
   * against a purchase order, a partner arrangement, a plan granted while a payment
   * problem is sorted out.
   *
   * The important part is `billing_mode`, not the plan id. Setting a plan on a
   * workspace Stripe still owns lasts until the next `customer.subscription.updated`
   * silently reverts it, and the nightly trial sweep would expire a customer who has
   * paid us by transfer. So switching to manual is a STATE: while it holds, the webhook
   * mirrors nothing here, both sweeps skip the workspace, and the customer's billing
   * page stops offering checkout — a customer paying by transfer must never be shown a
   * Subscribe button that would charge them twice.
   *
   * Handing a workspace back to Stripe is the same call with mode `stripe`. It does not
   * reconcile anything: if they have a live subscription, the next webhook mirrors it,
   * and if they do not, the trial and dunning rules apply again from wherever their
   * status happens to be. Both are stated in the response so the panel can say so.
   */
  app.post(
    '/platform/workspaces/:id/plan',
    { preHandler: platformWrite('billing') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({
          plan_id: z.string().uuid(),
          /** `manual` = we bill them another way. `stripe` = hand billing back. */
          billing_mode: z.enum(['manual', 'stripe']).default('manual'),
          /**
           * Optional, and usually wanted: a workspace still marked `trialing` on a plan
           * they are paying for by transfer would be expired by the sweep the moment it
           * is handed back to Stripe, and reads as a trial in every list until then.
           */
          status: z
            .enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'trial_expired', 'suspended'])
            .optional(),
          reason: z.string().min(3).max(500),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const [ws, plan] = await Promise.all([
        unscopedPrisma.workspaces.findUnique({
          where: { id },
          select: {
            id: true,
            plan_id: true,
            billing_mode: true,
            subscription_status: true,
            subscription: { select: { stripe_subscription_id: true, status: true } },
          },
        }),
        unscopedPrisma.plans.findUnique({ where: { id: body.plan_id }, select: { id: true, name: true } }),
      ]);
      if (!ws) return reply.code(404).send({ error: 'Not found' });
      if (!plan) return reply.code(400).send({ error: 'No such plan' });

      const updated = await unscopedPrisma.workspaces.update({
        where: { id },
        data: {
          plan_id: plan.id,
          billing_mode: body.billing_mode,
          ...(body.status ? { subscription_status: body.status } : {}),
        },
        select: {
          id: true,
          plan: { select: { id: true, name: true } },
          billing_mode: true,
          subscription_status: true,
        },
      });
      invalidateWorkspaceCache(id);

      await audit(req, {
        action: 'platform.workspace_plan_set',
        workspaceId: id,
        targetType: 'workspace',
        targetId: id,
        details: {
          reason: body.reason,
          from: { plan_id: ws.plan_id, billing_mode: ws.billing_mode, status: ws.subscription_status },
          to: { plan_id: plan.id, billing_mode: body.billing_mode, status: updated.subscription_status },
        },
      });

      return reply.send({
        workspace: updated,
        /**
         * The one thing the panel must be able to warn about: a live Stripe
         * subscription still exists underneath. On `manual` it is now being ignored
         * rather than cancelled — nobody has stopped charging their card — and handing
         * the workspace back to Stripe means the next webhook overwrites this plan.
         */
        stripe_subscription: ws.subscription
          ? { id: ws.subscription.stripe_subscription_id, status: ws.subscription.status }
          : null,
      });
    },
  );

  /**
   * Confirm a member's email address by hand.
   *
   * Unverified blocks invitations, and the usual way out of that is a link in an email.
   * When mail cannot be delivered — no SMTP yet, a bouncing corporate filter, an
   * address that was mistyped and then corrected in support — the customer is stuck in
   * a loop with no exit, and it is not a loop they can leave on their own.
   *
   * So: staff can stamp it, and the stamp is recorded in the customer's own audit log
   * with who did it and why. That record is the difference between a support action and
   * a quiet bypass of an identity check.
   */
  app.post(
    '/platform/users/:userId/confirm-email',
    { preHandler: platformWrite('support') },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const body = parseBody(z.object({ reason: z.string().min(3).max(500) }), req.body, reply);
      if (!body) return;

      const user = await unscopedPrisma.users.findUnique({
        where: { id: userId },
        select: { id: true, email: true, email_verified_at: true, deleted_at: true },
      });
      if (!user || user.deleted_at) return reply.code(404).send({ error: 'Not found' });
      if (user.email_verified_at) {
        return reply.code(409).send({ error: 'Already confirmed', code: 'already_confirmed' });
      }

      const now = new Date();
      await unscopedPrisma.$transaction(async (tx) => {
        await tx.users.update({ where: { id: user.id }, data: { email_verified_at: now } });
        // Any outstanding verification link is spent. Leaving one live means a token
        // sitting in a mailbox that still confirms an address somebody may have changed
        // in the meantime.
        await tx.user_tokens.deleteMany({ where: { user_id: user.id, kind: 'email_verify' } });
      });

      // The workspaces this affects, so the action lands in the log of each customer
      // whose member it was — they are the ones entitled to know their teammate's
      // address was confirmed by us rather than by them.
      const memberships = await unscopedPrisma.workspace_members.findMany({
        where: { user_id: user.id },
        select: { workspace_id: true },
      });
      for (const membership of memberships) {
        await audit(req, {
          action: 'platform.user_email_confirmed',
          workspaceId: membership.workspace_id,
          targetType: 'user',
          targetId: user.id,
          details: { reason: body.reason, email: user.email },
        });
      }
      if (memberships.length === 0) {
        await audit(req, {
          action: 'platform.user_email_confirmed',
          workspaceId: null,
          targetType: 'user',
          targetId: user.id,
          details: { reason: body.reason, email: user.email },
        });
      }

      return reply.send({ user: { id: user.id, email: user.email, email_verified_at: now } });
    },
  );
}
