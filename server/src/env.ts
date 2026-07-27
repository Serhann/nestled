import 'dotenv/config';
import { z } from 'zod';

/**
 * The environment.
 *
 * Deliberately short. Everything here is either a secret the process needs before
 * it can read a database, or a fact about WHERE this container runs — the kind of
 * thing that changes when you move hosts, not on a Tuesday afternoon.
 *
 * Everything else — AI keys, SMTP, Stripe, GeoIP, VAPID, the public URLs,
 * retention — lives in the `platform_settings` table and is edited from the ops
 * panel. Those are settings, and a setting in the environment means a container
 * restart to change, usually a redeploy, and a config file that grows until
 * nobody knows which half of it is still wired to anything.
 *
 * The old variables still WORK: services/platform/settings.ts takes a value from
 * the database first and falls back to the matching environment variable. An
 * existing deployment keeps running untouched and config-as-code stays possible
 * for anyone who prefers it. They are simply no longer required, and no longer
 * listed in the compose files.
 *
 * The process refuses to boot if a required secret is missing. That is
 * deliberate: no silent fallback to an insecure default.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth secrets. These cannot live in the database: they are what proves a
  // request is allowed to reach the database in the first place.
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be >=16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be >=16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * Encrypts the secrets stored in `platform_settings` (AES-256-GCM).
   *
   * Optional, and worth setting. Without it those values sit in the database in
   * plain text — and while the database already holds conversation history, a
   * leaked backup containing a live Stripe secret key is a different category of
   * problem, because that key moves money. Any string; it is hashed to 32 bytes.
   *
   * Changing it makes existing stored secrets unreadable. They are reported as
   * absent — loudly, in the log — rather than as garbage, and can be re-entered.
   */
  SETTINGS_KEY: z.string().optional(),

  /**
   * Which browser origins may call the API.
   *
   * Deployment topology rather than a setting: it is handed to the CORS plugin at
   * boot and describes where THIS install is served from.
   *
   * The private surfaces only — app, ops, widget, marketing. Customer domains do
   * NOT belong here; where a widget may run is per-website, in
   * `websites.allowed_domains`. Omitting the widget origin makes every widget
   * call fail in the browser with a CORS error that looks like an outage.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default(
      'https://app.nestled.chat,https://ops.nestled.chat,https://widget.nestled.chat,https://nestled.chat,http://localhost:5173',
    ),

  // Where uploads land on this machine, and the per-file cap the multipart plugin
  // is configured with at boot.
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /**
   * Run `prisma migrate deploy` during boot.
   *
   * Convenient for a single container, and a footgun the moment there are two:
   * both replicas race the same migration, and a slow one delays every restart
   * behind it. The compose stack turns this off and runs migrations as a one-shot
   * release step the app waits on. Defaults to true so a bare `docker run` of the
   * image still comes up with a usable database.
   */
  MIGRATE_ON_BOOT: z.enum(['true', 'false']).default('true'),

  // ── One-time bootstrap ──────────────────────────────────────────────────────
  // Both no-op once their table has a row. Everyone else signs up or is invited.
  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().default('Admin'),
  /** The first STAFF account, for the ops panel. Read-only until TOTP is enrolled. */
  SEED_PLATFORM_EMAIL: z.string().optional(),
  SEED_PLATFORM_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const isProd = env.NODE_ENV === 'production';
