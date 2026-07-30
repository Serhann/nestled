import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// Redeeming a handover code precedes any workspace context — the code is what
// establishes which workspace and which user this session is for.
// eslint-disable-next-line no-restricted-imports -- resolves the tenant, so precedes it
import { unscopedPrisma } from '../../db/unscoped.js';
import { hashToken, signAccessToken } from '../../auth/tokens.js';
import { parseBody } from '../../lib/validate.js';

/**
 * Redeeming a handover code, on the CUSTOMER plane.
 *
 * This lives here rather than under `/platform` on purpose: it is called by the customer
 * app, from the customer origin, by a tab that has no staff session — the operator's staff
 * token stays in the ops panel's own storage on its own origin. All this tab has is a code
 * from a URL fragment.
 *
 * Unauthenticated, therefore, and safe to be: the code is single use, expires in sixty
 * seconds, is stored hashed, and buys exactly the session an operator already created with
 * a recorded reason. Nothing here mints authority — it hands over authority that already
 * exists, once.
 *
 * ── The single-use guarantee ───────────────────────────────────────────────────
 *
 * `updateMany` with `claimed_at: null` in the WHERE is the whole mechanism. Two tabs
 * racing the same code both run the same conditional UPDATE; Postgres serialises them, the
 * first matches one row and the second matches none. Reading the row and then writing it
 * would have a window between the two where both see "unclaimed".
 */
export async function impersonationV1Routes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/impersonation/claim',
    // Tight, and not really about abuse: a valid code is used once within a minute, so
    // anything past a handful of attempts from one address is somebody guessing.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(z.object({ code: z.string().min(10).max(200) }), req.body, reply);
      if (!body) return;

      const now = new Date();
      const hash = hashToken(body.code);

      // One statement decides it. Everything the response needs is read afterwards, from
      // a row we now know we own.
      const claimed = await unscopedPrisma.impersonation_sessions.updateMany({
        where: {
          claim_code_hash: hash,
          claimed_at: null,
          claim_expires_at: { gt: now },
          ended_at: null,
          expires_at: { gt: now },
        },
        data: { claimed_at: now },
      });

      if (claimed.count === 0) {
        // Deliberately one message for every failure — expired, already used, ended,
        // never existed. A tab that cannot tell them apart is a tab that cannot be used
        // to probe which codes exist, and the operator's own panel already knows what it
        // just issued.
        return reply.code(400).send({
          error: 'This link has already been used or has expired. Start the session again from the ops panel.',
          code: 'claim_invalid',
        });
      }

      const session = await unscopedPrisma.impersonation_sessions.findFirstOrThrow({
        where: { claim_code_hash: hash },
        select: {
          id: true,
          workspace_id: true,
          platform_user_id: true,
          scope: true,
          reason: true,
          expires_at: true,
          target_user_id: true,
          workspace: { select: { name: true, slug: true } },
        },
      });

      // The target must still be usable. A session created for somebody who was deleted in
      // the intervening minute would mint a token that authenticates and then 404s on
      // every route, which reads as a product bug rather than a stale link.
      const target = session.target_user_id
        ? await unscopedPrisma.users.findUnique({
            where: { id: session.target_user_id },
            select: { id: true, email: true, name: true, deleted_at: true },
          })
        : null;
      if (!target || target.deleted_at) {
        return reply.code(400).send({
          error: 'That account is no longer available.',
          code: 'target_unavailable',
        });
      }

      /**
       * The token's lifetime is what remains of the SESSION, not a fresh TTL.
       *
       * Redeeming a code five minutes after it was issued must not extend the window an
       * operator agreed to. Seconds rather than minutes because the remainder is rarely a
       * whole number of them, and rounding up is how a 30-minute cap becomes 31.
       */
      const remainingSeconds = Math.max(1, Math.floor((session.expires_at.getTime() - now.getTime()) / 1000));
      const accessToken = signAccessToken(
        {
          sub: target.id,
          typ: 'user',
          email: target.email,
          act: {
            pu: session.platform_user_id,
            sid: session.id,
            ws: session.workspace_id,
            scope: session.scope as 'read_only' | 'full',
          },
        },
        `${remainingSeconds}s`,
      );

      // The code is spent; drop the hash so a database backup does not carry a value that
      // once was one. `claimed_at` keeps the record that it was used.
      await unscopedPrisma.impersonation_sessions.update({
        where: { id: session.id },
        data: { claim_code_hash: null },
      });

      return reply.send({
        access_token: accessToken,
        // Named, so no client goes looking. An impersonated session cannot be refreshed:
        // it expires and that is the end of it.
        refresh_token: null,
        expires_at: session.expires_at.toISOString(),
        session: {
          scope: session.scope,
          reason: session.reason,
          workspace: { id: session.workspace_id, name: session.workspace.name, slug: session.workspace.slug },
          target: { id: target.id, name: target.name, email: target.email },
        },
      });
    },
  );
}
