import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// The identity plane runs BEFORE a workspace is known: signup creates the user
// and workspace, and login/refresh/reset resolve a user with no tenant context at
// all. There is no scoped client to use yet.
// eslint-disable-next-line no-restricted-imports -- pre-tenant identity flows
import { unscopedPrisma } from '../../db/unscoped.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  generateOpaqueToken,
  generateRefreshToken,
  hashToken,
  refreshExpiryDate,
  signAccessToken,
} from '../../auth/tokens.js';
import { requireAuth } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { uniqueSlug, slugIsAvailable } from '../../lib/slug.js';
import { sendEmail } from '../../services/email.js';
import { checkSecondFactor, countUnusedRecoveryCodes } from '../../services/twoFactor.js';
import { randomUUID } from 'node:crypto';
import { settings } from '../../services/platform/settings.js';

/**
 * Authentication and account lifecycle.
 *
 * Self-serve signup is OPEN here — the opposite of the old build, where
 * registration was closed and admins provisioned everyone by hand.
 *
 * The spam-resistance line is not "block unverified users from the dashboard"
 * (a dead end that punishes real users on their first minute) but
 * `requireVerified` on the two things abuse actually wants: serving a widget, and
 * sending outbound email. An unverified account can explore and configure; it
 * cannot mail anyone or put a widget on the internet.
 */

const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1;

const passwordField = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200);

const signupBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  password: passwordField,
  /** Optional: the wizard can create the workspace in a later step instead. */
  workspace_name: z.string().min(1).max(120).optional(),
});

async function issueSession(
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ access_token: string; refresh_token: string }> {
  const user = await unscopedPrisma.users.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true },
  });
  const { token: refresh, hash } = generateRefreshToken();
  await unscopedPrisma.refresh_tokens.create({
    data: {
      user_id: user.id,
      // A rotation family: presenting an already-rotated token revokes the whole
      // family, which turns token theft into a detectable event.
      session_id: randomUUID(),
      token_hash: hash,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 400) ?? null,
      expires_at: refreshExpiryDate(),
    },
  });
  return {
    access_token: signAccessToken({ sub: user.id, typ: 'user', email: user.email }),
    refresh_token: refresh,
  };
}

async function queueVerificationEmail(userId: string, name: string, email: string): Promise<void> {
  const { token, hash } = generateOpaqueToken();
  await unscopedPrisma.user_tokens.create({
    data: {
      user_id: userId,
      kind: 'email_verify',
      token_hash: hash,
      expires_at: new Date(Date.now() + VERIFY_TTL_HOURS * 3600_000),
    },
  });
  await sendEmail({
    to: email,
    template: 'verify_email',
    vars: { name, url: `${settings().urls.app}/verify?token=${token}` },
    relatedType: 'user',
    relatedId: userId,
  });
}

export async function authV1Routes(app: FastifyInstance): Promise<void> {
  // ── Signup ────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(signupBody, req.body, reply);
      if (!body) return;
      const email = body.email.toLowerCase();

      const existing = await unscopedPrisma.users.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        // Deliberately explicit rather than a generic error: this endpoint is
        // reached from a form where the user knows whether they have an account,
        // and pretending otherwise just makes them retry. (Password RESET is the
        // endpoint that must not confirm existence — see below.)
        return reply.code(409).send({ error: 'An account with that email already exists', code: 'email_taken' });
      }

      const plan =
        (await unscopedPrisma.plans.findFirst({ where: { is_trial_default: true } })) ??
        (await unscopedPrisma.plans.findFirst({ where: { is_public: true }, orderBy: { sort_order: 'asc' } }));
      if (!plan) return reply.code(500).send({ error: 'No plans configured' });

      const password_hash = await hashPassword(body.password);

      // One transaction: a user with no workspace, or a workspace with no owner,
      // are both states nothing else in the system knows how to handle.
      const userId = await unscopedPrisma.$transaction(async (tx) => {
        const user = await tx.users.create({
          data: { name: body.name, email, password_hash },
          select: { id: true },
        });
        if (body.workspace_name) {
          const workspace = await tx.workspaces.create({
            data: {
              name: body.workspace_name,
              slug: await uniqueSlug(body.workspace_name),
              plan_id: plan.id,
              subscription_status: 'trialing',
              trial_ends_at: new Date(Date.now() + 14 * 864e5),
              private_settings: { create: {} },
            },
            select: { id: true },
          });
          await tx.workspace_members.create({
            data: { workspace_id: workspace.id, user_id: user.id, role: 'owner', all_websites: true },
          });
          await tx.users.update({
            where: { id: user.id },
            data: { default_workspace_id: workspace.id },
          });
        }
        return user.id;
      });

      // Outside the transaction: a slow mail server must not roll back a signup.
      void queueVerificationEmail(userId, body.name, email);

      const tokens = await issueSession(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(req, { action: 'auth.signup', targetType: 'user', targetId: userId });
      return reply.code(201).send(tokens);
    },
  );

  // ── Email verification ────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/verify-email',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(z.object({ token: z.string().min(10).max(200) }), req.body, reply);
      if (!body) return;

      const row = await unscopedPrisma.user_tokens.findUnique({
        where: { token_hash: hashToken(body.token) },
        select: { id: true, user_id: true, kind: true, expires_at: true, consumed_at: true },
      });
      if (!row || row.kind !== 'email_verify' || row.consumed_at || row.expires_at < new Date()) {
        return reply.code(400).send({ error: 'That link is invalid or has expired', code: 'bad_token' });
      }

      await unscopedPrisma.$transaction([
        unscopedPrisma.user_tokens.update({ where: { id: row.id }, data: { consumed_at: new Date() } }),
        unscopedPrisma.users.update({
          where: { id: row.user_id },
          data: { email_verified_at: new Date() },
        }),
      ]);
      await audit(req, { action: 'auth.email_verified', targetType: 'user', targetId: row.user_id });
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/v1/auth/resend-verification',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = await unscopedPrisma.users.findUniqueOrThrow({
        where: { id: req.auth!.userId },
        select: { id: true, name: true, email: true, email_verified_at: true },
      });
      if (user.email_verified_at) return reply.send({ ok: true, already_verified: true });
      // Invalidate any outstanding link so only the newest one works.
      await unscopedPrisma.user_tokens.updateMany({
        where: { user_id: user.id, kind: 'email_verify', consumed_at: null },
        data: { consumed_at: new Date() },
      });
      await queueVerificationEmail(user.id, user.name, user.email);
      return reply.send({ ok: true });
    },
  );

  // ── Login ─────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          email: z.string().email().max(200),
          password: z.string().min(1).max(200),
          // Both optional: the client cannot know whether an account has a second
          // factor until it has offered a correct password, so login is a single
          // round trip for most people and two for the rest.
          totp: z.string().min(4).max(20).optional(),
          recovery_code: z.string().min(4).max(20).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const user = await unscopedPrisma.users.findUnique({
        where: { email: body.email.toLowerCase() },
        select: {
          id: true,
          password_hash: true,
          deleted_at: true,
          totp_enabled: true,
          totp_secret: true,
          totp_last_step: true,
        },
      });
      // One generic message and one code path for "no such user" and "wrong
      // password", so login cannot be used to enumerate accounts.
      if (!user || user.deleted_at || !(await verifyPassword(body.password, user.password_hash))) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      /*
        The second factor, only once the password is known to be right.

        Asking for it earlier — or answering "this account has 2FA" to a wrong
        password — would turn login into an oracle for which accounts are worth
        attacking. Past this line the caller already holds the password, so telling
        them a factor is required gives away nothing they did not have.
      */
      if (user.totp_enabled) {
        const check = await checkSecondFactor(user, body);
        if (!check.ok) {
          if (check.reason === 'missing') {
            return reply
              .code(401)
              .send({ error: 'Enter the code from your authenticator app', code: 'totp_required' });
          }
          return reply.code(401).send({
            error:
              check.reason === 'replayed'
                ? 'That code has already been used. Wait for the next one.'
                : 'That code is not valid',
            code: 'totp_invalid',
          });
        }
        if (check.usedRecoveryCode) {
          // Worth an audit line of its own: a recovery code being spent is either a
          // lost phone or somebody who got hold of the list, and both are things you
          // want to see afterwards with a timestamp against them.
          await audit(req, {
            action: 'auth.recovery_code_used',
            targetType: 'user',
            targetId: user.id,
            details: { remaining: await countUnusedRecoveryCodes(user.id) },
          });
        }
      }

      await unscopedPrisma.users.update({
        where: { id: user.id },
        data: { last_login_at: new Date() },
      });
      const tokens = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return reply.send(tokens);
    },
  );

  // ── Refresh (rotating) ────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(z.object({ refresh_token: z.string().min(10).max(400) }), req.body, reply);
      if (!body) return;

      const presented = hashToken(body.refresh_token);
      const row = await unscopedPrisma.refresh_tokens.findUnique({
        where: { token_hash: presented },
        select: {
          id: true,
          user_id: true,
          session_id: true,
          expires_at: true,
          revoked_at: true,
          user: { select: { email: true, deleted_at: true } },
        },
      });
      if (!row || row.expires_at < new Date() || row.user.deleted_at) {
        return reply.code(401).send({ error: 'Invalid refresh token' });
      }

      if (row.revoked_at) {
        // Reuse of an already-rotated token. Either the token was stolen and
        // replayed, or a client raced itself. Both are handled by killing the
        // whole family: the legitimate user re-logs in, the thief gets nothing.
        await unscopedPrisma.refresh_tokens.updateMany({
          where: { session_id: row.session_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        req.log.warn({ userId: row.user_id, sessionId: row.session_id }, 'refresh token reuse — family revoked');
        return reply.code(401).send({ error: 'Session expired', code: 'token_reuse' });
      }

      const { token: next, hash } = generateRefreshToken();
      await unscopedPrisma.$transaction([
        unscopedPrisma.refresh_tokens.update({
          where: { id: row.id },
          data: { revoked_at: new Date(), last_used_at: new Date() },
        }),
        unscopedPrisma.refresh_tokens.create({
          data: {
            user_id: row.user_id,
            session_id: row.session_id, // same family
            token_hash: hash,
            ip: req.ip,
            user_agent: req.headers['user-agent']?.slice(0, 400) ?? null,
            expires_at: refreshExpiryDate(),
          },
        }),
      ]);

      return reply.send({
        access_token: signAccessToken({ sub: row.user_id, typ: 'user', email: row.user.email }),
        refresh_token: next,
      });
    },
  );

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const body = parseBody(
      z.object({ refresh_token: z.string().max(400).optional(), all: z.boolean().optional() }),
      req.body,
      reply,
    );
    if (!body) return;
    if (body.refresh_token) {
      const row = await unscopedPrisma.refresh_tokens.findUnique({
        where: { token_hash: hashToken(body.refresh_token) },
        select: { session_id: true },
      });
      if (row) {
        await unscopedPrisma.refresh_tokens.updateMany({
          where: { session_id: row.session_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
      }
    }
    return reply.send({ ok: true });
  });

  // ── Password reset ────────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(z.object({ email: z.string().email().max(200) }), req.body, reply);
      if (!body) return;

      const user = await unscopedPrisma.users.findUnique({
        where: { email: body.email.toLowerCase() },
        select: { id: true, name: true, email: true, deleted_at: true },
      });

      // ALWAYS 200, whether or not the account exists. Unlike login (reached from
      // a form by someone who knows if they have an account), this endpoint can be
      // called with arbitrary addresses, so a differing response is an account
      // enumeration oracle.
      if (user && !user.deleted_at) {
        const { token, hash } = generateOpaqueToken();
        await unscopedPrisma.user_tokens.create({
          data: {
            user_id: user.id,
            kind: 'password_reset',
            token_hash: hash,
            expires_at: new Date(Date.now() + RESET_TTL_HOURS * 3600_000),
          },
        });
        void sendEmail({
          to: user.email,
          template: 'password_reset',
          vars: { name: user.name, url: `${settings().urls.app}/reset?token=${token}` },
          relatedType: 'user',
          relatedId: user.id,
        });
      }
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/v1/auth/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({ token: z.string().min(10).max(200), password: passwordField }),
        req.body,
        reply,
      );
      if (!body) return;

      const row = await unscopedPrisma.user_tokens.findUnique({
        where: { token_hash: hashToken(body.token) },
        select: {
          id: true,
          user_id: true,
          kind: true,
          expires_at: true,
          consumed_at: true,
          user: { select: { name: true, email: true } },
        },
      });
      if (!row || row.kind !== 'password_reset' || row.consumed_at || row.expires_at < new Date()) {
        return reply.code(400).send({ error: 'That link is invalid or has expired', code: 'bad_token' });
      }

      const password_hash = await hashPassword(body.password);
      await unscopedPrisma.$transaction([
        unscopedPrisma.user_tokens.update({ where: { id: row.id }, data: { consumed_at: new Date() } }),
        unscopedPrisma.users.update({ where: { id: row.user_id }, data: { password_hash } }),
        // Every other session dies. A reset is the action someone takes when they
        // think their account is compromised; leaving the attacker's session alive
        // would defeat the point.
        unscopedPrisma.refresh_tokens.updateMany({
          where: { user_id: row.user_id, revoked_at: null },
          data: { revoked_at: new Date() },
        }),
      ]);
      void sendEmail({
        to: row.user.email,
        template: 'password_changed',
        vars: { name: row.user.name },
        relatedType: 'user',
        relatedId: row.user_id,
      });
      await audit(req, { action: 'auth.password_reset', targetType: 'user', targetId: row.user_id });
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/v1/auth/change-password',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({ current_password: z.string().min(1).max(200), password: passwordField }),
        req.body,
        reply,
      );
      if (!body) return;

      const user = await unscopedPrisma.users.findUniqueOrThrow({
        where: { id: req.auth!.userId },
        select: { id: true, name: true, email: true, password_hash: true },
      });
      if (!(await verifyPassword(body.current_password, user.password_hash))) {
        return reply.code(403).send({ error: 'Current password is incorrect' });
      }

      const password_hash = await hashPassword(body.password);
      await unscopedPrisma.$transaction([
        unscopedPrisma.users.update({ where: { id: user.id }, data: { password_hash } }),
        unscopedPrisma.refresh_tokens.updateMany({
          where: { user_id: user.id, revoked_at: null },
          data: { revoked_at: new Date() },
        }),
      ]);
      void sendEmail({
        to: user.email,
        template: 'password_changed',
        vars: { name: user.name },
        relatedType: 'user',
        relatedId: user.id,
      });
      await audit(req, { action: 'auth.password_changed', targetType: 'user', targetId: user.id });

      // The caller just revoked their own session too; hand back a fresh one so
      // they are not bounced to the login screen for succeeding.
      const tokens = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return reply.send(tokens);
    },
  );

  // ── Slug availability (used live by the workspace step of the wizard) ─────
  app.get(
    '/api/v1/auth/slug-available',
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const slug = (req.query as { slug?: string }).slug ?? '';
      return reply.send({ slug, available: await slugIsAvailable(slug.toLowerCase()) });
    },
  );
}
