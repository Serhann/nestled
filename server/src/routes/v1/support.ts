import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
// This resolves the install's OWN support website and signs a context token for
// it. There is no customer workspace scope involved: the workspace being described
// is the caller's, and the website doing the describing is ours.
// eslint-disable-next-line no-restricted-imports -- reads the install's own support website
import { unscopedPrisma } from '../../db/unscoped.js';
import { requireAuth } from '../../plugins/auth.js';
import { settings } from '../../services/platform/settings.js';
import { capabilitiesFor, type WorkspaceRole } from '../../permissions.js';

/**
 * Nestled's own support chat.
 *
 * We run our product on our own marketing site and inside the customer panel.
 * Dogfooding is the honest reason, but the practical one is better: a customer
 * who is confused in the middle of setting up their widget should not have to
 * leave the page to ask about it.
 *
 * The website it points at is an ordinary website in one of our own workspaces,
 * chosen in the ops panel. Empty by default, and empty forever on a self-hosted
 * install — someone running their own copy is not our customer, and shipping them
 * a chat bubble that reaches our support team would be both baffling and a
 * privacy leak.
 */

/** Long enough to outlast a support conversation; short enough not to be a durable forgery target. */
const CONTEXT_TTL_SECONDS = 60 * 60;

export async function supportV1Routes(app: FastifyInstance): Promise<void> {
  /**
   * Unauthenticated: the marketing site and the sign-in page need it too, and an
   * embed key is public by design — it is pasted into a page. This is the same
   * value a visitor would read out of our own HTML.
   */
  app.get(
    '/api/v1/support-widget',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const key = settings().support.websiteKey;
      return reply
        .header('cache-control', 'public, max-age=300')
        .send({ enabled: Boolean(key), key: key ?? null });
    },
  );

  /**
   * A signed description of who is asking, for the widget inside the panel.
   *
   * This is the part that makes support chat from inside the app worth having:
   * our agents see a verified workspace, plan and role instead of asking "which
   * account are you on?" three messages in. It is signed with the support
   * website's own HMAC secret — the same mechanism any customer uses to vouch for
   * their visitors, applied to ourselves.
   *
   * It reports the CALLER's own memberships only. There is no workspace parameter
   * to get wrong.
   */
  app.get(
    '/api/v1/me/support-context',
    { preHandler: requireAuth },
    async (req, reply) => {
      const key = settings().support.websiteKey;
      if (!key) return reply.send({ enabled: false, context_token: null });

      const website = await unscopedPrisma.websites.findUnique({
        where: { public_key: key },
        select: { id: true, identity_secret: true },
      });
      // A key that names nothing, or a website with no signing secret, is a
      // configuration mistake rather than a request failure: the widget still
      // loads, it just will not know who the visitor is.
      if (!website?.identity_secret) {
        return reply.send({ enabled: Boolean(website), context_token: null });
      }

      const user = await unscopedPrisma.users.findUnique({
        where: { id: req.auth!.userId },
        select: { id: true, name: true, email: true },
      });
      if (!user) return reply.code(401).send({ error: 'Account unavailable' });

      const memberships = await unscopedPrisma.workspace_members.findMany({
        where: { user_id: user.id, status: 'active' },
        select: {
          role: true,
          workspace: {
            select: {
              id: true,
              slug: true,
              name: true,
              subscription_status: true,
              plan: { select: { code: true } },
            },
          },
        },
        orderBy: { created_at: 'asc' },
      });

      // The workspace they are actually looking at, when the client says; their
      // first otherwise. An agent needs the one on screen, not an arbitrary one.
      const asked = (req.query as { workspace?: string }).workspace;
      const active =
        memberships.find((m) => m.workspace.slug === asked || m.workspace.id === asked) ??
        memberships[0];

      const now = Math.floor(Date.now() / 1000);
      const context_token = jwt.sign(
        {
          customer: { id: user.id, name: user.name, email: user.email },
          attributes: {
            // Deliberately flat and short: `attributes` is capped at 50 keys and
            // rendered as a list on the agent's sidebar, not as a data dump.
            workspace: active?.workspace.name ?? 'no workspace',
            workspace_slug: active?.workspace.slug ?? '',
            plan: active?.workspace.plan.code ?? '',
            subscription: active?.workspace.subscription_status ?? '',
            role: active?.role ?? '',
            workspaces: memberships.length,
            // Which buttons they can even see, so support does not talk an agent
            // through a settings page their role does not render.
            can_manage_billing: active
              ? capabilitiesFor(active.role as WorkspaceRole).has('billing:manage')
              : false,
          },
          iat: now,
          exp: now + CONTEXT_TTL_SECONDS,
        },
        website.identity_secret,
        { algorithm: 'HS256' },
      );

      return reply.send({ enabled: true, key, context_token });
    },
  );
}
