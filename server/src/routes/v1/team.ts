import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// Invite acceptance runs before the invitee is a member, and seat counting spans
// members plus pending invites for a workspace the caller may not be scoped to
// yet. Member and invite CRUD all go through req.db.
// eslint-disable-next-line no-restricted-imports -- invite acceptance is pre-membership
import { unscopedPrisma } from '../../db/unscoped.js';
import {
  requireVerified,
  requireWorkspace,
  can,
  invalidateMemberCache,
} from '../../plugins/auth.js';
import { generateOpaqueToken, hashToken } from '../../auth/tokens.js';
import { hashPassword } from '../../auth/password.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { sendEmail } from '../../services/email.js';
import { WORKSPACE_ROLES } from '../../permissions.js';
import { seatsInUse, syncSeats } from '../../services/billing/index.js';
import { settings } from '../../services/platform/settings.js';

/**
 * Team members and invitations.
 *
 * Replaces the old flow where an admin typed a colleague's password into a form.
 * An invite proves control of the mailbox, which is both better security and the
 * only way a teammate can set a password the admin never sees.
 */

const INVITE_TTL_DAYS = 7;

const roleField = z.enum(WORKSPACE_ROLES);

const scopeFields = z.object({
  all_websites: z.boolean().optional(),
  website_ids: z.array(z.string().uuid()).max(100).optional(),
});

/**
 * Seats = active members + outstanding invites, and the count now lives in
 * services/billing so the number that ENFORCES the limit and the number that gets
 * BILLED are the same function. Every membership change below ends in syncSeats(),
 * which recounts and pushes the quantity to Stripe.
 */

export async function teamV1Routes(app: FastifyInstance): Promise<void> {
  // ── Members ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/members',
    { preHandler: [requireWorkspace, can('member:read')] },
    async (req, reply) => {
      const members = await req.db.workspace_members.findMany({
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          role: true,
          status: true,
          all_websites: true,
          is_online: true,
          last_seen: true,
          created_at: true,
          websites: { select: { website_id: true } },
          user: { select: { id: true, name: true, email: true, avatar_file_id: true, last_login_at: true } },
        },
      });
      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { max_seats: true },
      });
      return reply.send({
        members: members.map((m) => ({
          id: m.id,
          role: m.role,
          status: m.status,
          all_websites: m.all_websites,
          website_ids: m.websites.map((w) => w.website_id),
          is_online: m.is_online,
          last_seen: m.last_seen,
          created_at: m.created_at,
          user: {
            id: m.user.id,
            name: m.user.name,
            email: m.user.email,
            avatar_url: m.user.avatar_file_id ? `/api/v1/files/${m.user.avatar_file_id}` : null,
            last_login_at: m.user.last_login_at,
          },
        })),
        seats: { used: await seatsInUse(req.auth!.workspace!.id), included: plan.max_seats },
      });
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId/members/:memberId',
    { preHandler: [requireWorkspace, can('member:update')] },
    async (req, reply) => {
      const { memberId } = req.params as { memberId: string };
      const body = parseBody(
        scopeFields.extend({ role: roleField.optional(), status: z.enum(['active', 'suspended']).optional() }),
        req.body,
        reply,
      );
      if (!body) return;

      const target = await req.db.workspace_members.findUnique({
        where: { id: memberId },
        select: { id: true, role: true, user_id: true },
      });
      if (!target) return reply.code(404).send({ error: 'Not found' });

      const actorRole = req.auth!.member!.role;
      // Only an owner may grant or revoke ownership. Without this an admin could
      // promote themselves and then remove the owner.
      if ((body.role === 'owner' || target.role === 'owner') && actorRole !== 'owner') {
        return reply.code(403).send({ error: 'Only an owner can change ownership' });
      }
      // A workspace must always retain at least one owner, or nobody can manage
      // billing or delete it — an unrecoverable state.
      if (target.role === 'owner' && body.role && body.role !== 'owner') {
        const owners = await req.db.workspace_members.count({ where: { role: 'owner', status: 'active' } });
        if (owners <= 1) {
          return reply.code(409).send({ error: 'A workspace needs at least one owner', code: 'last_owner' });
        }
      }

      const workspaceId = req.auth!.workspace!.id;
      await unscopedPrisma.$transaction(async (tx) => {
        await tx.workspace_members.update({
          where: { id: memberId },
          data: {
            ...(body.role ? { role: body.role } : {}),
            ...(body.status ? { status: body.status } : {}),
            ...(body.all_websites !== undefined ? { all_websites: body.all_websites } : {}),
          },
        });
        if (body.website_ids) {
          // Verify every id belongs to THIS workspace before granting access —
          // otherwise a crafted body would grant a member access to a foreign
          // website row.
          const owned = await tx.websites.findMany({
            where: { workspace_id: workspaceId, id: { in: body.website_ids } },
            select: { id: true },
          });
          await tx.member_website_access.deleteMany({ where: { member_id: memberId } });
          if (owned.length > 0) {
            await tx.member_website_access.createMany({
              data: owned.map((w) => ({ member_id: memberId, website_id: w.id })),
            });
          }
        }
      });

      invalidateMemberCache(workspaceId, target.user_id);
      // Suspending or reactivating a member changes the billable seat count.
      await syncSeats(workspaceId);
      await audit(req, { action: 'member.updated', targetType: 'member', targetId: memberId });
      return reply.send({ ok: true });
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/members/:memberId',
    { preHandler: [requireWorkspace, can('member:remove')] },
    async (req, reply) => {
      const { memberId } = req.params as { memberId: string };
      const target = await req.db.workspace_members.findUnique({
        where: { id: memberId },
        select: { id: true, role: true, user_id: true },
      });
      if (!target) return reply.code(404).send({ error: 'Not found' });

      if (target.role === 'owner') {
        const owners = await req.db.workspace_members.count({ where: { role: 'owner', status: 'active' } });
        if (owners <= 1) {
          return reply.code(409).send({ error: 'A workspace needs at least one owner', code: 'last_owner' });
        }
      }

      // The conversations they were assigned survive with assigned_member_id
      // cleared — enforced by the composite FK's ON DELETE SET NULL. Someone
      // leaving must never delete their customers' support history.
      await req.db.workspace_members.delete({ where: { id: memberId } });
      invalidateMemberCache(req.auth!.workspace!.id, target.user_id);
      await syncSeats(req.auth!.workspace!.id);
      await audit(req, { action: 'member.removed', targetType: 'member', targetId: memberId });
      return reply.send({ ok: true });
    },
  );

  // ── Invites ───────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/invites',
    { preHandler: [requireWorkspace, can('member:read')] },
    async (req, reply) => {
      const invites = await req.db.invites.findMany({
        where: { accepted_at: null, revoked_at: null },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          all_websites: true,
          website_ids: true,
          expires_at: true,
          created_at: true,
          author: { select: { name: true } },
        },
      });
      return reply.send({
        invites: invites.map((i) => ({ ...i, expired: i.expires_at < new Date() })),
      });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/invites',
    // requireVerified: an unverified account must not be able to send mail. This is
    // the abuse surface that matters, which is why open signup is safe.
    { preHandler: [requireVerified, requireWorkspace, can('member:invite')] },
    async (req, reply) => {
      const body = parseBody(
        scopeFields.extend({ email: z.string().email().max(200), role: roleField.default('agent') }),
        req.body,
        reply,
      );
      if (!body) return;
      if (body.role === 'owner' && req.auth!.member!.role !== 'owner') {
        return reply.code(403).send({ error: 'Only an owner can invite an owner' });
      }

      const workspaceId = req.auth!.workspace!.id;
      const email = body.email.toLowerCase();

      const alreadyMember = await unscopedPrisma.workspace_members.findFirst({
        where: { workspace_id: workspaceId, user: { email } },
        select: { id: true },
      });
      if (alreadyMember) {
        return reply.code(409).send({ error: 'That person is already on the team', code: 'already_member' });
      }

      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { max_seats: true },
      });
      const used = await seatsInUse(workspaceId);
      if (used >= plan.max_seats) {
        return reply.code(402).send({
          error: `Your plan includes ${plan.max_seats} seat${plan.max_seats === 1 ? '' : 's'}`,
          code: 'plan_limit',
          metric: 'seats',
          limit: plan.max_seats,
          used,
        });
      }

      const { token, hash } = generateOpaqueToken();
      // Replace any outstanding invite for this address. The partial unique index
      // permits exactly one pending invite per email per workspace, so re-inviting
      // has to revoke the old one rather than collide.
      await unscopedPrisma.invites.updateMany({
        where: { workspace_id: workspaceId, email, accepted_at: null, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      const invite = await req.db.invites.create({
        data: {
          email,
          role: body.role,
          all_websites: body.all_websites ?? true,
          website_ids: body.website_ids ?? [],
          token_hash: hash,
          invited_by_id: req.auth!.userId,
          expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 864e5),
        } as never,
        select: { id: true, email: true, role: true, expires_at: true },
      });

      const inviter = await unscopedPrisma.users.findUniqueOrThrow({
        where: { id: req.auth!.userId },
        select: { name: true },
      });
      void sendEmail({
        to: email,
        template: 'workspace_invite',
        vars: {
          inviterName: inviter.name,
          workspaceName: req.auth!.workspace!.slug,
          role: body.role,
          url: `${settings().urls.app}/invite/${token}`,
        },
        workspaceId,
        relatedType: 'invite',
        relatedId: invite.id,
      });

      // A pending invite holds a seat, so it is billed from the moment it is sent.
      await syncSeats(workspaceId);
      await audit(req, { action: 'invite.created', targetType: 'invite', targetId: invite.id, details: { email } });
      // The raw token is returned so the UI can offer a copyable link for Slack —
      // the common case where email is slower than the conversation already happening.
      return reply.code(201).send({ invite, invite_url: `${settings().urls.app}/invite/${token}` });
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/invites/:inviteId',
    { preHandler: [requireWorkspace, can('member:invite')] },
    async (req, reply) => {
      const { inviteId } = req.params as { inviteId: string };
      try {
        await req.db.invites.update({ where: { id: inviteId }, data: { revoked_at: new Date() } });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
      await syncSeats(req.auth!.workspace!.id);
      await audit(req, { action: 'invite.revoked', targetType: 'invite', targetId: inviteId });
      return reply.send({ ok: true });
    },
  );

  // ── Public invite endpoints (the recipient is not authenticated yet) ───────
  app.get(
    '/api/v1/invites/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const invite = await unscopedPrisma.invites.findUnique({
        where: { token_hash: hashToken(token) },
        select: {
          email: true,
          role: true,
          expires_at: true,
          accepted_at: true,
          revoked_at: true,
          workspace: { select: { name: true, slug: true } },
          author: { select: { name: true } },
        },
      });
      if (!invite || invite.revoked_at || invite.accepted_at || invite.expires_at < new Date()) {
        return reply.code(404).send({ error: 'That invitation is no longer valid', code: 'bad_invite' });
      }
      // Only what the acceptance screen needs to render. Nothing about the
      // workspace's data, and no hint about other members.
      return reply.send({
        invite: {
          email: invite.email,
          role: invite.role,
          workspace_name: invite.workspace.name,
          inviter_name: invite.author?.name ?? null,
        },
      });
    },
  );

  app.post(
    '/api/v1/invites/:token/accept',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = parseBody(
        z.object({
          /** Required only when the invitee has no account yet. */
          name: z.string().min(1).max(120).optional(),
          password: z.string().min(10).max(200).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const invite = await unscopedPrisma.invites.findUnique({
        where: { token_hash: hashToken(token) },
        select: {
          id: true,
          workspace_id: true,
          email: true,
          role: true,
          all_websites: true,
          website_ids: true,
          expires_at: true,
          accepted_at: true,
          revoked_at: true,
        },
      });
      if (!invite || invite.revoked_at || invite.accepted_at || invite.expires_at < new Date()) {
        return reply.code(404).send({ error: 'That invitation is no longer valid', code: 'bad_invite' });
      }

      const existing = await unscopedPrisma.users.findUnique({
        where: { email: invite.email },
        select: { id: true },
      });
      if (!existing && (!body.password || !body.name)) {
        return reply.code(400).send({ error: 'A name and password are required', code: 'needs_account' });
      }

      const userId = await unscopedPrisma.$transaction(async (tx) => {
        let id = existing?.id;
        if (!id) {
          const created = await tx.users.create({
            data: {
              name: body.name!,
              email: invite.email,
              password_hash: await hashPassword(body.password!),
              // Receiving the token proves control of the mailbox, so there is
              // nothing left for a verification email to establish.
              email_verified_at: new Date(),
              default_workspace_id: invite.workspace_id,
            },
            select: { id: true },
          });
          id = created.id;
        }

        const member = await tx.workspace_members.upsert({
          where: { workspace_id_user_id: { workspace_id: invite.workspace_id, user_id: id } },
          update: { role: invite.role, status: 'active', all_websites: invite.all_websites },
          create: {
            workspace_id: invite.workspace_id,
            user_id: id,
            role: invite.role,
            all_websites: invite.all_websites,
          },
          select: { id: true },
        });

        if (!invite.all_websites && invite.website_ids.length > 0) {
          const owned = await tx.websites.findMany({
            where: { workspace_id: invite.workspace_id, id: { in: invite.website_ids } },
            select: { id: true },
          });
          await tx.member_website_access.createMany({
            data: owned.map((w) => ({ member_id: member.id, website_id: w.id })),
            skipDuplicates: true,
          });
        }

        await tx.invites.update({ where: { id: invite.id }, data: { accepted_at: new Date() } });
        return id;
      });

      invalidateMemberCache(invite.workspace_id, userId);
      // An accepted invite converts a pending seat into an active one. The total is
      // usually unchanged, but not when the invitee was already a suspended member.
      await syncSeats(invite.workspace_id);
      await audit(req, {
        action: 'invite.accepted',
        workspaceId: invite.workspace_id,
        targetType: 'invite',
        targetId: invite.id,
      });
      return reply.send({ ok: true, workspace_id: invite.workspace_id, had_account: Boolean(existing) });
    },
  );
}
