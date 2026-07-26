import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
// Push subscriptions belong to a USER, not a workspace — one device serves every
// workspace they are a member of.
// eslint-disable-next-line no-restricted-imports -- push devices are user-scoped
import { unscopedPrisma } from '../../db/unscoped.js';
import { requireAuth } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { isPushEnabled } from '../../services/push.js';

/**
 * Web Push subscription management.
 *
 * Subscriptions hang off the USER, not the workspace: an agent's phone should
 * receive notifications for every workspace they work in, and re-subscribing per
 * workspace would mean N registrations for one device.
 */
export async function pushV1Routes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/push/public-key', async (_req, reply) =>
    reply.send({ enabled: isPushEnabled(), public_key: env.VAPID_PUBLIC_KEY ?? null }),
  );

  app.post('/api/v1/push/subscribe', { preHandler: requireAuth }, async (req, reply) => {
    const body = parseBody(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
      }),
      req.body,
      reply,
    );
    if (!body) return;

    // Upsert on the endpoint: a browser re-issues the same endpoint on every call,
    // and it may have previously belonged to another user on a shared machine.
    await unscopedPrisma.push_subscriptions.upsert({
      where: { endpoint: body.endpoint },
      create: {
        user_id: req.auth!.userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: req.headers['user-agent']?.slice(0, 400) ?? null,
      },
      update: {
        user_id: req.auth!.userId,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        last_seen: new Date(),
      },
    });
    return reply.send({ ok: true });
  });

  app.post('/api/v1/push/unsubscribe', { preHandler: requireAuth }, async (req, reply) => {
    const body = parseBody(z.object({ endpoint: z.string().max(1000) }), req.body, reply);
    if (!body) return;
    // Scoped to the caller: one user must not be able to unsubscribe another's device.
    await unscopedPrisma.push_subscriptions.deleteMany({
      where: { endpoint: body.endpoint, user_id: req.auth!.userId },
    });
    return reply.send({ ok: true });
  });
}
