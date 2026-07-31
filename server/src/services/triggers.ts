import { z } from 'zod';

/**
 * Trigger (campaign) configuration.
 *
 * The four child tables of the pre-tenant design (trigger_actions, _events, _behaviors,
 * _platforms) are four JSONB columns now. They were 1:1 with the trigger, nothing ever
 * filtered on their individual columns, and every write deleted and recreated all four
 * rows — a join table's cost with none of its benefit. What a JSONB column loses is the
 * database's opinion about its shape, so these schemas are that opinion: unknown keys are
 * rejected, and the column stays a record rather than becoming a junk drawer.
 *
 * ── Why this is a module of its own ──────────────────────────────────────────
 *
 * It sat inside routes/v1/automation.ts, which imports prisma — so the only way to check a
 * payload against it was to boot a server with a database. The dashboard's campaigns
 * screen consequently spent its whole life sending four blobs of invented field names
 * (`{ type, message }` for actions, `{ type, seconds }` for events) that this schema
 * rejected outright, and nothing anywhere could catch it short of a human reading a 400 in
 * the network tab. Here it is importable on its own, and `test/triggerSchema.test.ts`
 * parses the exact payloads the dashboard sends without needing Postgres.
 *
 * The same field names are declared client-side in `src/lib/api/automation.ts`. That
 * duplication is what the test exists to police.
 */

export const triggerActions = z
  .object({
    show_message: z.boolean().default(false),
    message_content: z.string().max(2000).nullable().default(null),
    localized_messages: z.record(z.string().max(10), z.string().max(2000)).default({}),
    open_chatbox: z.boolean().default(false),
    play_sound: z.boolean().default(false),
    /**
     * Start a bot flow instead of (or alongside) a canned message. The widget
     * carries the trigger id into conversation creation and the SERVER resolves it
     * to a flow — the widget never learns which flow, let alone its graph.
     */
    start_bot: z.string().uuid().nullable().default(null),
  })
  .strict();

export const triggerEvents = z
  .object({
    on_leave_intent: z.boolean().default(false),
    on_click_link: z.boolean().default(false),
    click_selectors: z.array(z.string().max(200)).max(20).default([]),
    on_pages: z.boolean().default(false),
    page_urls: z.array(z.string().max(500)).max(50).default([]),
    on_url_parameters: z.boolean().default(false),
    url_parameters: z.record(z.string().max(64), z.string().max(200)).default({}),
    after_delay: z.boolean().default(false),
    delay_seconds: z.number().int().min(0).max(3600).default(0),
  })
  .strict();

export const triggerBehaviors = z
  .object({
    show_as_website: z.boolean().default(false),
    execute_if_online: z.boolean().default(false),
    execute_on_first_visit: z.boolean().default(false),
    execute_if_no_other_trigger: z.boolean().default(false),
    country_restriction: z.array(z.string().length(2)).max(50).default([]),
  })
  .strict();

export const triggerPlatforms = z
  .object({
    desktop_enabled: z.boolean().default(true),
    mobile_enabled: z.boolean().default(true),
  })
  .strict();

export const triggerBody = z.object({
  website_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  identifier: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  is_active: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  actions: triggerActions.default(triggerActions.parse({})),
  events: triggerEvents.default(triggerEvents.parse({})),
  behaviors: triggerBehaviors.default(triggerBehaviors.parse({})),
  platforms: triggerPlatforms.default(triggerPlatforms.parse({})),
});
