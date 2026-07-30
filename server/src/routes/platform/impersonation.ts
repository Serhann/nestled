import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { generateOpaqueToken } from '../../auth/tokens.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { settings } from '../../services/platform/settings.js';
import { platformCan, platformRead } from './guards.js';

/**
 * How long the handover code lives.
 *
 * Sixty seconds: the operator clicks, a tab opens, the tab redeems it. Anything longer is
 * a credential-shaped thing with a shelf life, which is what this design exists to avoid.
 */
const CLAIM_TTL_MS = 60_000;

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
    // Starting ANY session needs the weaker of the two scopes and a verified second
    // factor — a stolen staff password must not be able to act as a customer. Asking
    // for `full` is checked in the handler, because which scope is required depends on
    // the body, which a preHandler has no business parsing.
    { preHandler: platformCan('impersonate:read_only') },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };
      const body = parseBody(startBody, req.body, reply);
      if (!body) return;

      // Typing into a customer's inbox is a different permission from watching it.
      if (body.scope === 'full' && !req.platform!.capabilities.has('impersonate:full')) {
        return reply.code(403).send({
          error: 'This account may only impersonate read-only.',
          code: 'missing_capability',
          capability: 'impersonate:full',
        });
      }

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

      /**
       * The handover code, not the token.
       *
       * Single use, 60 seconds, hashed at rest. Long enough to open a tab and short
       * enough that a code left in a chat message is worthless — and the token it buys
       * is only ever seen by the tab that redeems it. See migration 0013 for what this
       * replaced: the panel used to display the signed token for copying.
       */
      const claim = generateOpaqueToken(32);
      const session = await unscopedPrisma.impersonation_sessions.create({
        data: {
          platform_user_id: req.platform!.id,
          workspace_id: workspaceId,
          target_user_id: member.user.id,
          reason: body.reason,
          scope: body.scope,
          ip: req.clientIp,
          expires_at: expiresAt,
          claim_code_hash: claim.hash,
          claim_expires_at: new Date(Date.now() + CLAIM_TTL_MS),
        },
        select: { id: true, created_at: true },
      });

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
        /**
         * Where the panel sends the operator: a new tab on the customer app, which
         * exchanges the code for the token itself.
         *
         * The code rides in the FRAGMENT. A fragment is never sent to a server, so it
         * stays out of nginx's access log and out of any Referer header the app's own
         * requests carry — the query string would have been in both.
         */
        handover_url: `${settings().urls.app}/impersonate#c=${claim.token}`,
        claim_expires_in_seconds: CLAIM_TTL_MS / 1000,
      });
    },
  );

  /** End a session early. The row survives; only `ended_at` is set. */
  app.post('/platform/impersonations/:id/end', { preHandler: platformCan('impersonate:end') }, async (req, reply) => {
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
