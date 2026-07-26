import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
// Creating a workspace happens before one exists, and the plan catalog is
// reference data shared by every tenant. Every OTHER query in this file goes
// through req.db.
// eslint-disable-next-line no-restricted-imports -- workspace creation + plan catalog
import { unscopedPrisma } from '../../db/unscoped.js';
import { requireAuth, requireWorkspace, can, invalidateWorkspaceCache } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { uniqueSlug, slugIsValid } from '../../lib/slug.js';

/**
 * Workspaces and their websites.
 *
 * Every tenant route lives under `/api/v1/w/:workspaceId/...`, so the tenant is a
 * path segment rather than ambient state. requireWorkspace resolves it, verifies
 * membership and hands the handler a scoped `req.db` — the only client it can see.
 */

/**
 * Website public keys are unguessable by design. `mode=food` used to be both the
 * tenant selector and a guessable string, which let anyone enumerate other
 * customers' widget config, copy and domain lists.
 */
function mintPublicKey(): string {
  return `nst_${randomBytes(24).toString('base64url').slice(0, 24)}`;
}

const websiteBody = z.object({
  name: z.string().min(1).max(120),
  primary_domain: z.string().max(253).nullable().optional(),
  allowed_domains: z.array(z.string().max(253)).max(50).optional(),
  enforce_domains: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export async function workspaceV1Routes(app: FastifyInstance): Promise<void> {
  // ── Create a workspace (wizard step 3, or an extra one later) ─────────────
  app.post(
    '/api/v1/workspaces',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          name: z.string().min(1).max(120),
          slug: z.string().max(40).optional(),
          timezone: z.string().max(60).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      if (body.slug && !slugIsValid(body.slug.toLowerCase())) {
        return reply.code(400).send({ error: 'That workspace address is not available', code: 'bad_slug' });
      }
      const slug = body.slug ? body.slug.toLowerCase() : await uniqueSlug(body.name);

      const plan =
        (await unscopedPrisma.plans.findFirst({ where: { is_trial_default: true } })) ??
        (await unscopedPrisma.plans.findFirst({ where: { is_public: true }, orderBy: { sort_order: 'asc' } }));
      if (!plan) return reply.code(500).send({ error: 'No plans configured' });

      try {
        const workspace = await unscopedPrisma.$transaction(async (tx) => {
          const ws = await tx.workspaces.create({
            data: {
              name: body.name,
              slug,
              timezone: body.timezone ?? 'UTC',
              plan_id: plan.id,
              subscription_status: 'trialing',
              trial_ends_at: new Date(Date.now() + 14 * 864e5),
              private_settings: { create: {} },
            },
            select: { id: true, slug: true, name: true },
          });
          await tx.workspace_members.create({
            data: { workspace_id: ws.id, user_id: req.auth!.userId, role: 'owner', all_websites: true },
          });
          return ws;
        });

        await audit(req, {
          action: 'workspace.created',
          workspaceId: workspace.id,
          targetType: 'workspace',
          targetId: workspace.id,
        });
        return reply.code(201).send({ workspace });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ error: 'That workspace address is taken', code: 'slug_taken' });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/w/:workspaceId',
    { preHandler: [requireWorkspace, can('workspace:read')] },
    async (req, reply) => {
      const ws = await unscopedPrisma.workspaces.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.id },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          subscription_status: true,
          trial_ends_at: true,
          created_at: true,
          plan: { select: { code: true, name: true } },
        },
      });
      return reply.send({ workspace: ws });
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId',
    { preHandler: [requireWorkspace, can('workspace:update')] },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          name: z.string().min(1).max(120).optional(),
          slug: z.string().max(40).optional(),
          timezone: z.string().max(60).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;
      if (body.slug && !slugIsValid(body.slug.toLowerCase())) {
        return reply.code(400).send({ error: 'That workspace address is not available', code: 'bad_slug' });
      }

      try {
        const updated = await unscopedPrisma.workspaces.update({
          where: { id: req.auth!.workspace!.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.slug !== undefined ? { slug: body.slug.toLowerCase() } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          },
          select: { id: true, name: true, slug: true, timezone: true },
        });
        invalidateWorkspaceCache(updated.id);
        await audit(req, { action: 'workspace.updated', targetType: 'workspace', targetId: updated.id });
        return reply.send({ workspace: updated });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ error: 'That workspace address is taken', code: 'slug_taken' });
        }
        throw err;
      }
    },
  );

  // ── Websites ──────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/w/:workspaceId/websites',
    { preHandler: [requireWorkspace, can('website:read')] },
    async (req, reply) => {
      // req.db already narrows to the workspace AND to this member's granted
      // websites, so a scoped member cannot list the others.
      const websites = await req.db.websites.findMany({
        where: { deleted_at: null },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          public_key: true,
          name: true,
          primary_domain: true,
          is_active: true,
          allowed_domains: true,
          enforce_domains: true,
          installed_at: true,
          created_at: true,
        },
      });
      return reply.send({ websites });
    },
  );

  app.post(
    '/api/v1/w/:workspaceId/websites',
    { preHandler: [requireWorkspace, can('website:create')] },
    async (req, reply) => {
      const body = parseBody(websiteBody, req.body, reply);
      if (!body) return;

      // Plan limit. Phase 12 replaces this with assertWithinLimit() so every metric
      // reads the same counters; the check exists now so the limit is never
      // retro-fitted onto data that already exceeds it.
      const plan = await unscopedPrisma.plans.findUniqueOrThrow({
        where: { id: req.auth!.workspace!.planId },
        select: { max_websites: true },
      });
      const current = await req.db.websites.count({ where: { deleted_at: null } });
      if (current >= plan.max_websites) {
        return reply.code(402).send({
          error: `Your plan includes ${plan.max_websites} website${plan.max_websites === 1 ? '' : 's'}`,
          code: 'plan_limit',
          metric: 'websites',
          limit: plan.max_websites,
          used: current,
        });
      }

      const workspaceId = req.auth!.workspace!.id;
      // A website is always created WITH its 1:1 settings and business-hours rows,
      // never lazily, so the widget boot route can rely on them existing instead of
      // merging defaults at read time.
      const website = await req.db.websites.create({
        data: {
          public_key: mintPublicKey(),
          name: body.name,
          primary_domain: body.primary_domain ?? null,
          allowed_domains: body.allowed_domains ?? [],
          enforce_domains: body.enforce_domains ?? false,
          settings: {
            create: {
              workspace_id: workspaceId,
              system_prompt:
                `You are the customer support assistant for ${body.name}. ` +
                `Answer only questions about ${body.name} and its products or services. ` +
                `If you don't know the answer, hand off to a human.`,
            },
          },
          hours: {
            create: {
              workspace_id: workspaceId,
              timezone: req.auth!.workspace ? undefined : 'UTC',
            },
          },
        } as never,
        select: { id: true, public_key: true, name: true, primary_domain: true, created_at: true },
      });

      await audit(req, { action: 'website.created', targetType: 'website', targetId: website.id });
      return reply.code(201).send({ website });
    },
  );

  app.patch(
    '/api/v1/w/:workspaceId/websites/:websiteId',
    { preHandler: [requireWorkspace, can('website_settings:update')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const body = parseBody(websiteBody.partial(), req.body, reply);
      if (!body) return;

      // P2025 when the id belongs to another tenant — the scoped client added the
      // predicate, so this is a 404 rather than a leak.
      try {
        const website = await req.db.websites.update({
          where: { id: websiteId },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.primary_domain !== undefined ? { primary_domain: body.primary_domain } : {}),
            ...(body.allowed_domains !== undefined ? { allowed_domains: body.allowed_domains } : {}),
            ...(body.enforce_domains !== undefined ? { enforce_domains: body.enforce_domains } : {}),
            ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
          },
          select: { id: true, name: true, primary_domain: true, is_active: true },
        });
        await audit(req, { action: 'website.updated', targetType: 'website', targetId: website.id });
        return reply.send({ website });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/w/:workspaceId/websites/:websiteId',
    { preHandler: [requireWorkspace, can('website:delete')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      // Soft delete: a website owns conversations, and a customer clicking Delete
      // must not silently destroy their support history. The purge job handles
      // actual removal.
      try {
        await req.db.websites.update({
          where: { id: websiteId },
          data: { deleted_at: new Date(), is_active: false },
        });
        await audit(req, { action: 'website.deleted', targetType: 'website', targetId: websiteId });
        return reply.send({ ok: true });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        throw err;
      }
    },
  );

  /** Install status, polled by the onboarding wizard's detector. */
  app.get(
    '/api/v1/w/:workspaceId/websites/:websiteId/install-status',
    { preHandler: [requireWorkspace, can('website:read')] },
    async (req, reply) => {
      const { websiteId } = req.params as { websiteId: string };
      const website = await req.db.websites.findUnique({
        where: { id: websiteId },
        select: { id: true, installed_at: true, allowed_domains: true, enforce_domains: true },
      });
      if (!website) return reply.code(404).send({ error: 'Not found' });

      const domains = await req.db.website_domains.findMany({
        where: { website_id: websiteId },
        orderBy: { last_seen: 'desc' },
        take: 10,
        select: { host: true, hits: true, authorized: true, last_seen: true },
      });
      const conversations = await req.db.conversations.count({ where: { website_id: websiteId } });

      // A host seen but NOT authorized is the single most common install failure —
      // the snippet is live on a domain the allowlist doesn't cover. Surfacing it
      // as its own phase is what lets the UI offer "add this domain" instead of a
      // generic "not detected yet".
      const unauthorized = domains.find((d) => !d.authorized);
      const phase = conversations > 0
        ? 'message_received'
        : website.installed_at
          ? 'script_seen'
          : unauthorized
            ? 'wrong_domain'
            : 'waiting';

      return reply.send({
        phase,
        installed_at: website.installed_at,
        conversations,
        domains,
        wrong_domain_host: unauthorized?.host ?? null,
      });
    },
  );
}
