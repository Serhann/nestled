import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { env } from '../env.js';
import { requireAgent } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { isPushEnabled } from '../services/push.js';

const subscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

const unsubscribeBody = z.object({ endpoint: z.string().url() });

const resubscribeBody = z.object({
  old_endpoint: z.string().url().nullable(),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  // The VAPID public key is safe to expose — the client needs it as the
  // applicationServerKey when subscribing. Also reports whether push is on.
  app.get('/api/push/public-key', async (_req, reply) => {
    return reply.send({ enabled: isPushEnabled(), publicKey: env.VAPID_PUBLIC_KEY ?? null });
  });

  // Store (or refresh) this device's subscription for the authenticated agent.
  // Keyed on endpoint so re-subscribing the same device upserts.
  app.post('/api/push/subscribe', { preHandler: requireAgent }, async (req, reply) => {
    const body = parseBody(subscribeBody, req.body, reply);
    if (!body) return;
    const { endpoint, keys } = body.subscription;
    await query(
      `INSERT INTO push_subscriptions (agent_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET agent_id = EXCLUDED.agent_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             last_seen = now()`,
      [req.agent!.id, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] ?? null],
    );
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/push/unsubscribe', { preHandler: requireAgent }, async (req, reply) => {
    const body = parseBody(unsubscribeBody, req.body, reply);
    if (!body) return;
    // Scope the delete to this agent so one agent can't remove another's device.
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND agent_id = $2', [
      body.endpoint,
      req.agent!.id,
    ]);
    return reply.send({ ok: true });
  });

  // Called by the service worker on `pushsubscriptionchange` (no JWT available
  // in that context). We re-attribute by the OLD endpoint: if we know which
  // agent owned it, move the subscription to the new endpoint/keys. If the old
  // endpoint is unknown, we can't attribute it, so we drop it silently.
  app.post('/api/push/resubscribe', async (req, reply) => {
    const body = parseBody(resubscribeBody, req.body, reply);
    if (!body) return;
    if (!body.old_endpoint) return reply.code(204).send();

    const owner = await query<{ agent_id: string }>(
      'SELECT agent_id FROM push_subscriptions WHERE endpoint = $1',
      [body.old_endpoint],
    );
    const agentId = owner.rows[0]?.agent_id;
    if (!agentId) return reply.code(204).send();

    const { endpoint, keys } = body.subscription;
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [body.old_endpoint]);
    await query(
      `INSERT INTO push_subscriptions (agent_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET agent_id = EXCLUDED.agent_id, p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth, last_seen = now()`,
      [agentId, endpoint, keys.p256dh, keys.auth],
    );
    return reply.send({ ok: true });
  });
}
