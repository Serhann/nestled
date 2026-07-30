import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { signAccessToken } from '../../auth/tokens.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { platformRead, platformWrite } from './guards.js';

/**
 * Impersonation.
 *
 * The controls that make this defensible to a customer, all of them structural
 * rather than procedural:
 *
 *   1. `reason` is mandatory and there is no DELETE on impersonation_sessions,
 *      anywhere in this codebase. The customer sees the list on their own audit
 *      page; staff cannot curate it.
 *   2. The token is a CUSTOMER-plane access token carrying an `act` claim, and no
 *      refresh token is issued. It therefore dies at its TTL with nothing to renew
 *      it — a stolen impersonation token has a hard, short ceiling.
 *   3. The claim names ONE workspace. requireWorkspace refuses the token on any
 *      other, so a session opened on customer A cannot be replayed against B by
 *      editing the URL.
 *   4. `capabilitiesFor(role, scope)` subtracts billing, integrations, membership
 *      and export from every impersonated session whatever the borrowed role, and
 *      `read_only` additionally strips every mutating capability. The tenant client
 *      enforces the second mechanically: with `readOnly` set, every non-read Prisma
 *      operation throws before it reaches Postgres, so a route that forgot its
 *      capability check still cannot write.
 *   5. Every mutation lands in the CUSTOMER's audit log, attributed to the platform
 *      user and tagged with the session id (see lib/audit.ts).
 *   6. requireAuth re-checks the session row on every request, so "end session"
 *      bites within seconds rather than at token expiry.
 *
 * Also deliberate: there is no way to impersonate from here into the live-visitor
 * board or session replay as a shortcut. Those live on the tenant surface, which is
 * exactly where an impersonated session reaches them — through the front door, with
 * the reason already recorded.
 */

/** Hard ceiling, independent of what the client asks for. */
const MAX_TTL_MINUTES = 30;

const startBody = z.object({
  reason: z.string().min(10, 'Say what you are investigating').max(500),
  scope: z.enum(['read_only', 'full']),
  ttl_minutes: z.number().int().min(1).max(MAX_TTL_MINUTES).default(15),
  /**
   * Which member to borrow. Optional: the default is an owner, because support is
   * almost always reproducing something the owner reported and a narrower role
   * would reproduce a different bug.
   */
  target_user_id: z.string().uuid().optional(),
});

export async function platformImpersonationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/platform/workspaces/:id/impersonate',
    // `full` scope is a write capability by definition, so this needs a verified
    // second factor — a stolen staff password must not be able to act as a customer.
    { preHandler: platformWrite('support') },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };
      const body = parseBody(startBody, req.body, reply);
      if (!body) return;

      const workspace = await unscopedPrisma.workspaces.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, deleted_at: true },
      });
      if (!workspace || workspace.deleted_at) return reply.code(404).send({ error: 'Not found' });

      // The token's `sub` must be a REAL member: requireWorkspace resolves the
      // membership from the database, so a synthetic user id would authenticate and
      // then 404 on every tenant route, which looks like a product bug rather than
      // a misuse.
      const member = body.target_user_id
        ? await unscopedPrisma.workspace_members.findUnique({
            where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: body.target_user_id } },
            select: { user: { select: { id: true, email: true, name: true, deleted_at: true } } },
          })
        : await unscopedPrisma.workspace_members.findFirst({
            where: { workspace_id: workspaceId, status: 'active', user: { deleted_at: null } },
            // Owner first, then admin, then agent — borrow the most capable account
            // so the session reproduces what the customer described.
            orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
            select: { user: { select: { id: true, email: true, name: true, deleted_at: true } } },
          });

      if (!member || member.user.deleted_at) {
        return reply.code(400).send({
          error: 'That workspace has no active member to impersonate',
          code: 'no_target',
        });
      }

      const expiresAt = new Date(Date.now() + body.ttl_minutes * 60_000);
      const session = await unscopedPrisma.impersonation_sessions.create({
        data: {
          platform_user_id: req.platform!.id,
          workspace_id: workspaceId,
          target_user_id: member.user.id,
          reason: body.reason,
          scope: body.scope,
          ip: req.clientIp,
          expires_at: expiresAt,
        },
        select: { id: true, created_at: true },
      });

      // The access token's own lifetime matches the session's, so the two cannot
      // disagree. There is deliberately NO refresh token: this credential expires
      // and that is the end of it.
      const accessToken = signAccessToken(
        {
          sub: member.user.id,
          typ: 'user',
          email: member.user.email,
          act: {
            pu: req.platform!.id,
            sid: session.id,
            ws: workspaceId,
            scope: body.scope,
          },
        },
        `${body.ttl_minutes}m`,
      );

      // Written into the CUSTOMER's log, not only ours. The customer must be able to
      // see that this happened without asking us.
      await audit(req, {
        action: 'platform.impersonation_started',
        workspaceId,
        targetType: 'user',
        targetId: member.user.id,
        details: {
          reason: body.reason,
          scope: body.scope,
          ttl_minutes: body.ttl_minutes,
          impersonation_session_id: session.id,
        },
      });

      return reply.code(201).send({
        session: {
          id: session.id,
          workspace_id: workspaceId,
          workspace_name: workspace.name,
          scope: body.scope,
          reason: body.reason,
          expires_at: expiresAt.toISOString(),
          created_at: session.created_at.toISOString(),
          target: { id: member.user.id, name: member.user.name, email: member.user.email },
        },
        access_token: accessToken,
        // Named so no client is tempted to look for one. See point 2 above.
        refresh_token: null,
        expires_at: expiresAt.toISOString(),
      });
    },
  );

  /** End a session early. The row survives; only `ended_at` is set. */
  app.post('/platform/impersonations/:id/end', { preHandler: platformWrite('support') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await unscopedPrisma.impersonation_sessions.findUnique({
      where: { id },
      select: { id: true, workspace_id: true, ended_at: true, platform_user_id: true },
    });
    if (!session) return reply.code(404).send({ error: 'Not found' });
    if (session.ended_at) return reply.send({ ok: true, already_ended: true });

    await unscopedPrisma.impersonation_sessions.update({
      where: { id },
      data: { ended_at: new Date() },
    });
    // Any superadmin can end anyone's session — the ability to stop a colleague
    // who is somewhere they should not be is worth more than tidy ownership.
    await audit(req, {
      action: 'platform.impersonation_ended',
      workspaceId: session.workspace_id,
      targetType: 'impersonation_session',
      targetId: id,
      details: { ended_by_owner: session.platform_user_id === req.platform!.id },
    });
    // requireAuth caches liveness for 10 seconds (plugins/auth.ts), so the caller
    // is told how long the token can still be used rather than being left to assume
    // "ended" means "already dead".
    return reply.send({ ok: true, effective_within_seconds: 10 });
  });

  /**
   * The register. Cross-workspace, newest first, and read-only for every staff role
   * including superadmin — there is no route in this codebase that deletes a row
   * from this table.
   */
  app.get('/platform/impersonations', { preHandler: platformRead }, async (req, reply) => {
    const parsed = z
      .object({
        workspace_id: z.string().uuid().optional(),
        platform_user_id: z.string().uuid().optional(),
        active_only: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.issues });
    }
    const { workspace_id, platform_user_id, active_only, limit } = parsed.data;

    const sessions = await unscopedPrisma.impersonation_sessions.findMany({
      where: {
        ...(workspace_id ? { workspace_id } : {}),
        ...(platform_user_id ? { platform_user_id } : {}),
        ...(active_only ? { ended_at: null, expires_at: { gt: new Date() } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        reason: true,
        scope: true,
        ip: true,
        target_user_id: true,
        created_at: true,
        expires_at: true,
        ended_at: true,
        platform_user: { select: { id: true, email: true, name: true } },
        workspace: { select: { id: true, name: true, slug: true } },
        _count: { select: { audit_entries: true } },
      },
    });

    const now = Date.now();
    return reply.send({
      sessions: sessions.map((s) => ({
        ...s,
        active: !s.ended_at && s.expires_at.getTime() > now,
        // How many customer-visible mutations this session actually made. A `full`
        // session with zero is the normal case; a large number is the thing a
        // reviewer wants to notice.
        mutations: s._count.audit_entries,
        _count: undefined,
      })),
    });
  });

  /** One session, with the exact list of what it did inside the customer's account. */
  app.get('/platform/impersonations/:id', { preHandler: platformRead }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await unscopedPrisma.impersonation_sessions.findUnique({
      where: { id },
      select: {
        id: true,
        reason: true,
        scope: true,
        ip: true,
        target_user_id: true,
        created_at: true,
        expires_at: true,
        ended_at: true,
        platform_user: { select: { id: true, email: true, name: true } },
        workspace: { select: { id: true, name: true, slug: true } },
        audit_entries: {
          orderBy: { created_at: 'asc' },
          select: { id: true, action: true, target_type: true, target_id: true, details: true, created_at: true },
        },
      },
    });
    if (!session) return reply.code(404).send({ error: 'Not found' });
    return reply.send({
      session: {
        ...session,
        active: !session.ended_at && session.expires_at.getTime() > Date.now(),
      },
    });
  });
}
