import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// /me is cross-workspace BY DEFINITION — it lists every workspace the user
// belongs to, so a client scoped to one of them could not answer it.
// eslint-disable-next-line no-restricted-imports -- cross-workspace by definition
import { unscopedPrisma } from '../../db/unscoped.js';
import { requireAuth } from '../../plugins/auth.js';
import { capabilitiesFor, type WorkspaceRole } from '../../permissions.js';
import { parseBody } from '../../lib/validate.js';

/**
 * GET /api/v1/me — the single most important endpoint in the app.
 *
 * One round trip returns the user, every workspace they belong to, and for each:
 * their effective capabilities, website scope, plan and limits, onboarding
 * progress and unread count. The client's route guards, nav filtering, plan gating
 * and workspace switcher all read from this, so anything missing here becomes a
 * second request on every page load.
 */

/**
 * Onboarding progress is derived from server facts, never stored as a step the
 * client reports finishing. That single choice is what makes the wizard resumable
 * from any device and makes the "finish setting up" email a plain deep link — and
 * it means the checklist cannot claim a step is done when it isn't.
 */
function onboardingStep(w: {
  websiteCount: number;
  installedCount: number;
  memberCount: number;
  conversationCount: number;
}): { completed: boolean; step: string | null } {
  if (w.websiteCount === 0) return { completed: false, step: 'website' };
  if (w.installedCount === 0) return { completed: false, step: 'install' };
  if (w.conversationCount === 0) return { completed: false, step: 'first_conversation' };
  if (w.memberCount < 2) return { completed: false, step: 'team' };
  return { completed: true, step: null };
}

export async function meV1Routes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = await unscopedPrisma.users.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        name: true,
        email: true,
        email_verified_at: true,
        timezone: true,
        default_workspace_id: true,
        avatar_file_id: true,
        deleted_at: true,
      },
    });
    if (!user || user.deleted_at) return reply.code(401).send({ error: 'Account unavailable' });

    const memberships = await unscopedPrisma.workspace_members.findMany({
      where: { user_id: user.id, status: 'active' },
      select: {
        id: true,
        role: true,
        all_websites: true,
        websites: { select: { website_id: true } },
        workspace: {
          select: {
            id: true,
            slug: true,
            name: true,
            timezone: true,
            subscription_status: true,
            trial_ends_at: true,
            grace_until: true,
            deleted_at: true,
            plan: true,
            _count: { select: { members: true } },
          },
        },
      },
    });

    const live = memberships.filter((m) => !m.workspace.deleted_at);

    // Counts the switcher and the onboarding checklist need. Grouped queries so
    // this stays two round trips regardless of how many workspaces the user is in
    // — an agency with 30 clients must not cost 30 queries per page load.
    const workspaceIds = live.map((m) => m.workspace.id);
    const [websiteRows, convRows] = await Promise.all([
      workspaceIds.length
        ? unscopedPrisma.websites.findMany({
            where: { workspace_id: { in: workspaceIds }, deleted_at: null },
            select: { workspace_id: true, installed_at: true },
          })
        : Promise.resolve([]),
      workspaceIds.length
        ? unscopedPrisma.conversations.groupBy({
            by: ['workspace_id', 'status'],
            where: { workspace_id: { in: workspaceIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const impersonation = req.auth!.impersonation;

    const workspaces = live.map((m) => {
      const ws = m.workspace;
      const sites = websiteRows.filter((w) => w.workspace_id === ws.id);
      const openCount = convRows
        .filter((c) => c.workspace_id === ws.id && c.status !== 'resolved')
        .reduce((n, c) => n + c._count._all, 0);
      const totalConversations = convRows
        .filter((c) => c.workspace_id === ws.id)
        .reduce((n, c) => n + c._count._all, 0);

      const caps = capabilitiesFor(m.role as WorkspaceRole, impersonation?.scope);
      const plan = ws.plan;

      return {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        timezone: ws.timezone,
        role: m.role,
        member_id: m.id,
        // The effective list, already narrowed for impersonation. The client filters
        // nav and buttons from this; the server remains the authority.
        permissions: [...caps],
        website_scope: m.all_websites ? null : m.websites.map((w) => w.website_id),
        plan: {
          code: plan.code,
          name: plan.name,
          limits: {
            seats: plan.max_seats,
            websites: plan.max_websites,
            conversations_month: plan.max_conversations_month,
            ai_replies_month: plan.max_ai_replies_month,
            kb_entries: plan.max_kb_entries,
            bot_flows: plan.max_bot_flows,
            triggers: plan.max_triggers,
            storage_mb: plan.storage_mb,
          },
          features: {
            remove_branding: plan.allow_remove_branding,
            live_view: plan.allow_live_view,
            bot: plan.allow_bot,
          },
        },
        subscription: {
          status: ws.subscription_status,
          trial_ends_at: ws.trial_ends_at,
          grace_until: ws.grace_until,
        },
        onboarding: onboardingStep({
          websiteCount: sites.length,
          installedCount: sites.filter((s) => s.installed_at).length,
          memberCount: ws._count.members,
          conversationCount: totalConversations,
        }),
        counts: { open_conversations: openCount },
      };
    });

    return reply.send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        email_verified: Boolean(user.email_verified_at),
        timezone: user.timezone,
        avatar_url: user.avatar_file_id ? `/api/v1/files/${user.avatar_file_id}` : null,
        default_workspace_id: user.default_workspace_id,
      },
      workspaces,
      // Rendered as an unmissable banner by the client. Without this the customer
      // has no way to know a staff member is acting inside their account.
      impersonation: impersonation
        ? {
            by_platform_user_id: impersonation.platformUserId,
            scope: impersonation.scope,
            workspace_id: impersonation.workspaceId,
          }
        : null,
    });
  });

  app.patch('/api/v1/me', { preHandler: requireAuth }, async (req, reply) => {
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(120).optional(),
        timezone: z.string().max(60).optional(),
        default_workspace_id: z.string().uuid().nullable().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;

    // Only a workspace the caller actually belongs to may become their default,
    // or the redirect on next login would 404 them into a dead end.
    if (body.default_workspace_id) {
      const member = await unscopedPrisma.workspace_members.findUnique({
        where: {
          workspace_id_user_id: {
            workspace_id: body.default_workspace_id,
            user_id: req.auth!.userId,
          },
        },
        select: { id: true },
      });
      if (!member) return reply.code(404).send({ error: 'Not found' });
    }

    const updated = await unscopedPrisma.users.update({
      where: { id: req.auth!.userId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.default_workspace_id !== undefined
          ? { default_workspace_id: body.default_workspace_id }
          : {}),
      },
      select: { id: true, name: true, email: true, timezone: true, default_workspace_id: true },
    });
    return reply.send({ user: updated });
  });
}
