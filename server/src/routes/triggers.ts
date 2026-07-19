import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
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

// Include all four child tables so a trigger can be assembled in one query.
const withChildren = {
  trigger_actions: true,
  trigger_events: true,
  trigger_behaviors: true,
  trigger_platforms: true,
} as const;

// Each trigger has exactly one row per child table (writeChildren replaces on
// every write), so we surface the first (or null) under the legacy key names.
function assemble(t: Record<string, unknown>): Record<string, unknown> {
  const {
    trigger_actions,
    trigger_events,
    trigger_behaviors,
    trigger_platforms,
    ...rest
  } = t as {
    trigger_actions: unknown[];
    trigger_events: unknown[];
    trigger_behaviors: unknown[];
    trigger_platforms: unknown[];
  } & Record<string, unknown>;
  return {
    ...rest,
    actions: trigger_actions[0] ?? null,
    events: trigger_events[0] ?? null,
    behaviors: trigger_behaviors[0] ?? null,
    platforms: trigger_platforms[0] ?? null,
  };
}

async function writeChildren(
  tx: Prisma.TransactionClient,
  triggerId: string,
  body: TriggerInput,
): Promise<void> {
  // One row per child table; replace on update.
  await tx.trigger_actions.deleteMany({ where: { trigger_id: triggerId } });
  await tx.trigger_events.deleteMany({ where: { trigger_id: triggerId } });
  await tx.trigger_behaviors.deleteMany({ where: { trigger_id: triggerId } });
  await tx.trigger_platforms.deleteMany({ where: { trigger_id: triggerId } });

  const a = body.actions;
  await tx.trigger_actions.create({
    data: {
      trigger_id: triggerId,
      show_message: a.show_message,
      message_content: a.message_content,
      localized_messages: a.localized_messages as object,
      open_chatbox: a.open_chatbox,
      play_sound: a.play_sound,
    },
  });
  const e = body.events;
  await tx.trigger_events.create({
    data: {
      trigger_id: triggerId,
      on_leave_intent: e.on_leave_intent,
      on_click_link: e.on_click_link,
      click_selectors: e.click_selectors,
      on_pages: e.on_pages,
      page_urls: e.page_urls,
      on_url_parameters: e.on_url_parameters,
      url_parameters: e.url_parameters as object,
      after_delay: e.after_delay,
      delay_seconds: e.delay_seconds,
    },
  });
  const b = body.behaviors;
  await tx.trigger_behaviors.create({
    data: {
      trigger_id: triggerId,
      show_as_website: b.show_as_website,
      execute_if_online: b.execute_if_online,
      execute_on_first_visit: b.execute_on_first_visit,
      execute_if_no_other_trigger: b.execute_if_no_other_trigger,
      country_restriction: b.country_restriction,
    },
  });
  const p = body.platforms;
  await tx.trigger_platforms.create({
    data: {
      trigger_id: triggerId,
      desktop_enabled: p.desktop_enabled,
      mobile_enabled: p.mobile_enabled,
    },
  });
}

export async function triggerRoutes(app: FastifyInstance): Promise<void> {
  // Public: active triggers for the embed/widget to evaluate.
  app.get('/api/triggers/active', async (_req, reply) => {
    const triggers = await prisma.triggers.findMany({
      where: { is_active: true },
      orderBy: { priority: 'asc' },
      select: { id: true, name: true, identifier: true, priority: true, ...withChildren },
    });
    return reply.send({ triggers: triggers.map((t) => assemble(t as Record<string, unknown>)) });
  });

  // Public: record that a trigger fired (analytics). Rate-limited.
  app.post('/api/triggers/:id/fire', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.triggers.updateMany({ where: { id }, data: { fire_count: { increment: 1 } } });
    return reply.send({ ok: true });
  });

  // Admin: full list with children + analytics counters.
  app.get('/api/triggers', { preHandler: requireAdmin }, async (_req, reply) => {
    const triggers = await prisma.triggers.findMany({
      orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
      select: {
        id: true,
        name: true,
        identifier: true,
        is_active: true,
        priority: true,
        fire_count: true,
        conversation_count: true,
        created_at: true,
        updated_at: true,
        ...withChildren,
      },
    });
    return reply.send({ triggers: triggers.map((t) => assemble(t as Record<string, unknown>)) });
  });

  app.post('/api/triggers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(triggerBody, req.body, reply);
    if (!body) return;
    const dupe = await prisma.triggers.findUnique({
      where: { identifier: body.identifier },
      select: { id: true },
    });
    if (dupe) return reply.code(409).send({ error: 'That identifier already exists' });

    const id = await prisma.$transaction(async (tx) => {
      const t = await tx.triggers.create({
        data: {
          name: body.name,
          identifier: body.identifier,
          is_active: body.is_active,
          priority: body.priority,
        },
        select: { id: true },
      });
      await writeChildren(tx, t.id, body);
      return t.id;
    });
    await audit(req, { action: 'trigger.create', targetType: 'trigger', targetId: id });
    return reply.code(201).send({ id });
  });

  app.put('/api/triggers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(triggerBody, req.body, reply);
    if (!body) return;
    const exists = await prisma.triggers.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Not found' });

    await prisma.$transaction(async (tx) => {
      await tx.triggers.update({
        where: { id },
        data: {
          name: body.name,
          identifier: body.identifier,
          is_active: body.is_active,
          priority: body.priority,
          updated_at: new Date(),
        },
      });
      await writeChildren(tx, id, body);
    });
    await audit(req, { action: 'trigger.update', targetType: 'trigger', targetId: id });
    return reply.send({ ok: true });
  });

  app.delete('/api/triggers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await prisma.triggers.deleteMany({ where: { id } });
    if (deleted.count === 0) return reply.code(404).send({ error: 'Not found' });
    await audit(req, { action: 'trigger.delete', targetType: 'trigger', targetId: id });
    return reply.send({ ok: true });
  });
}
