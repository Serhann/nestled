import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// The widget plane resolves its own tenant from an unguessable public key, before
// any request-scoped client exists; it then narrows req.db to that one website.
// eslint-disable-next-line no-restricted-imports -- resolves the tenant from a public key
import { unscopedPrisma } from '../../db/unscoped.js';
import { tenantDb } from '../../db/tenant.js';
import { widgetEntitlement } from '../../services/billing/index.js';
import { generateVisitorToken, tokenMatchesHash } from '../../auth/tokens.js';
import { requireVisitor } from '../../plugins/auth.js';
import { parseBody } from '../../lib/validate.js';
import { insertMessage } from '../../lib/messages.js';
import { bumpUsage, checkUsageLimit } from '../../lib/usage.js';
import { clientIp, lookupGeo } from '../../services/geo.js';
import { recordVisitorIp } from '../../services/visitorTracking.js';
import { resolveIdentity } from '../../services/identity.js';
import { verifyContextToken } from '../../services/verifiedAttributes.js';
import { issueWidgetSession, verifyWidgetSession } from '../../services/widgetSession.js';
import { sendEmail } from '../../services/email.js';
import { anyAgentOnline, publishToWorkspace, rememberConversationOwner } from '../../realtime/hub.js';
import { attachConversationToVisitor } from '../../realtime/presence.js';
import { maybeAIReply } from '../../services/ai/reply.js';
import { advanceBotRun, startBotRun } from '../../services/bot/engine.js';
import { routeConversation } from '../../services/routing.js';
import { onCustomerMessage } from '../../services/responseTargets.js';
import { notifyNewChat, notifyNewMessage } from '../../services/discord.js';
import { pushNewConversation, pushVisitorMessage } from '../../services/push.js';
import { DEFAULT_COPY } from '../../lib/widgetCopy.js';
import { isWithinBusinessHours } from '../../lib/businessHours.js';

/**
 * The public widget plane.
 *
 * Everything here is reachable by an anonymous visitor on a customer's site, so
 * two rules hold throughout:
 *
 *  1. The tenant is resolved from the website's UNGUESSABLE public key, never from
 *     a readable string. The pre-tenant build used `mode=food`, which was both the
 *     tenant selector and guessable — so anyone could enumerate other customers'
 *     widget config, copy, starters and domain lists.
 *  2. Only `website_settings` is ever read for config. Secrets live in a different
 *     table, so there is no code path from this file to one.
 */

/** Does `host` satisfy an allowlist entry? A bare domain also covers subdomains. */
function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return allowed.some((raw) => {
    const pattern = raw.trim().toLowerCase().replace(/^www\./, '');
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === pattern || h.endsWith(`.${pattern}`);
  });
}

function hostOf(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }
}

interface ResolvedWebsite {
  workspaceId: string;
  websiteId: string;
  websiteName: string;
  workspaceStatus: string;
  graceUntil: Date | null;
}

/**
 * Resolve a public key to a website, and record the host it loaded on.
 *
 * The domain record is what completes onboarding ("we saw your snippet") and what
 * flags an unauthorized embed, so it is written even when the host is NOT allowed —
 * that row is precisely how the install detector can offer "add this domain".
 */
async function resolveWebsite(
  publicKey: string,
  href: string | undefined,
): Promise<{ site: ResolvedWebsite; authorized: boolean; enforce: boolean } | null> {
  const website = await unscopedPrisma.websites.findUnique({
    where: { public_key: publicKey },
    select: {
      id: true,
      workspace_id: true,
      name: true,
      is_active: true,
      deleted_at: true,
      allowed_domains: true,
      enforce_domains: true,
      installed_at: true,
      workspace: { select: { subscription_status: true, grace_until: true, deleted_at: true } },
    },
  });
  if (!website || website.deleted_at || !website.is_active || website.workspace.deleted_at) return null;

  const host = hostOf(href);
  const authorized = !host || website.allowed_domains.length === 0 || hostAllowed(host, website.allowed_domains);

  if (host) {
    void unscopedPrisma
      .$executeRaw`
        INSERT INTO website_domains (id, workspace_id, website_id, host, hits, authorized, first_seen, last_seen)
        VALUES (gen_random_uuid(), ${website.workspace_id}::uuid, ${website.id}::uuid, ${host}, 1, ${authorized}, now(), now())
        ON CONFLICT (website_id, host)
        DO UPDATE SET hits = website_domains.hits + 1, last_seen = now(), authorized = ${authorized}
      `
      .catch(() => undefined);

    // First authorized load flips installed_at and tells the onboarding wizard.
    if (authorized && !website.installed_at) {
      void (async () => {
        await unscopedPrisma.websites
          .updateMany({ where: { id: website.id, installed_at: null }, data: { installed_at: new Date() } })
          .catch(() => undefined);
        publishToWorkspace(
          website.workspace_id,
          { type: 'website:install_progress', websiteId: website.id, phase: 'script_seen', host },
          { websiteId: website.id },
        );
        const owner = await unscopedPrisma.workspace_members.findFirst({
          where: { workspace_id: website.workspace_id, role: 'owner' },
          select: { user: { select: { email: true } } },
        });
        if (owner) {
          void sendEmail({
            to: owner.user.email,
            template: 'website_installed',
            vars: { websiteName: website.name, host },
            workspaceId: website.workspace_id,
            relatedType: 'website',
            relatedId: website.id,
          });
        }
      })();
    }
  }

  return {
    site: {
      workspaceId: website.workspace_id,
      websiteId: website.id,
      websiteName: website.name,
      workspaceStatus: website.workspace.subscription_status,
      graceUntil: website.workspace.grace_until,
    },
    authorized,
    enforce: website.enforce_domains,
  };
}

/**
 * Is the workspace entitled to serve a widget right now?
 *
 * During grace the widget KEEPS WORKING. Breaking a prospect's production site the
 * moment a trial lapses is the one failure that turns a lapsed trial into a
 * complaint; the dashboard goes read-only instead.
 */
function widgetEnabled(site: ResolvedWebsite): boolean {
  // One implementation of the rule, shared with the billing lifecycle job and the
  // dashboard's read-only state. Two copies of "is this account entitled" is how a
  // workspace ends up with a live widget and a locked panel, or the reverse.
  return widgetEntitlement({
    subscription_status: site.workspaceStatus,
    grace_until: site.graceUntil,
  }).widget;
}

export async function widgetV1Routes(app: FastifyInstance): Promise<void> {
  /**
   * One boot call replaces the old three (config + triggers + agent status). The
   * widget makes this request before painting anything, so every extra round trip
   * here is visible to the visitor as a late launcher.
   */
  app.get(
    '/api/v1/widget/boot',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query as { key?: string; href?: string };
      if (!q.key) return reply.code(400).send({ error: 'key required' });

      const resolved = await resolveWebsite(q.key, q.href);
      // A bad key is a 404 with no detail: this endpoint must not become an oracle
      // for which keys exist.
      if (!resolved) return reply.code(404).send({ error: 'Not found' });
      const { site, authorized, enforce } = resolved;

      if (!widgetEnabled(site)) return reply.send({ enabled: false });
      if (enforce && !authorized) {
        // The snippet is live on a domain the customer did not authorize. Tell the
        // widget to stay hidden, but say nothing about the website itself.
        return reply.send({ enabled: false, authorized: false });
      }

      const db = tenantDb({ workspaceId: site.workspaceId, websiteIds: [site.websiteId] });
      const [settings, hours, starters, triggers] = await Promise.all([
        db.website_settings.findUnique({ where: { website_id: site.websiteId } }),
        db.website_business_hours.findUnique({ where: { website_id: site.websiteId } }),
        db.starters.findMany({
          where: { is_active: true, OR: [{ website_id: site.websiteId }, { website_id: null }] },
          orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
          select: { key: true, label: true, message: true, kind: true, fields: true, icon: true },
        }),
        db.triggers.findMany({
          where: { is_active: true, OR: [{ website_id: site.websiteId }, { website_id: null }] },
          orderBy: { priority: 'desc' },
          select: {
            id: true,
            identifier: true,
            actions: true,
            events: true,
            behaviors: true,
            platforms: true,
          },
        }),
      ]);
      if (!settings) return reply.code(500).send({ error: 'Website is not fully configured' });

      const online = anyAgentOnline(site.workspaceId, site.websiteId);
      const withinHours = isWithinBusinessHours(hours);
      // The country a trigger's `country_restriction` is matched against. Resolved
      // here rather than in the widget because the widget has no honest way to know
      // it, and a client-declared country is not a restriction.
      const country = (await lookupGeo(clientIp(req.headers, req.ip)))?.country ?? null;

      return reply.send({
        enabled: true,
        authorized,
        website: { id: site.websiteId, name: site.websiteName },
        theme: {
          primary_color: settings.primary_color,
          color_mode: settings.color_mode,
          radius_px: settings.radius_px,
          font_family: settings.font_family,
          position: settings.position,
          offset_x: settings.offset_x,
          offset_y: settings.offset_y,
          launcher_style: settings.launcher_style,
          // Plan-gated server-side: the stored flag is IGNORED unless the plan
          // allows it, so a client cannot remove our branding by flipping a value.
          show_branding: settings.show_branding,
        },
        // Only overrides are stored, so improvements to DEFAULT_COPY reach every
        // customer who never edited that particular string.
        copy: { ...DEFAULT_COPY, ...((settings.copy as Record<string, string>) ?? {}) },
        behavior: {
          ai_enabled: settings.ai_enabled,
          pre_chat_enabled: settings.pre_chat_enabled,
          pre_chat_fields: settings.pre_chat_fields,
          auto_welcome_enabled: settings.auto_welcome_enabled,
          auto_welcome_message: settings.auto_welcome_message,
          auto_welcome_delay: settings.auto_welcome_delay,
          file_upload_enabled: settings.file_upload_enabled,
          sound_enabled: settings.sound_enabled,
          reset_after_resolve: settings.reset_after_resolve,
          rating_tags: settings.rating_tags,
          // Whether presence.js should record at all. Off by default: buffering
          // every visitor's DOM is the one thing in this system that can exhaust
          // a process's memory, so it takes both the plan and this flag.
          live_view_enabled: settings.live_view_enabled,
        },
        visitor: { country },
        starters: settings.starters_enabled
          ? starters.map((s) => ({
              id: s.key,
              label: s.label,
              message: s.message,
              kind: s.kind,
              fields: s.fields,
              icon: s.icon,
            }))
          : [],
        // `start_bot` names a flow, and which flow runs is a server decision: the
        // widget is told only THAT this trigger opens a chat, so it knows to create
        // a conversation rather than paint a bubble. The trigger id it sends back is
        // what the server resolves to a flow.
        triggers: triggers.map((t) => {
          const actions = (t.actions ?? {}) as Record<string, unknown>;
          const { start_bot, ...rest } = actions;
          return { ...t, actions: { ...rest, starts_bot: Boolean(start_bot) } };
        }),
        availability: { online, within_hours: withinHours, offline_behavior: hours?.offline_behavior ?? 'collect_email' },
      });
    },
  );

  /**
   * "Is anyone there right now?" — and nothing else.
   *
   * The widget needs to refresh this while a panel is open with no socket, and
   * /boot is the wrong endpoint to poll: it upserts a website_domains row and can
   * publish install progress, so polling it would mean a database write per
   * visitor per interval for an answer held in memory.
   */
  app.get(
    '/api/v1/widget/availability',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query as { key?: string };
      if (!q.key) return reply.code(400).send({ error: 'key required' });

      const website = await unscopedPrisma.websites.findUnique({
        where: { public_key: q.key },
        select: {
          id: true,
          workspace_id: true,
          is_active: true,
          deleted_at: true,
          hours: { select: { enabled: true, timezone: true, rules: true, holidays: true, offline_behavior: true } },
        },
      });
      if (!website || website.deleted_at || !website.is_active) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply.send({
        online: anyAgentOnline(website.workspace_id, website.id),
        within_hours: isWithinBusinessHours(website.hours),
        offline_behavior: website.hours?.offline_behavior ?? 'collect_email',
      });
    },
  );

  /**
   * Exchange the public key for a signed session token.
   *
   * This is the endpoint that closes the presence takeover: the token is what the
   * presence socket authenticates with, so a visitor id can no longer be asserted
   * by whoever asks. See services/widgetSession.ts.
   */
  app.post(
    '/api/v1/widget/session',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          key: z.string().min(4).max(64),
          visitor_id: z.string().max(64).optional(),
          href: z.string().max(2000).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      const resolved = await resolveWebsite(body.key, body.href);
      if (!resolved) return reply.code(404).send({ error: 'Not found' });
      if (!widgetEnabled(resolved.site)) return reply.code(403).send({ error: 'Widget disabled' });
      if (resolved.enforce && !resolved.authorized) {
        return reply.code(403).send({ error: 'This domain is not authorized' });
      }

      const { token, visitorId } = issueWidgetSession({
        workspaceId: resolved.site.workspaceId,
        websiteId: resolved.site.websiteId,
        visitorId: body.visitor_id ?? null,
      });
      return reply.send({ session_token: token, visitor_id: visitorId });
    },
  );

  // ── Conversations ─────────────────────────────────────────────────────────
  app.post(
    '/api/v1/widget/conversations',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          session_token: z.string().min(10).max(2000),
          visitor_name: z.string().max(200).optional(),
          visitor_email: z.string().email().max(200).optional(),
          fingerprint: z.string().max(128).optional(),
          context_token: z.string().max(8000).optional(),
          /** The `starters.key` the visitor picked, if any. Can select a bot flow. */
          starter_key: z.string().max(40).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      // Identity comes from the SIGNED session, never the body.
      const session = verifyWidgetSession(body.session_token);
      if (!session) return reply.code(401).send({ error: 'Invalid session' });
      const { ws: workspaceId, wsite: websiteId, vid: visitorId } = session;

      const workspace = await unscopedPrisma.workspaces.findUnique({
        where: { id: workspaceId },
        select: { subscription_status: true, grace_until: true, plan: { select: { max_conversations_month: true } } },
      });
      if (!workspace) return reply.code(404).send({ error: 'Not found' });

      // The conversation quota is SOFT: past 100% it keeps accepting and warns, and
      // only refuses at 120%, where it returns the offline path instead of an error.
      // A hard stop would mean silently dropping real leads at the exact moment a
      // customer's site got popular.
      const over = await checkUsageLimit(workspaceId, 'conversations', workspace.plan.max_conversations_month);
      if (over) {
        return reply.code(402).send({
          error: 'This inbox has reached its monthly conversation limit',
          code: 'plan_limit',
          metric: 'conversations',
          fallback: 'collect_email',
        });
      }

      const { token, hash } = generateVisitorToken();
      const ip = clientIp(req.headers, req.ip);
      const geo = await lookupGeo(ip);

      // A valid signature makes the host's data TRUSTED, so verified name/email win
      // over anything the browser supplied.
      const verified = await verifyContextToken(websiteId, body.context_token);
      const trustedName = verified?.customer?.name ?? null;
      const trustedEmail = verified?.customer?.email ?? null;

      const conv = await unscopedPrisma.$transaction(async (tx) => {
        const created = await tx.conversations.create({
          data: {
            workspace_id: workspaceId,
            website_id: websiteId,
            visitor_id: visitorId,
            visitor_name: trustedName ?? body.visitor_name ?? null,
            visitor_email: trustedEmail ?? body.visitor_email ?? null,
            visitor_token_hash: hash,
            metadata: {
              ...(body.metadata ?? {}),
              ip_address: ip,
              location: geo,
            } as object,
            // Only signature-verified values land here; unsigned hints stay in
            // metadata. The AI prompt and the agent's "verified" card read THIS.
            custom_attributes: (verified ? { ...(verified.attributes ?? {}), ...(verified.customer ? { customer: verified.customer } : {}) } : {}) as object,
          },
          select: { id: true, created_at: true },
        });
        // Same transaction as the insert, so the metered number can never drift
        // from the rows it counts.
        await bumpUsage(workspaceId, 'conversations', 1, tx);
        return created;
      });

      rememberConversationOwner(conv.id, workspaceId, websiteId);
      void recordVisitorIp(workspaceId, visitorId, ip, geo);
      void resolveIdentity(workspaceId, visitorId, {
        fingerprint: body.fingerprint ?? null,
        email: trustedEmail,
        websiteId,
      });

      publishToWorkspace(
        workspaceId,
        {
          type: 'conversation:new',
          conversation: {
            id: conv.id,
            website_id: websiteId,
            visitor_id: visitorId,
            visitor_name: trustedName ?? body.visitor_name ?? null,
            created_at: conv.created_at,
          },
        },
        { websiteId },
      );
      attachConversationToVisitor(websiteId, visitorId, conv.id);

      const triggerId = typeof body.metadata?.trigger_id === 'string' ? body.metadata.trigger_id : null;
      let triggerFlowId: string | null = null;
      if (triggerId) {
        const trigger = await unscopedPrisma.triggers.findFirst({
          where: { id: triggerId, workspace_id: workspaceId },
          select: { actions: true },
        });
        const startBot = (trigger?.actions as { start_bot?: unknown } | null)?.start_bot;
        triggerFlowId = typeof startBot === 'string' ? startBot : null;
        void unscopedPrisma.triggers
          .updateMany({
            where: { id: triggerId, workspace_id: workspaceId },
            data: { conversation_count: { increment: 1 } },
          })
          .catch(() => undefined);
      }

      /**
       * Automation, AWAITED.
       *
       * Both of these are one or two indexed queries when the workspace has no
       * flows and no rules, and awaiting them buys something worth more than those
       * milliseconds: the conversation the widget then fetches already contains the
       * bot's greeting and already names its assignee. Fired and forgotten, the
       * visitor gets an empty thread that fills in a moment later, which reads as a
       * bug rather than as a fast response.
       */
      const currentPage = typeof body.metadata?.current_page === 'string' ? body.metadata.current_page : null;
      const botRunId = await startBotRun({
        workspaceId,
        websiteId,
        conversationId: conv.id,
        page: currentPage,
        starterKey: body.starter_key ?? null,
        flowId: triggerFlowId,
      });
      // A running flow OWNS the conversation until it hands off. Assigning a human up
      // front would put an agent's name on a chat the bot is still conducting, and
      // would silence the flow's own handoff — which is the step that decides, with
      // the collected answers in hand, who should actually get it.
      if (!botRunId) {
        await routeConversation({
          workspaceId,
          websiteId,
          conversationId: conv.id,
          page: currentPage,
          countryCode: geo?.country_code ?? null,
          attributes: (verified?.attributes ?? {}) as Record<string, unknown>,
        });
      }

      void notifyNewChat(workspaceId, conv.id);
      void pushNewConversation(workspaceId, websiteId, conv.id, trustedName ?? body.visitor_name ?? null);

      return reply.code(201).send({ conversation_id: conv.id, visitor_token: token });
    },
  );

  /**
   * Claim a proactively-created conversation.
   *
   * The proactive frame carries a single-use claim token rather than the visitor
   * token, and exchanging it requires the visitor's OWN signed session — so a
   * leaked frame is worthless, and any future bug in the fanout path is not a
   * breach.
   */
  app.post(
    '/api/v1/widget/conversations/:id/claim',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({ claim_token: z.string().min(10).max(400), session_token: z.string().min(10).max(2000) }),
        req.body,
        reply,
      );
      if (!body) return;

      const session = verifyWidgetSession(body.session_token);
      if (!session) return reply.code(401).send({ error: 'Invalid session' });

      const conv = await unscopedPrisma.conversations.findUnique({
        where: { id },
        select: {
          id: true,
          workspace_id: true,
          website_id: true,
          visitor_id: true,
          claim_token_hash: true,
          claim_expires_at: true,
        },
      });
      if (
        !conv ||
        !conv.claim_token_hash ||
        !conv.claim_expires_at ||
        conv.claim_expires_at < new Date() ||
        !tokenMatchesHash(body.claim_token, conv.claim_token_hash) ||
        // The claim is only valid for the visitor and website it was minted for.
        conv.visitor_id !== session.vid ||
        conv.website_id !== session.wsite
      ) {
        return reply.code(401).send({ error: 'Invalid or expired claim' });
      }

      // Mint the real visitor token now, and burn the claim.
      const { token, hash } = generateVisitorToken();
      await unscopedPrisma.conversations.update({
        where: { id: conv.id },
        data: { visitor_token_hash: hash, claim_token_hash: null, claim_expires_at: null },
      });
      return reply.send({ visitor_token: token });
    },
  );

  app.get(
    '/api/v1/widget/conversations/:id/messages',
    { preHandler: requireVisitor('id') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const messages = await req.db.messages.findMany({
        where: { conversation_id: id },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          conversation_id: true,
          content: true,
          sender_type: true,
          sender_member_id: true,
          metadata: true,
          created_at: true,
        },
      });
      return reply.send({ messages });
    },
  );

  app.post(
    '/api/v1/widget/conversations/:id/messages',
    { preHandler: requireVisitor('id'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ content: z.string().min(1).max(8000) }), req.body, reply);
      if (!body) return;

      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: { id: true, workspace_id: true, website_id: true, visitor_name: true, status: true },
      });
      if (!conv) return reply.code(404).send({ error: 'Not found' });

      const message = await insertMessage({
        workspaceId: conv.workspace_id,
        websiteId: conv.website_id,
        conversationId: id,
        content: body.content,
        senderType: 'visitor',
      });
      if (!message) return reply.code(500).send({ error: 'Failed to post message' });

      // A resolved conversation re-opens when the visitor writes again.
      //
      // AWAITED, not fire-and-forget: the reopen is part of what posting the message
      // MEANS, not a side effect of it. Left as `void`, the response could return
      // while the row still said "resolved", so an agent refreshing at that instant
      // would see a closed conversation with a new message in it.
      if (conv.status === 'resolved') {
        await req.db.conversations.updateMany({
          where: { id },
          data: { status: 'open', resolved_at: null },
        });
      }

      // The clock starts when the customer speaks. Awaited so the conversation the
      // agent's inbox then renders already carries its deadline — a countdown that
      // appears a second later reads as a glitch.
      await onCustomerMessage({
        workspaceId: conv.workspace_id,
        websiteId: conv.website_id,
        conversationId: id,
      });

      void notifyNewMessage(conv.workspace_id, id, body.content, 'visitor');
      void pushVisitorMessage(conv.workspace_id, conv.website_id, id, conv.visitor_name, body.content);

      // A running flow gets the message first, and consuming it keeps the plain AI
      // auto-reply out of the way — two assistants answering the same question is
      // worse than either of them alone. maybeAIReply re-checks this itself; the
      // await here is what makes the ORDER deterministic rather than a race between
      // two fire-and-forget calls.
      const handledByBot = await advanceBotRun({
        workspaceId: conv.workspace_id,
        websiteId: conv.website_id,
        conversationId: id,
        input: body.content,
      });
      if (!handledByBot) void maybeAIReply(conv.workspace_id, conv.website_id, id);

      return reply.code(201).send({ message });
    },
  );

  /** Refresh the signed host context on a live conversation. */
  app.post(
    '/api/v1/widget/conversations/:id/attributes',
    { preHandler: requireVisitor('id'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(z.object({ token: z.string().max(8000) }), req.body, reply);
      if (!body) return;

      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: { id: true, workspace_id: true, website_id: true, visitor_id: true, custom_attributes: true },
      });
      if (!conv) return reply.code(404).send({ error: 'Not found' });

      const ctx = await verifyContextToken(conv.website_id, body.token);
      // Invalid / expired / tampered → ignore quietly and keep what we had. A
      // failed refresh must not blank out attributes an agent is looking at.
      if (!ctx) return reply.send({ ok: false });

      const trustedName = ctx.customer?.name ?? null;
      const trustedEmail = ctx.customer?.email ?? null;
      await req.db.conversations.update({
        where: { id },
        data: {
          custom_attributes: {
            ...(ctx.attributes ?? {}),
            ...(ctx.customer ? { customer: ctx.customer } : {}),
          } as object,
          ...(trustedName ? { visitor_name: trustedName } : {}),
          ...(trustedEmail ? { visitor_email: trustedEmail } : {}),
        },
      });
      publishToWorkspace(
        conv.workspace_id,
        { type: 'conversation:updated', conversation: { id: conv.id } },
        { websiteId: conv.website_id },
      );
      if (trustedEmail) {
        void resolveIdentity(conv.workspace_id, conv.visitor_id, {
          email: trustedEmail,
          websiteId: conv.website_id,
        });
      }
      return reply.send({ ok: true });
    },
  );

  /** Post-chat rating. Recorded WITHOUT reopening a resolved conversation. */
  app.post(
    '/api/v1/widget/conversations/:id/rating',
    { preHandler: requireVisitor('id'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(
        z.object({
          stars: z.number().int().min(1).max(5),
          tags: z.array(z.string().max(60)).max(20).optional(),
          comment: z.string().max(2000).optional(),
        }),
        req.body,
        reply,
      );
      if (!body) return;

      // Stored as columns now, not parsed back out of a message body — which is
      // what makes CSAT reportable in Phase 13 instead of a text search.
      await req.db.conversations.update({
        where: { id },
        data: {
          rating_stars: body.stars,
          rating_tags: body.tags ?? [],
          rating_comment: body.comment ?? null,
        },
      });
      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: { workspace_id: true, website_id: true },
      });
      if (conv) {
        publishToWorkspace(
          conv.workspace_id,
          { type: 'conversation:updated', conversation: { id } },
          { websiteId: conv.website_id },
        );
      }
      return reply.code(201).send({ ok: true });
    },
  );

  app.post(
    '/api/v1/widget/conversations/:id/typing',
    { preHandler: requireVisitor('id'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const isTyping = (req.body as { is_typing?: boolean } | undefined)?.is_typing ?? true;
      const conv = await req.db.conversations.findUnique({
        where: { id },
        select: { workspace_id: true, website_id: true },
      });
      if (conv) {
        publishToWorkspace(
          conv.workspace_id,
          { type: 'typing', conversationId: id, from: 'visitor', isTyping },
          { websiteId: conv.website_id },
        );
      }
      return reply.send({ ok: true });
    },
  );

  /** Offline "leave us a message" — creates the conversation and emails the team. */
  app.post(
    '/api/v1/widget/offline-message',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseBody(
        z.object({
          session_token: z.string().min(10).max(2000),
          email: z.string().email().max(200),
          message: z.string().min(1).max(4000),
        }),
        req.body,
        reply,
      );
      if (!body) return;
      const session = verifyWidgetSession(body.session_token);
      if (!session) return reply.code(401).send({ error: 'Invalid session' });

      const { token, hash } = generateVisitorToken();
      const conv = await unscopedPrisma.conversations.create({
        data: {
          workspace_id: session.ws,
          website_id: session.wsite,
          visitor_id: session.vid,
          visitor_email: body.email,
          visitor_token_hash: hash,
          source: 'widget',
          metadata: { offline: true, ip_address: clientIp(req.headers, req.ip) } as object,
        },
        select: { id: true },
      });
      await insertMessage({
        workspaceId: session.ws,
        websiteId: session.wsite,
        conversationId: conv.id,
        content: body.message,
        senderType: 'visitor',
        metadata: { offline: true },
      });
      void bumpUsage(session.ws, 'conversations', 1);
      // Somebody left a message and is waiting for an answer, so the clock runs here
      // too. It is the offline path, so the deadline lands after opening — which is
      // exactly what business-hours arithmetic is for.
      await onCustomerMessage({
        workspaceId: session.ws,
        websiteId: session.wsite,
        conversationId: conv.id,
      });
      void notifyNewChat(session.ws, conv.id);
      return reply.code(201).send({ conversation_id: conv.id, visitor_token: token });
    },
  );

  /** Trigger analytics: fire-and-forget counter, so it stays unauthenticated. */
  app.post(
    '/api/v1/widget/triggers/:id/fire',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      void unscopedPrisma.triggers
        .updateMany({ where: { id }, data: { fire_count: { increment: 1 } } })
        .catch(() => undefined);
      return reply.send({ ok: true });
    },
  );
}
