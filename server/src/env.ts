import 'dotenv/config';
import { z } from 'zod';

/**
 * Central, validated environment. The process refuses to boot if a required
 * secret is missing — this is deliberate: no silent fallback to insecure
 * defaults for anything security-relevant (JWT secrets, DB URL).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth secrets — must be long random strings in production.
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be >=16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be >=16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Comma-separated list of allowed browser origins for CORS. This governs the
  // PRIVATE app surface only (app/ops). The public widget surface is embedded on
  // arbitrary customer domains, so where the widget may run is enforced by a
  // per-website domain allowlist, never by this list.
  ALLOWED_ORIGINS: z
    .string()
    .default('https://app.nestled.chat,https://ops.nestled.chat,https://nestled.chat,http://localhost:5173'),

  // AI (Phase 7 expands this; adapters read these at call time).
  AI_PROVIDER: z.enum(['knowledge_base', 'anthropic', 'openai', 'ollama']).default('anthropic'),
  AI_MODEL: z.string().default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().optional(),

  // Optional secondary notification channel.
  DISCORD_WEBHOOK_URL: z.string().optional(),

  // Web Push (VAPID). Generate with `npm run vapid`. When unset, push is
  // disabled gracefully (subscriptions still store; no sends attempted).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // Contact URI required by the push spec; a mailto: or https: URL.
  VAPID_SUBJECT: z.string().default('mailto:support@nestled.chat'),

  // Path to a local MaxMind GeoLite2 .mmdb (Country or City). When unset or
  // missing, geo lookups fall back to the MaxMind web service (below) or, if
  // that's also unset, return null gracefully (no external API is ever hit).
  GEOLITE2_DB_PATH: z.string().optional(),

  // MaxMind GeoIP web service (per-IP REST lookup). When the account id + key
  // are set, IP geo is fetched from MaxMind instead of the local DB. This is the
  // BASE endpoint (the IP is appended by the app). Default is GeoIP2 Precision
  // City; for the free GeoLite2 service use https://geolite.info/geoip/v2.1/city.
  MAXMIND_ACCOUNT_ID: z.string().optional(),
  MAXMIND_LICENSE_KEY: z.string().optional(),
  MAXMIND_ENDPOINT: z.string().default('https://geoip.maxmind.com/geoip/v2.1/city'),

  // Where uploaded attachments are stored on disk, and the per-file size cap.
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // Optional error sink (Sentry-compatible DSN). When set, the error handler
  // has a forwarding hook point.
  SENTRY_DSN: z.string().optional(),

  // Data retention: delete resolved conversations (and their attachments)
  // older than this many days. 0 disables retention entirely.
  RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
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
