import type { FastifyReply, FastifyRequest } from 'fastify';
import { requirePlatform } from '../../plugins/auth.js';
import type { PlatformRole } from '../../permissions.js';
import { hasVerifiedFactor } from '../../services/platform/sessions.js';

/**
 * Authentication and authorization for the vendor plane.
 *
 * `requirePlatform` (plugins/auth.ts) answers "is this a live staff session with an
 * acceptable role?". `platformWrite` adds the orthogonal question that gates every
 * mutation: does this account have a VERIFIED SECOND FACTOR?
 *
 * That is a separate axis from role on purpose. A staff password is the single
 * credential that reaches every customer at once, so possession of it alone must
 * buy looking and nothing else. Concretely: a superadmin who has not enrolled TOTP
 * can read the entire panel and change none of it — including their own role, which
 * closes the obvious escalation. Enrollment itself is therefore the one write that
 * does NOT require a factor (you cannot have one yet); it is exempted explicitly at
 * the route rather than by a rule here, so the exception stays visible.
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

/** Read access for any live staff session, whatever the role. */
export const platformRead = requirePlatform();
