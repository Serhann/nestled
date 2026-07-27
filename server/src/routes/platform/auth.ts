import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unscopedPrisma } from '../../db/unscoped.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../lib/totp.js';
import { requirePlatform } from '../../plugins/auth.js';
import { PLATFORM_ROLES } from '../../permissions.js';
import {
  createSession,
  revokeAllSessions,
  revokeSessionByToken,
} from '../../services/platform/sessions.js';
import { platformRead, platformWrite } from './guards.js';

/**
 * Staff authentication.
 *
 * The mechanism is opaque bearer sessions (services/platform/sessions.ts), NOT the
 * customer JWT. Two properties fall out of that and both are load-bearing:
 *
 *   - Revocation is instant. Ending a session is an UPDATE, not a wait for a TTL.
 *   - A customer token can never authenticate here and a staff token can never
 *     authenticate on /api/*, because neither plane knows how to read the other's
 *     credential at all. This is stronger than separate secrets, where the only
 *     thing standing between the planes is that two config values differ. It is
 *     pinned in both directions by test/platformAuth.test.ts.
 *
 * There is no signup and no password reset by email. Staff accounts are created by
 * a superadmin inside the panel (or once, from SEED_PLATFORM_* on an empty table),
 * because a self-serve recovery flow on the vendor plane is a way in for anyone who
 * can read a mailbox.
 */

const loginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  totp: z.string().max(10).optional(),
});

export async function platformAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/platform/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = parseBody(loginBody, req.body, reply);
      if (!body) return;

      const user = await unscopedPrisma.platform_users.findUnique({
        where: { email: body.email.toLowerCase() },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          password_hash: true,
          totp_secret: true,
          totp_enabled: true,
          disabled_at: true,
        },
      });

      // One message and one shape for every failure. The customer login can afford
      // to say "no such account" because the user knows whether they signed up; on
      // the vendor plane, confirming that an address is staff is a gift to whoever
      // is guessing.
      const invalid = () => reply.code(401).send({ error: 'Invalid credentials' });

      if (!user || user.disabled_at) {
        // Still hash something, so a disabled or unknown account does not answer
        // measurably faster than a real one.
        await verifyPassword(body.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');

        // One exception to the deliberately blank failure above: when there is NO
        // staff account at all, say so. Nothing is disclosed — an install with an
        // empty staff table has no panel to protect — and the alternative is an
        // operator staring at "Invalid credentials" for a password that is exactly
        // what they put in the environment, with nothing anywhere to explain that
        // the bootstrap never ran.
        if ((await unscopedPrisma.platform_users.count()) === 0) {
          return reply.code(401).send({
            error:
              'This install has no staff accounts yet. Set SEED_PLATFORM_EMAIL and ' +
              'SEED_PLATFORM_PASSWORD and restart the app — the bootstrap runs only ' +
              'while the table is empty.',
            code: 'no_staff_accounts',
          });
        }
        return invalid();
      }
      if (!(await verifyPassword(body.password, user.password_hash))) return invalid();

      // TOTP is required at LOGIN only once enrolled. An account without a factor
      // can still sign in — it simply gets a read-only session (see guards.ts), so
      // a new hire is never locked out of the panel they were hired to use, and is
      // also never able to change anything before enrolling.
      if (user.totp_enabled && user.totp_secret) {
        if (!body.totp) {
          return reply.code(401).send({ error: 'Second factor required', code: 'totp_required' });
        }
        if (!verifyTotp(user.totp_secret, body.totp)) return invalid();
      }

      const session = await createSession(user.id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      req.platform = { id: user.id, email: user.email, role: user.role as never, sessionId: session.sessionId };
      await audit(req, {
        action: 'platform.login',
        targetType: 'platform_user',
        targetId: user.id,
        details: { totp: user.totp_enabled },
      });

      return reply.send({
        token: session.token,
        expires_at: session.expiresAt.toISOString(),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          totp_enabled: user.totp_enabled,
          // The client renders a persistent "read-only until you enroll" banner
          // from this rather than discovering it from a 403 on the first save.
          can_write: user.totp_enabled,
        },
      });
    },
  );

  app.post('/platform/auth/logout', { preHandler: platformRead }, async (req, reply) => {
    const header = req.headers.authorization ?? '';
    await revokeSessionByToken(header.slice('Bearer '.length).trim());
    await audit(req, { action: 'platform.logout' });
    return reply.send({ ok: true });
  });

  app.get('/platform/me', { preHandler: platformRead }, async (req, reply) => {
    const me = await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { id: req.platform!.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        totp_enabled: true,
        created_at: true,
        sessions: {
          where: { revoked_at: null, expires_at: { gt: new Date() } },
          orderBy: { created_at: 'desc' },
          select: { id: true, ip: true, user_agent: true, created_at: true, expires_at: true },
        },
      },
    });
    return reply.send({
      user: {
        ...me,
        sessions: undefined,
        can_write: me.totp_enabled,
      },
      sessions: me.sessions.map((s) => ({ ...s, current: s.id === req.platform!.sessionId })),
    });
  });

  /**
   * Revoke every other live session for this account. The button behind it is what
   * a staff member reaches for after losing a laptop, so it must not require a
   * second factor they may only have on that laptop.
   */
  app.post('/platform/me/sessions/revoke-others', { preHandler: platformRead }, async (req, reply) => {
    const revoked = await revokeAllSessions(req.platform!.id);
    const current = await createSession(req.platform!.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await audit(req, { action: 'platform.sessions_revoked', details: { count: revoked } });
    return reply.send({ token: current.token, expires_at: current.expiresAt.toISOString(), revoked });
  });

  // ── TOTP enrollment ────────────────────────────────────────────────────────
  /**
   * Begin enrollment: mint a secret and hand back the otpauth URI.
   *
   * The secret is stored immediately but `totp_enabled` stays false, so an
   * abandoned enrollment leaves the account exactly as read-only as it was. This
   * route is the deliberate exception to platformWrite — you cannot present a
   * factor you have not enrolled yet.
   */
  app.post('/platform/me/totp', { preHandler: platformRead }, async (req, reply) => {
    const me = await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { id: req.platform!.id },
      select: { email: true, totp_enabled: true },
    });
    if (me.totp_enabled) {
      // Re-enrolling would silently invalidate the working factor. Requiring an
      // explicit disable first makes losing your only factor a decision.
      return reply.code(409).send({ error: 'A factor is already enrolled', code: 'totp_present' });
    }

    const secret = generateTotpSecret();
    await unscopedPrisma.platform_users.update({
      where: { id: req.platform!.id },
      data: { totp_secret: secret },
    });
    return reply.send({
      secret,
      otpauth_uri: otpauthUri({ secret, account: me.email }),
    });
  });

  /** Confirm enrollment with a live code. Only this flips `totp_enabled`. */
  app.post('/platform/me/totp/verify', { preHandler: platformRead }, async (req, reply) => {
    const body = parseBody(z.object({ code: z.string().min(6).max(10) }), req.body, reply);
    if (!body) return;

    const me = await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { id: req.platform!.id },
      select: { totp_secret: true, totp_enabled: true },
    });
    if (!me.totp_secret) {
      return reply.code(400).send({ error: 'Start enrollment first', code: 'totp_absent' });
    }
    if (!verifyTotp(me.totp_secret, body.code)) {
      return reply.code(400).send({ error: 'That code is not valid', code: 'totp_invalid' });
    }

    await unscopedPrisma.platform_users.update({
      where: { id: req.platform!.id },
      data: { totp_enabled: true },
    });
    await audit(req, { action: 'platform.totp_enrolled', targetType: 'platform_user', targetId: req.platform!.id });
    return reply.send({ ok: true, can_write: true });
  });

  /**
   * Remove a factor. Requires the current code — knowing the password is not
   * enough to strip the control that limits what the password can do.
   */
  app.delete('/platform/me/totp', { preHandler: platformRead }, async (req, reply) => {
    const body = parseBody(z.object({ code: z.string().min(6).max(10) }), req.body, reply);
    if (!body) return;
    const me = await unscopedPrisma.platform_users.findUniqueOrThrow({
      where: { id: req.platform!.id },
      select: { totp_secret: true },
    });
    if (!me.totp_secret || !verifyTotp(me.totp_secret, body.code)) {
      return reply.code(400).send({ error: 'That code is not valid', code: 'totp_invalid' });
    }
    await unscopedPrisma.platform_users.update({
      where: { id: req.platform!.id },
      data: { totp_secret: null, totp_enabled: false },
    });
    await audit(req, { action: 'platform.totp_removed', targetType: 'platform_user', targetId: req.platform!.id });
    return reply.send({ ok: true, can_write: false });
  });

  // ── Staff accounts (superadmin only) ───────────────────────────────────────
  app.get('/platform/users', { preHandler: requirePlatform('superadmin') }, async (_req, reply) => {
    const users = await unscopedPrisma.platform_users.findMany({
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        totp_enabled: true,
        disabled_at: true,
        created_at: true,
        _count: { select: { sessions: true, impersonations: true } },
      },
    });
    return reply.send({ users });
  });

  app.post('/platform/users', { preHandler: platformWrite('superadmin') }, async (req, reply) => {
    const body = parseBody(
      z.object({
        email: z.string().email().max(200),
        name: z.string().min(1).max(120),
        password: z.string().min(12).max(200),
        role: z.enum(PLATFORM_ROLES),
      }),
      req.body,
      reply,
    );
    if (!body) return;

    const email = body.email.toLowerCase();
    if (await unscopedPrisma.platform_users.findUnique({ where: { email }, select: { id: true } })) {
      return reply.code(409).send({ error: 'That address already has a staff account' });
    }
    const created = await unscopedPrisma.platform_users.create({
      data: {
        email,
        name: body.name,
        role: body.role,
        password_hash: await hashPassword(body.password),
      },
      select: { id: true, email: true, name: true, role: true, created_at: true },
    });
    await audit(req, {
      action: 'platform.user_created',
      targetType: 'platform_user',
      targetId: created.id,
      details: { email, role: body.role },
    });
    return reply.code(201).send({ user: created });
  });

  app.patch('/platform/users/:id', { preHandler: platformWrite('superadmin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        role: z.enum(PLATFORM_ROLES).optional(),
        disabled: z.boolean().optional(),
        name: z.string().min(1).max(120).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;

    // Locking yourself out of the only superadmin account is unrecoverable without
    // database access, so the two ways to do it are refused here.
    if (id === req.platform!.id && (body.disabled === true || (body.role && body.role !== 'superadmin'))) {
      return reply.code(400).send({ error: 'You cannot demote or disable your own account' });
    }

    const updated = await unscopedPrisma.platform_users.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabled_at: body.disabled ? new Date() : null } : {}),
      },
      select: { id: true, email: true, name: true, role: true, disabled_at: true },
    });

    // A demotion or a disable that leaves live sessions behind is not a demotion.
    if (body.role !== undefined || body.disabled === true) await revokeAllSessions(id);

    await audit(req, {
      action: 'platform.user_updated',
      targetType: 'platform_user',
      targetId: id,
      details: { ...body },
    });
    return reply.send({ user: updated });
  });
}
