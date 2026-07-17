import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const triggerBody = z.object({
  name: z.string().min(1).max(120),
  identifier: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  is_active: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  actions: z.object({
    show_message: z.boolean().default(false),
    message_content: z.string().max(2000).nullable().default(null),
    localized_messages: z.record(z.string(), z.string()).default({}),
    open_chatbox: z.boolean().default(false),
    play_sound: z.boolean().default(false),
  }),
  events: z.object({
    on_leave_intent: z.boolean().default(false),
    on_click_link: z.boolean().default(false),
    click_selectors: z.array(z.string()).default([]),
    on_pages: z.boolean().default(false),
    page_urls: z.array(z.string()).default([]),
    on_url_parameters: z.boolean().default(false),
    url_parameters: z.record(z.string(), z.string()).default({}),
    after_delay: z.boolean().default(false),
    delay_seconds: z.number().int().min(0).max(3600).default(0),
  }),
  behaviors: z.object({
    show_as_website: z.boolean().default(false),
    execute_if_online: z.boolean().default(false),
    execute_on_first_visit: z.boolean().default(false),
    execute_if_no_other_trigger: z.boolean().default(false),
    country_restriction: z.array(z.string()).default([]),
  }),
  platforms: z.object({
    desktop_enabled: z.boolean().default(true),
    mobile_enabled: z.boolean().default(true),
  }),
});

type TriggerInput = z.infer<typeof triggerBody>;
type PgClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function writeChildren(client: PgClient, triggerId: string, body: TriggerInput): Promise<void> {
  // One row per child table; replace on update.
  await client.query('DELETE FROM trigger_actions WHERE trigger_id = $1', [triggerId]);
  await client.query('DELETE FROM trigger_events WHERE trigger_id = $1', [triggerId]);
  await client.query('DELETE FROM trigger_behaviors WHERE trigger_id = $1', [triggerId]);
  await client.query('DELETE FROM trigger_platforms WHERE trigger_id = $1', [triggerId]);

  const a = body.actions;
  await client.query(
    `INSERT INTO trigger_actions (trigger_id, show_message, message_content, localized_messages, open_chatbox, play_sound)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [triggerId, a.show_message, a.message_content, a.localized_messages, a.open_chatbox, a.play_sound],
  );
  const e = body.events;
  await client.query(
    `INSERT INTO trigger_events (trigger_id, on_leave_intent, on_click_link, click_selectors, on_pages, page_urls, on_url_parameters, url_parameters, after_delay, delay_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [triggerId, e.on_leave_intent, e.on_click_link, e.click_selectors, e.on_pages, e.page_urls, e.on_url_parameters, e.url_parameters, e.after_delay, e.delay_seconds],
  );
  const b = body.behaviors;
  await client.query(
    `INSERT INTO trigger_behaviors (trigger_id, show_as_website, execute_if_online, execute_on_first_visit, execute_if_no_other_trigger, country_restriction)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [triggerId, b.show_as_website, b.execute_if_online, b.execute_on_first_visit, b.execute_if_no_other_trigger, b.country_restriction],
  );
  const p = body.platforms;
  await client.query(
    `INSERT INTO trigger_platforms (trigger_id, desktop_enabled, mobile_enabled) VALUES ($1,$2,$3)`,
    [triggerId, p.desktop_enabled, p.mobile_enabled],
  );
}

async function assemble(rows: { id: string }[]): Promise<unknown[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const [actions, events, behaviors, platforms] = await Promise.all([
    query(`SELECT * FROM trigger_actions WHERE trigger_id = ANY($1)`, [ids]),
    query(`SELECT * FROM trigger_events WHERE trigger_id = ANY($1)`, [ids]),
    query(`SELECT * FROM trigger_behaviors WHERE trigger_id = ANY($1)`, [ids]),
    query(`SELECT * FROM trigger_platforms WHERE trigger_id = ANY($1)`, [ids]),
  ]);
  const by = <T extends { trigger_id: string }>(r: T[], id: string) => r.find((x) => x.trigger_id === id) ?? null;
  return rows.map((t) => ({
    ...t,
    actions: by(actions.rows as { trigger_id: string }[], t.id),
    events: by(events.rows as { trigger_id: string }[], t.id),
    behaviors: by(behaviors.rows as { trigger_id: string }[], t.id),
    platforms: by(platforms.rows as { trigger_id: string }[], t.id),
  }));
}

export async function triggerRoutes(app: FastifyInstance): Promise<void> {
  // Public: active triggers for the embed/widget to evaluate.
  app.get('/api/triggers/active', async (_req, reply) => {
    const triggers = await query<{ id: string }>(
      `SELECT id, name, identifier, priority FROM triggers WHERE is_active = true ORDER BY priority ASC`,
    );
    return reply.send({ triggers: await assemble(triggers.rows) });
  });

  // Public: record that a trigger fired (analytics). Rate-limited.
  app.post('/api/triggers/:id/fire', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await query('UPDATE triggers SET fire_count = fire_count + 1 WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });

  // Admin: full list with children + analytics counters.
  app.get('/api/triggers', { preHandler: requireAdmin }, async (_req, reply) => {
    const triggers = await query<{ id: string }>(
      `SELECT id, name, identifier, is_active, priority, fire_count, conversation_count, created_at, updated_at
         FROM triggers ORDER BY priority ASC, created_at DESC`,
    );
    return reply.send({ triggers: await assemble(triggers.rows) });
  });

  app.post('/api/triggers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(triggerBody, req.body, reply);
    if (!body) return;
    const dupe = await queryOne('SELECT id FROM triggers WHERE identifier = $1', [body.identifier]);
    if (dupe) return reply.code(409).send({ error: 'That identifier already exists' });

    const id = await withTransaction(async (client) => {
      const t = (
        await client.query<{ id: string }>(
          `INSERT INTO triggers (name, identifier, is_active, priority) VALUES ($1,$2,$3,$4) RETURNING id`,
          [body.name, body.identifier, body.is_active, body.priority],
        )
      ).rows[0]!;
      await writeChildren(client, t.id, body);
      return t.id;
    });
    await audit(req, { action: 'trigger.create', targetType: 'trigger', targetId: id });
    return reply.code(201).send({ id });
  });

  app.put('/api/triggers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(triggerBody, req.body, reply);
    if (!body) return;
    const exists = await queryOne('SELECT id FROM triggers WHERE id = $1', [id]);
    if (!exists) return reply.code(404).send({ error: 'Not found' });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE triggers SET name=$1, identifier=$2, is_active=$3, priority=$4, updated_at=now() WHERE id=$5`,
        [body.name, body.identifier, body.is_active, body.priority, id],
      );
      await writeChildren(client, id, body);
    });
    await audit(req, { action: 'trigger.update', targetType: 'trigger', targetId: id });
    return reply.send({ ok: true });
  });

  app.delete('/api/triggers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await queryOne('DELETE FROM triggers WHERE id = $1 RETURNING id', [id]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'trigger.delete', targetType: 'trigger', targetId: id });
    return reply.send({ ok: true });
  });
}
