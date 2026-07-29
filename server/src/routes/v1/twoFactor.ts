import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
// Account security is workspace-agnostic: it is a property of the human, not of any
// one tenant, and it is checked at login before a workspace exists.
// eslint-disable-next-line no-restricted-imports -- pre-tenant identity flow
import { unscopedPrisma } from '../../db/unscoped.js';
import { verifyPassword } from '../../auth/password.js';
import { requireAuth } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { generateTotpSecret, otpauthUri } from '../../lib/totp.js';
import { sendEmail } from '../../services/email.js';
import {
  checkSecondFactor,
  countUnusedRecoveryCodes,
  issueRecoveryCodes,
} from '../../services/twoFactor.js';

/**
 * Two-step verification, for the customer account rather than the workspace.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Three rules shape every route below.
 *
 * **The password is re-entered for every change.** Adding a factor and removing one
 * are both attacks when someone else is holding the session: enrol, and the real
 * owner is locked out of their own inbox; remove, and the protection is gone. A
 * session cookie proves someone was logged in once, which is precisely the thing in
 * doubt at this moment.
 *
 * **Support can never touch it.** Impersonation is refused outright here, not merely
 * stripped of a capability. There is no legitimate version of Nestled staff adding or
 * removing the second factor on a customer's account, and if a customer is locked
 * out, the answer is the recovery codes they were given — not us reaching in.
 *
 * **Enabling is a two-step commit.** `POST` stores the secret, and only a live code
 * flips `totp_enabled`. Writing both at once would lock out anyone whose scan failed
 * or whose clock is off — which is the single most common way to break your own
 * account while trying to secure it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const codeField = z.string().min(4).max(20).optional();

/** Impersonation is refused before anything else runs. See the rules above. */
function blockImpersonation(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.auth?.impersonation) return false;
  void reply.code(403).send({
    error: 'Two-step verification cannot be changed during a support session',
    code: 'impersonated',
  });
  return true;
}

async function loadUser(userId: string) {
  return unscopedPrisma.users.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      password_hash: true,
      totp_secret: true,
      totp_enabled: true,
      totp_last_step: true,
    },
  });
}

export async function twoFactorV1Routes(app: FastifyInstance): Promise<void> {
  /** What the security page renders. */
  app.get('/api/v1/me/two-factor', { preHandler: requireAuth }, async (req, reply) => {
    const user = await unscopedPrisma.users.findUniqueOrThrow({
      where: { id: req.auth!.userId },
      select: { totp_enabled: true, totp_enrolled_at: true },
    });
    return reply.send({
      enabled: user.totp_enabled,
      enrolled_at: user.totp_enrolled_at,
      recovery_codes_left: user.totp_enabled
        ? await countUnusedRecoveryCodes(req.auth!.userId)
        : 0,
    });
  });

  /**
   * Begin enrolment: mint a secret and hand back the URI to scan.
   *
   * Rate-limited hard. This is the one endpoint that returns a secret, and each call
   * discards the previous one — a loop against it would leave someone who is
   * mid-scan permanently unable to finish.
   */
  app.post(
    '/api/v1/me/totp',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (blockImpersonation(req, reply)) return;
      const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body, reply);
      if (!body) return;

      const user = await loadUser(req.auth!.userId);
      if (!(await verifyPassword(body.password, user.password_hash))) {
        return reply.code(403).send({ error: 'That password is incorrect', code: 'bad_password' });
      }
      if (user.totp_enabled) {
        // Not an error to be swallowed: re-enrolling silently would replace a working
        // factor with an unconfirmed one and leave the account weaker than it started.
        return reply
          .code(409)
          .send({ error: 'Two-step verification is already on', code: 'totp_present' });
      }

      const secret = generateTotpSecret();
      await unscopedPrisma.users.update({
        where: { id: user.id },
        data: { totp_secret: secret },
      });
      return reply.send({
        secret,
        otpauth_uri: otpauthUri({ secret, account: user.email, issuer: 'Nestled' }),
      });
    },
  );

  /** Confirm with a live code. Only this turns the factor on, and it issues the codes. */
  app.post(
    '/api/v1/me/totp/verify',
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (blockImpersonation(req, reply)) return;
      const body = parseBody(z.object({ code: z.string().min(4).max(20) }), req.body, reply);
      if (!body) return;

      const user = await loadUser(req.auth!.userId);
      if (!user.totp_secret) {
        return reply.code(400).send({ error: 'Start by scanning the code', code: 'totp_absent' });
      }
      if (user.totp_enabled) {
        return reply
          .code(409)
          .send({ error: 'Two-step verification is already on', code: 'totp_present' });
      }

      const check = await checkSecondFactor(user, { totp: body.code });
      if (!check.ok) {
        return reply.code(400).send({
          error:
            check.reason === 'replayed'
              ? 'That code has been used. Wait for your app to show the next one.'
              : 'That code is not valid. Check your phone’s clock is set automatically.',
          code: 'totp_invalid',
        });
      }

      await unscopedPrisma.users.update({
        where: { id: user.id },
        data: { totp_enabled: true, totp_enrolled_at: new Date() },
      });
      const recovery_codes = await issueRecoveryCodes(user.id);

      /*
        Both of these are notifications of a change to how the account is protected,
        so they go out even though the person who made the change is watching the
        screen. If it was not them, this email is how they find out.
      */
      void sendEmail({
        to: user.email,
        template: 'two_factor_changed',
        vars: { name: user.name, action: 'turned on' },
        relatedType: 'user',
        relatedId: user.id,
      });
      await audit(req, { action: 'auth.totp_enabled', targetType: 'user', targetId: user.id });

      return reply.send({ ok: true, recovery_codes });
    },
  );

  /** Turn it off. Password AND a factor — the same pair that would let someone in. */
  app.delete(
    '/api/v1/me/totp',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (blockImpersonation(req, reply)) return;
      const body = parseBody(
        z.object({
          password: z.string().min(1).max(200),
          totp: codeField,
          recovery_code: codeField,
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const user = await loadUser(req.auth!.userId);
      if (!(await verifyPassword(body.password, user.password_hash))) {
        return reply.code(403).send({ error: 'That password is incorrect', code: 'bad_password' });
      }
      if (!user.totp_enabled) return reply.send({ ok: true, already_off: true });

      const check = await checkSecondFactor(user, body);
      if (!check.ok) {
        // "Replayed" is told apart from "wrong" here too. A code that was already
        // spent still LOOKS right on the phone, so reporting it as invalid sends
        // someone to check their clock over a problem that solves itself in
        // thirty seconds.
        return reply.code(400).send({
          error:
            check.reason === 'replayed'
              ? 'That code has been used. Wait for the next one.'
              : 'That code is not valid',
          code: 'totp_invalid',
        });
      }

      await unscopedPrisma.$transaction([
        unscopedPrisma.users.update({
          where: { id: user.id },
          data: {
            totp_enabled: false,
            totp_secret: null,
            totp_enrolled_at: null,
            totp_last_step: null,
          },
        }),
        // The codes go with it. Leaving them behind would mean a later re-enrolment
        // silently inherited a list the customer thinks was retired.
        unscopedPrisma.user_recovery_codes.deleteMany({ where: { user_id: user.id } }),
      ]);
      void sendEmail({
        to: user.email,
        template: 'two_factor_changed',
        vars: { name: user.name, action: 'turned off' },
        relatedType: 'user',
        relatedId: user.id,
      });
      await audit(req, { action: 'auth.totp_disabled', targetType: 'user', targetId: user.id });
      return reply.send({ ok: true });
    },
  );

  /** A fresh list, replacing the old one. For "I used some" and "I lost the paper". */
  app.post(
    '/api/v1/me/totp/recovery-codes',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (blockImpersonation(req, reply)) return;
      const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body, reply);
      if (!body) return;

      const user = await loadUser(req.auth!.userId);
      if (!(await verifyPassword(body.password, user.password_hash))) {
        return reply.code(403).send({ error: 'That password is incorrect', code: 'bad_password' });
      }
      if (!user.totp_enabled) {
        return reply
          .code(400)
          .send({ error: 'Two-step verification is off', code: 'totp_absent' });
      }

      const recovery_codes = await issueRecoveryCodes(user.id);
      await audit(req, {
        action: 'auth.recovery_codes_regenerated',
        targetType: 'user',
        targetId: user.id,
      });
      return reply.send({ recovery_codes });
    },
  );
}
