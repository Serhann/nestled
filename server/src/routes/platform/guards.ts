import type { FastifyReply, FastifyRequest } from 'fastify';
import { requirePlatform } from '../../plugins/auth.js';
import type { PlatformCapability, PlatformRole } from '../../permissions.js';
import { hasVerifiedFactor } from '../../services/platform/sessions.js';

/**
 * Authentication and authorization for the vendor plane.
 *
 * `requirePlatform` (plugins/auth.ts) answers "is this a live staff session?" and
 * resolves what the account may do. Three guards build on it:
 *
 *   platformRead          any live session. The whole read surface.
 *   platformCan(scope)    one named scope, AND a verified second factor.
 *   platformWrite(roles)  the older role-based form, kept for the writes where the
 *                         answer really is "any role, as long as they have a factor".
 *
 * ── Why the factor is a separate axis ──────────────────────────────────────────
 *
 * A staff password is the single credential that reaches every customer at once, so
 * possession of it alone must buy looking and nothing else. Concretely: an account with
 * every scope in the system that has not enrolled TOTP can read the entire panel and
 * change none of it — including its own role, which closes the obvious escalation.
 * Enrolment itself is therefore the one write that does NOT require a factor (you cannot
 * have one yet); it is exempted explicitly at the route rather than by a rule here, so
 * the exception stays visible.
 *
 * ── Why scopes rather than roles ───────────────────────────────────────────────
 *
 * `platformWrite('support', 'billing')` reads like a permission but names two job
 * titles, and because `platformRoleAllows` let a superadmin through unconditionally it
 * could not express "not this person". Every route that gates a real decision now names
 * the DECISION — `platformCan('deletion:create')` — and which roles carry it lives in
 * one table in permissions.ts. Adding a role stops being a change across fourteen files,
 * and "this account administers the install but does not read customer conversations"
 * becomes expressible.
 */

/** Read access for any live staff session, whatever the role. */
export const platformRead = requirePlatform();

/**
 * One capability, WITHOUT the second-factor requirement. For reads.
 *
 * The factor gates change, not sight — that is the whole shape of this surface. A read
 * that still needs a scope is one whose contents are not for everybody: the staff list,
 * for instance, publishes which colleagues have no second factor enrolled, which is a
 * map of which door is unlocked.
 */
export function platformCanRead(capability: PlatformCapability) {
  const authenticate = requirePlatform();
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(req, reply);
    if (reply.sent) return;

    if (!req.platform!.capabilities.has(capability)) {
      await reply.code(403).send({
        error: `This account does not have the ${capability} permission.`,
        code: 'missing_capability',
        capability,
      });
    }
  };
}

/**
 * One capability, plus a verified second factor.
 *
 * The 403 names the scope. An operator reading "Insufficient staff role" has to guess;
 * one reading `deletion:create` can ask for exactly that, and it can be granted without
 * changing anybody's job title.
 */
export function platformCan(capability: PlatformCapability) {
  const authenticate = requirePlatform();
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(req, reply);
    if (reply.sent) return;

    if (!req.platform!.capabilities.has(capability)) {
      await reply.code(403).send({
        error: `This account does not have the ${capability} permission.`,
        code: 'missing_capability',
        capability,
      });
      return;
    }

    if (!(await hasVerifiedFactor(req.platform!.id))) {
      await reply.code(403).send({
        error: 'Enroll a TOTP factor before making changes. This session is read-only.',
        code: 'totp_required',
      });
    }
  };
}

/**
 * Role-based write access. Prefer `platformCan`.
 *
 * Retained for the case it actually describes: a write any role may perform, so the only
 * question is the factor — `platformWrite()` with no arguments. Passing roles still
 * works and still lets a superadmin through unconditionally, which is the behaviour
 * scopes exist to replace, so a call WITH arguments means the route has not been
 * converted yet. There are none left in this tree.
 */
export function platformWrite(...allowed: PlatformRole[]) {
  const authenticate = requirePlatform(...allowed);
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(req, reply);
    if (reply.sent) return;

    if (!(await hasVerifiedFactor(req.platform!.id))) {
      await reply.code(403).send({
        error: 'Enroll a TOTP factor before making changes. This session is read-only.',
        code: 'totp_required',
      });
    }
  };
}
