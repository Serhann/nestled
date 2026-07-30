import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import { platformCan, platformRead } from './guards.js';
import {
  SECRET_FIELDS,
  redactedSettings,
  settings,
  updateSettings,
} from '../../services/platform/settings.js';
import { sendEmail } from '../../services/email.js';
import { validateVapidPair } from '../../services/push.js';

/**
 * Install-wide settings.
 *
 * This is the page that took thirty environment variables out of the deployment.
 * An API key, an SMTP host, a MaxMind licence — these are things an operator
 * changes on a Tuesday afternoon, and in the environment each change costs a
 * container restart and usually a redeploy.
 *
 * Two rules hold throughout:
 *
 *   - **Secrets go in and never come out.** The GET reports whether each one is
 *     set plus its last four characters, never the value. A settings page that
 *     renders your Stripe key is a settings page that puts it into a screenshot,
 *     a screen share and a browser's autofill history.
 *   - **Empty string clears, absent leaves alone.** Those are different gestures.
 *     Conflating them is how a form submission that touched only the SMTP host
 *     silently wipes the Stripe key.
 */

/** An optional string field: absent leaves it, '' clears it, a value sets it. */
const text = (max = 500) => z.string().max(max).optional();

const settingsBody = z.object({
  // AI
  ai_provider: z.enum(['knowledge_base', 'anthropic', 'openai', 'ollama']).optional(),
  ai_model: text(120),
  anthropic_api_key: text(200),
  openai_api_key: text(200),
  ollama_url: text(300),

  // Translation. Empty string on the provider clears it back to NULL, which the
  // settings layer reads as "use the configured LLM".
  translate_provider: z.enum(['llm', 'deepl', '']).optional(),
  deepl_api_key: text(200),

  // Channels
  twilio_account_sid: text(100),
  twilio_auth_token: text(200),
  inbound_mail_secret: text(200),
  inbound_mail_domain: text(200),

  // Email
  smtp_host: text(200),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_secure: z.boolean().optional(),
  smtp_user: text(200),
  smtp_password: text(300),
  mail_from: text(200),

  // Push
  vapid_public_key: text(200),
  vapid_private_key: text(200),
  vapid_subject: text(200),

  // Geo
  geolite2_db_path: text(400),
  maxmind_account_id: text(60),
  maxmind_license_key: text(200),
  maxmind_endpoint: text(300),

  // Billing
  stripe_secret_key: text(200),
  stripe_webhook_secret: text(200),
  stripe_return_url: text(400),

  // Our own support chat
  support_website_key: text(64),

  // URLs
  app_url: text(300),
  marketing_url: text(300),

  // Operations
  discord_webhook_url: text(500),
  sentry_dsn: text(400),
  retention_days: z.coerce.number().int().min(0).max(3650).optional(),
  platform_session_ttl_hours: z.coerce.number().int().min(1).max(720).optional(),
});

export async function platformSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/settings', { preHandler: platformRead }, async (_req, reply) =>
    reply.send({ settings: redactedSettings() }),
  );

  /**
   * Needs `settings:write` (superadmin by default) and a verified second factor.
   *
   * These fields reach every customer at once — the AI key that answers their
   * chats, the SMTP host their verification mail goes through, the Stripe key
   * that bills them. Support and billing staff can read them; changing them is a
   * different kind of act.
   */
  app.patch(
    '/platform/settings',
    { preHandler: platformCan('settings:write') },
    async (req, reply) => {
      const body = parseBody(settingsBody, req.body, reply);
      if (!body) return;

      /**
       * Refuse a VAPID pair that web-push will not load.
       *
       * Not politeness. `setVapidDetails` validates and throws, the senders are called as
       * `void push…(…)`, and an unawaited rejection terminates the process — so a mistyped
       * private key saved here used to 502 the next visitor who sent a message, and every
       * request in flight with it. That is now contained twice over (services/push.ts and
       * lib/crashGuard.ts), which makes this the third layer: refuse the value at the one
       * moment a human is looking at the field, instead of storing something that silently
       * turns push off.
       */
      const vapidPublic = body.vapid_public_key ?? settings().push.publicKey;
      const vapidPrivate = body.vapid_private_key ?? settings().push.privateKey;
      const vapidSubject = body.vapid_subject ?? settings().push.subject;
      const touchesVapid =
        body.vapid_public_key !== undefined ||
        body.vapid_private_key !== undefined ||
        body.vapid_subject !== undefined;
      // A pair being CLEARED is valid — that is how push is turned off.
      if (touchesVapid && vapidPublic && vapidPrivate) {
        const check = validateVapidPair(vapidSubject, vapidPublic, vapidPrivate);
        if (!check.ok) {
          return reply.code(400).send({
            error: `Web Push keys rejected: ${check.reason} Run \`npm run vapid\` in the server directory for a valid pair.`,
            code: 'vapid_invalid',
            field: 'vapid_private_key',
          });
        }
      }

      await updateSettings(body, req.platform!.id);

      // The audit entry names the fields, never the values, and marks which of
      // them were secrets — so "who changed the Stripe key and when" is answerable
      // without the log itself becoming a place credentials leak.
      const changed = Object.keys(body);
      await audit(req, {
        action: 'platform.settings_updated',
        details: {
          fields: changed,
          secrets_changed: changed.filter((f) => (SECRET_FIELDS as readonly string[]).includes(f)),
        },
      });

      return reply.send({ settings: redactedSettings() });
    },
  );

  /**
   * Send a test email.
   *
   * The single most common configuration mistake is SMTP that looks right and
   * silently fails, discovered days later when a customer says they never got a
   * verification link. One button turns that into a five-second check.
   */
  app.post(
    '/platform/settings/test-email',
    { preHandler: platformCan('settings:write') },
    async (req, reply) => {
      const body = parseBody(z.object({ to: z.string().email() }), req.body, reply);
      if (!body) return;

      if (!settings().mail.host) {
        return reply.code(400).send({
          error: 'No SMTP host configured. Mail is being queued and logged instead of sent.',
          code: 'smtp_unconfigured',
        });
      }

      try {
        await sendEmail({
          to: body.to,
          template: 'verify_email',
          vars: { name: 'there', url: settings().urls.app },
        });
        return reply.send({ ok: true, sent_to: body.to, via: settings().mail.host });
      } catch (err) {
        // The provider's own message is the useful part — "535 authentication
        // failed" tells the operator what to fix, "could not send" does not.
        return reply.code(502).send({ error: (err as Error).message, code: 'smtp_failed' });
      }
    },
  );
}
