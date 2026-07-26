import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWorkspace, can, canOnWebsite } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { COPY_KEYS, DEFAULT_COPY } from '../../lib/widgetCopy.js';
import { generateOpaqueToken } from '../../auth/tokens.js';
// Plan gating reads the shared plan catalog.
// eslint-disable-next-line no-restricted-imports -- shared plan catalog
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * Website settings (public-safe), business hours, and workspace private settings.
 *
 * The public/private split is physical, not a naming convention: `website_settings`
 * is what the anonymous widget boot route reads, so a secret must never be added to
 * it. Anything secret lives in `workspace_private_settings` or on `websites`, both
 * reachable only from capability-gated routes.
 */

const themeBody = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  color_mode: z.enum(['light', 'dark', 'auto']).optional(),
  radius_px: z.number().int().min(0).max(40).optional(),
  font_family: z.string().max(60).optional(),
  position: z.enum(['left', 'right']).optional(),
  offset_x: z.number().int().min(0).max(200).optional(),
  offset_y: z.number().int().min(0).max(200).optional(),
  launcher_style: z.enum(['bubble', 'pill', 'custom_icon']).optional(),
  show_branding: z.boolean().optional(),
});

const behaviorBody = z.object({
  ai_enabled: z.boolean().optional(),
  ai_response_mode: z.enum(['off', 'first_message', 'when_no_agent_online', 'always']).optional(),
  system_prompt: z.string().max(8000).nullable().optional(),
  ai_extra_rules: z.string().max(4000).nullable().optional(),
  pre_chat_enabled: z.boolean().optional(),
  pre_chat_fields: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox']).default('text'),
        required: z.boolean().default(false),
        placeholder: z.string().max(120).default(''),
        options: z.array(z.string().max(80)).max(20).optional(),
        /** Maps an answer onto the visitor's name/email instead of a magic field name. */
        maps_to: z.enum(['name', 'email', 'phone']).nullable().optional(),
      }),
    )
    .max(12)
    .optional(),
  auto_welcome_enabled: z.boolean().optional(),
  auto_welcome_message: z.string().max(1000).nullable().optional(),
  auto_welcome_delay: z.number().int().min(0).max(300).optional(),
  file_upload_enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  live_view_enabled: z.boolean().optional(),
  transcript_email_enabled: z.boolean().optional(),
  reset_after_resolve: z.boolean().optional(),
  starters_enabled: z.boolean().optional(),
  rating_tags: z.array(z.string().max(60)).max(10).optional(),
});

/**
 * Copy overrides. The key set is CLOSED — an unrecognised key is a 400 rather than
 * a string that silently never renders, which is the failure mode that wastes an
 * afternoon.
 */
const copyBody = z.record(z.string(), z.string().max(1000)).refine(
  (rec) => Object.keys(rec).every((k) => (COPY_KEYS as string[]).includes(k)),
  { message: 'Unknown copy key' },
);

const hoursBody = z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().max(60).optional(),
  rules: z
    .array(
      z.object({
        dow: z.number().int().min(0).max(6),
        intervals: z.array(z.tuple([z.string().max(5), z.string().max(5)])).max(4),
      }),
    )
    .max(7)
    .optional(),
  holidays: z.array(z.object({ date: z.string().max(10), label: z.string().max(80).optional() })).max(60).optional(),
  offline_behavior: z.enum(['collect_email', 'message_only', 'hide_widget', 'bot_flow']).optional(),
});

export async function settingsV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/w/:workspaceId/websites/:websiteId/settings',
    { preHandler: [requireWorkspace, canOnWebsite('website:read')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const [settings, hours, website] = await Promise.all([
        req.db.website_settings.findUnique({ where: { website_id: websiteId } }),
        req.db.website_business_hours.findUnique({ where: { website_id: websiteId } }),
        req.db.websites.findUnique({
          where: { id: websiteId },
          select: {
            id: true,
            name: true,
            public_key: true,
            primary_domain: true,
            allowed_domains: true,
            enforce_domains: true,
            // Whether a signing secret EXISTS is safe to report; the value is not.
            identity_secret: true,
          },
        }),
      ]);
      if (!settings || !website) return reply.code(404).send({ error: 'Not found' });

      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { allow_remove_branding: true, allow_live_view: true },
      });

      return reply.send({
        website: { ...website, identity_secret: undefined, has_identity_secret: Boolean(website.identity_secret) },
        settings,
        hours,
        // The defaults the stored overrides sit on top of. Sent so the copy editor
        // can show each default as a placeholder without shipping a second copy of
        // this table to the client, which would drift the first time one is
        // reworded.
        copy_defaults: DEFAULT_COPY,
        // The client renders a locked control rather than hiding the feature —
        // hiding it sells nothing.
        plan_features: { remove_branding: plan.allow_remove_branding, live_view: plan.allow_live_view },
      });
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId/websites/:websiteId/settings',
    { preHandler: [requireWorkspace, canOnWebsite('website_settings:update')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const body = parseBody(
        themeBody.merge(behaviorBody).extend({ copy: copyBody.optional() }),
        req.body,
        reply,
      );
      if (!body) return;

      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { allow_remove_branding: true, allow_live_view: true },
      });

      const data: Record<string, unknown> = { ...body };
      // Plan gates are applied HERE, not trusted from the client: a request that
      // sets show_branding=false on a plan without the entitlement is ignored, not
      // rejected, so a stale UI cannot get stuck failing to save.
      if (body.show_branding === false && !plan.allow_remove_branding) data.show_branding = true;
      if (body.live_view_enabled === true && !plan.allow_live_view) data.live_view_enabled = false;

      try {
        const settings = await req.db.website_settings.update({
          where: { website_id: websiteId },
          data: data as never,
        });
        await audit(req, {
          action: 'website_settings.updated',
          targetType: 'website',
          targetId: websiteId,
          details: { fields: Object.keys(body) },
        });
        return reply.send({ settings });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId/websites/:websiteId/hours',
    { preHandler: [requireWorkspace, canOnWebsite('hours:write')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const body = parseBody(hoursBody, req.body, reply);
      if (!body) return;
      try {
        const hours = await req.db.website_business_hours.update({
          where: { website_id: websiteId },
          data: body as never,
        });
        return reply.send({ hours });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  /**
   * Rotate the HMAC secret a customer's server uses to sign visitor attributes.
   *
   * Returned exactly ONCE, on creation. Rotating invalidates every token the host
   * is currently signing, so the response says so plainly rather than letting the
   * customer discover it from a silently-empty visitor card.
   */
  app.post(
    '/api/v1/w/:workspaceId/websites/:websiteId/identity-secret',
    { preHandler: [requireWorkspace, can('integration:manage')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const { token } = generateOpaqueToken(32);
      try {
        await req.db.websites.update({ where: { id: websiteId }, data: { identity_secret: token } });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
      await audit(req, {
        action: 'website.identity_secret_rotated',
        targetType: 'website',
        targetId: websiteId,
      });
      return reply.send({
        secret: token,
        warning: 'Tokens signed with the previous secret stop being accepted immediately.',
      });
    },
  );

  // ── Workspace private settings (integrations) ──────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/integrations',
    { preHandler: [requireWorkspace, can('integration:manage')] },
    async (req, reply) => {
      const row = await req.db.workspace_private_settings.findUnique({
        where: { workspace_id: req.auth!.workspace!.id },
      });
      // The webhook URL contains a shared secret in its path, so only its presence
      // is reported. An agent asking "is Discord on?" does not need the credential.
      return reply.send({
        integrations: {
          discord_webhook_enabled: row?.discord_webhook_enabled ?? false,
          has_discord_webhook: Boolean(row?.discord_webhook_url),
          discord_notify_new_chat: row?.discord_notify_new_chat ?? true,
          discord_notify_new_message: row?.discord_notify_new_message ?? false,
        },
      });
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId/integrations',
    { preHandler: [requireWorkspace, can('integration:manage')] },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          discord_webhook_url: z.string().url().max(500).nullable().optional(),
          discord_webhook_enabled: z.boolean().optional(),
          discord_notify_new_chat: z.boolean().optional(),
          discord_notify_new_message: z.boolean().optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;
      const workspaceId = req.auth!.workspace!.id;
      await req.db.workspace_private_settings.upsert({
        where: { workspace_id: workspaceId },
        create: { workspace_id: workspaceId, ...body } as never,
        update: body as never,
      });
      await audit(req, { action: 'integrations.updated', details: { fields: Object.keys(body) } });
      return reply.send({ ok: true });
    },
  );

  // ── Usage & audit ─────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/usage',
    { preHandler: [requireWorkspace, can('billing:read')] },
    async (req, reply) => {
      const counters = await req.db.usage_counters.findMany({
        orderBy: { period_start: 'desc' },
        take: 60,
      });
      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
      });
      return reply.send({
        // BigInt does not survive JSON, so it is narrowed here rather than at some
        // serializer boundary where the failure would be a 500 with no clue.
        counters: counters.map((c) => ({ ...c, value: Number(c.value) })),
        limits: {
          conversations_month: plan.max_conversations_month,
          ai_replies_month: plan.max_ai_replies_month,
          storage_mb: plan.storage_mb,
          seats: plan.max_seats,
          websites: plan.max_websites,
        },
      });
    },
  );

  app.get(
    '/api/v1/w/:workspaceId/audit',
    { preHandler: [requireWorkspace, can('audit:read')] },
    async (req, reply) => {
      const entries = await req.db.audit_log.findMany({
        orderBy: { created_at: 'desc' },
        take: 200,
      });
      return reply.send({ entries });
    },
  );
}
