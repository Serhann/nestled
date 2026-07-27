import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { allowedOrigins, env } from '../../env.js';
// Install-wide configuration is not tenant data; there is exactly one row and it
// is read on the hot path by services that have no request context.
// eslint-disable-next-line no-restricted-imports -- install-wide singleton, no tenant scope exists
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * Install-wide settings.
 *
 * Running Nestled should not mean maintaining thirty environment variables. An
 * API key, an SMTP host or a MaxMind licence is a SETTING — something an operator
 * changes on a Tuesday afternoon — not part of the deployment topology. In the
 * environment, changing one means a container restart and usually a redeploy.
 *
 * Three things make this work without disrupting anything:
 *
 * 1. **Reads are synchronous.** Half the consumers are sync functions
 *    (`isPushEnabled`, `stripeConfigured`, `webhookSecret`, `returnUrl`), and
 *    making them async would ripple through the whole codebase for no gain. So
 *    the row is loaded into a snapshot at boot and refreshed after every write.
 *    With one replica — which the realtime plane already requires — a write is
 *    visible immediately; the periodic reload bounds staleness if that ever
 *    changes.
 *
 * 2. **The environment still works.** A value is taken from the database when
 *    set, from the environment when not, and from a default otherwise. Existing
 *    deployments keep running untouched, and anyone who prefers config-as-code
 *    can carry on using env vars — they simply are not required any more.
 *
 * 3. **Secrets are encrypted at rest when SETTINGS_KEY is set**, and are never
 *    returned by the API. A leaked database backup containing conversation
 *    history is bad; one containing a live Stripe secret key is a different
 *    category of bad, because that key moves money.
 */

export interface PlatformSettings {
  ai: {
    provider: 'knowledge_base' | 'anthropic' | 'openai' | 'ollama';
    model: string;
    anthropicApiKey: string | null;
    openaiApiKey: string | null;
    ollamaUrl: string | null;
  };
  /**
   * How a message gets translated.
   *
   * `llm` reuses whatever the `ai` block is pointed at. `deepl` uses a dedicated
   * machine-translation endpoint, which is both faster and — the reason that
   * actually matters — has no instruction channel a visitor's message could
   * hijack. Falls back to `llm` when a DeepL key is not set, so choosing the
   * provider and forgetting the credential degrades instead of breaking.
   */
  translate: {
    provider: 'llm' | 'deepl';
    deeplApiKey: string | null;
  };
  /** Twilio, for the SMS channel. Platform level — see migration 0006. */
  sms: { accountSid: string | null; authToken: string | null };
  /** Inbound mail: the shared secret the webhook verifies, and our receiving domain. */
  inboundMail: { secret: string | null; domain: string | null };
  mail: {
    host: string | null;
    port: number;
    secure: boolean;
    user: string | null;
    password: string | null;
    from: string;
  };
  push: { publicKey: string | null; privateKey: string | null; subject: string };
  geo: {
    dbPath: string | null;
    maxmindAccountId: string | null;
    maxmindLicenseKey: string | null;
    maxmindEndpoint: string;
  };
  billing: { secretKey: string | null; webhookSecret: string | null; returnUrl: string | null };
  urls: { app: string; marketing: string };
  /** Nestled's own support chat, served on our marketing site and in the panel. */
  support: { websiteKey: string | null };
  ops: {
    discordWebhookUrl: string | null;
    sentryDsn: string | null;
    retentionDays: number;
    platformSessionTtlHours: number;
  };
}

/**
 * Which columns hold a credential.
 *
 * One list, used by three things that must agree: what gets encrypted, what the
 * API refuses to return, and what the ops panel renders as a write-only field.
 * Three separate lists is how a new secret ends up encrypted but still readable.
 */
export const SECRET_FIELDS = [
  'anthropic_api_key',
  'openai_api_key',
  'deepl_api_key',
  'twilio_auth_token',
  'inbound_mail_secret',
  'smtp_password',
  'vapid_private_key',
  'maxmind_license_key',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'discord_webhook_url',
] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];
const SECRETS = new Set<string>(SECRET_FIELDS);

// ── Encryption at rest ──────────────────────────────────────────────────────

const ENCRYPTED_PREFIX = 'enc.v1.';

/** 32 bytes from SETTINGS_KEY, or null when the operator has not set one. */
function key(): Buffer | null {
  const raw = process.env.SETTINGS_KEY;
  if (!raw) return null;
  // Hashed rather than required to be exactly 32 bytes: an operator pasting
  // `openssl rand -base64 48` should not get a length error.
  return createHash('sha256').update(raw).digest();
}

export function encryptionEnabled(): boolean {
  return key() !== null;
}

function encrypt(value: string): string {
  const k = key();
  if (!k) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const out = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${out.toString('base64url')}`;
}

function decrypt(value: string): string | null {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // written before a key existed
  const k = key();
  if (!k) return null; // the key was removed; report absent rather than garbage
  try {
    const [iv, tag, body] = value.slice(ENCRYPTED_PREFIX.length).split('.');
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // A wrong key must not look like an empty setting, or an operator will spend
    // an afternoon wondering why their Stripe key "disappeared".
    // eslint-disable-next-line no-console
    console.error('[settings] a stored secret could not be decrypted — is SETTINGS_KEY the one it was written with?');
    return null;
  }
}

// ── The snapshot ────────────────────────────────────────────────────────────

/** A row shape wide enough to resolve from, without importing Prisma's types. */
type Row = Partial<Record<string, string | number | boolean | null>>;

/**
 * A function DECLARATION, not a const arrow: the initial snapshot below is built
 * at module load, which happens before a `const` in the same scope is
 * initialized. As an arrow it threw "Cannot access 'str' before initialization"
 * on import — a temporal-dead-zone bug that only shows up at boot.
 */
function str(row: Row, column: string, fallback: string | null): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = String(raw);
  return SECRETS.has(column) ? decrypt(value) : value;
}

/**
 * Where the app and the marketing site live, when nobody has said.
 *
 * Derived from ALLOWED_ORIGINS, which the operator has already had to get right
 * for anything to work at all. Without this the default would be localhost, and
 * the failure mode is nasty and quiet: the install runs perfectly, and every
 * verification and invitation email points at a machine the recipient does not
 * have. They do not report it — they simply never confirm.
 *
 * The ops panel can still override it; this is only the starting value.
 */
function derivedUrl(which: 'app' | 'marketing'): string {
  const origins = allowedOrigins.filter((o) => /^https?:\/\//.test(o));
  const isLocal = (o: string): boolean => o.includes('localhost') || o.includes('127.0.0.1');
  const remote = origins.filter((o) => !isLocal(o));
  const pool = remote.length > 0 ? remote : origins;

  if (which === 'app') {
    const app = pool.find((o) => new URL(o).hostname.startsWith('app.'));
    if (app) return app;
    // The single-origin layout: everything behind one host under path prefixes.
    return pool[0] ? `${pool[0].replace(/\/+$/, '')}/app` : 'http://localhost:5173/app';
  }

  const marketing = pool.find((o) => !/^(app|ops|widget)\./.test(new URL(o).hostname));
  return marketing ?? pool[0] ?? 'http://localhost:5173';
}

let snapshot: PlatformSettings = resolve({});
let loaded = false;

function resolve(row: Row): PlatformSettings {
  const e = process.env;
  const num = (column: string, fallback: number): number => {
    const raw = row[column];
    if (raw === null || raw === undefined) return fallback;
    return Number(raw);
  };
  const appUrl = str(row, 'app_url', e.APP_URL ?? null) ?? derivedUrl('app');

  return {
    ai: {
      provider: (str(row, 'ai_provider', e.AI_PROVIDER ?? null) ??
        'anthropic') as PlatformSettings['ai']['provider'],
      model: str(row, 'ai_model', e.AI_MODEL ?? null) ?? 'claude-opus-4-8',
      anthropicApiKey: str(row, 'anthropic_api_key', e.ANTHROPIC_API_KEY ?? null),
      openaiApiKey: str(row, 'openai_api_key', e.OPENAI_API_KEY ?? null),
      ollamaUrl: str(row, 'ollama_url', e.OLLAMA_URL ?? null),
    },
    translate: {
      // A provider set to deepl with no key would silently translate nothing, so it
      // is resolved back to the LLM here rather than failing at call time.
      provider:
        str(row, 'translate_provider', null) === 'deepl' && str(row, 'deepl_api_key', null)
          ? 'deepl'
          : 'llm',
      deeplApiKey: str(row, 'deepl_api_key', null),
    },
    sms: {
      accountSid: str(row, 'twilio_account_sid', e.TWILIO_ACCOUNT_SID ?? null),
      authToken: str(row, 'twilio_auth_token', e.TWILIO_AUTH_TOKEN ?? null),
    },
    inboundMail: {
      secret: str(row, 'inbound_mail_secret', null),
      domain: str(row, 'inbound_mail_domain', null),
    },
    mail: {
      host: str(row, 'smtp_host', e.SMTP_HOST ?? null),
      port: num('smtp_port', Number(e.SMTP_PORT ?? 587)),
      secure: row.smtp_secure === null || row.smtp_secure === undefined
        ? e.SMTP_SECURE === 'true'
        : Boolean(row.smtp_secure),
      user: str(row, 'smtp_user', e.SMTP_USER ?? null),
      password: str(row, 'smtp_password', e.SMTP_PASSWORD ?? null),
      from: str(row, 'mail_from', e.MAIL_FROM ?? null) ?? 'Nestled <noreply@nestled.chat>',
    },
    push: {
      publicKey: str(row, 'vapid_public_key', e.VAPID_PUBLIC_KEY ?? null),
      privateKey: str(row, 'vapid_private_key', e.VAPID_PRIVATE_KEY ?? null),
      subject: str(row, 'vapid_subject', e.VAPID_SUBJECT ?? null) ?? 'mailto:support@nestled.chat',
    },
    geo: {
      dbPath: str(row, 'geolite2_db_path', e.GEOLITE2_DB_PATH ?? null),
      maxmindAccountId: str(row, 'maxmind_account_id', e.MAXMIND_ACCOUNT_ID ?? null),
      maxmindLicenseKey: str(row, 'maxmind_license_key', e.MAXMIND_LICENSE_KEY ?? null),
      maxmindEndpoint:
        str(row, 'maxmind_endpoint', e.MAXMIND_ENDPOINT ?? null) ??
        'https://geoip.maxmind.com/geoip/v2.1/city',
    },
    billing: {
      secretKey: str(row, 'stripe_secret_key', e.STRIPE_SECRET_KEY ?? null),
      webhookSecret: str(row, 'stripe_webhook_secret', e.STRIPE_WEBHOOK_SECRET ?? null),
      returnUrl: str(row, 'stripe_return_url', e.STRIPE_RETURN_URL ?? null),
    },
    urls: {
      app: appUrl,
      marketing: str(row, 'marketing_url', e.MARKETING_URL ?? null) ?? derivedUrl('marketing'),
    },
    support: {
      websiteKey: str(row, 'support_website_key', e.SUPPORT_WEBSITE_KEY ?? null),
    },
    ops: {
      discordWebhookUrl: str(row, 'discord_webhook_url', e.DISCORD_WEBHOOK_URL ?? null),
      sentryDsn: str(row, 'sentry_dsn', e.SENTRY_DSN ?? null),
      retentionDays: num('retention_days', Number(e.RETENTION_DAYS ?? 0)),
      platformSessionTtlHours: num(
        'platform_session_ttl_hours',
        Number(e.PLATFORM_SESSION_TTL_HOURS ?? 12),
      ),
    },
  };
}

/** The current settings. Synchronous by design — see the note at the top. */
export function settings(): PlatformSettings {
  return snapshot;
}

/** True once the database row has actually been read. */
export function settingsLoaded(): boolean {
  return loaded;
}

/**
 * Read the row and replace the snapshot.
 *
 * Failure is not fatal: a database hiccup at boot should leave the process
 * running on environment values rather than refusing to start, because the
 * alternative is an install that cannot serve its own health check.
 */
export async function loadSettings(): Promise<void> {
  try {
    const row = await unscopedPrisma.platform_settings.findUnique({ where: { id: 1 } });
    snapshot = resolve((row ?? {}) as Row);
    loaded = true;
  } catch {
    snapshot = resolve({});
  }
}

/** Test seam: force a snapshot without touching the database. */
export function setSettingsForTests(row: Record<string, unknown>): void {
  snapshot = resolve(row as Row);
  loaded = true;
}

export interface SettingsPatch {
  [column: string]: string | number | boolean | null | undefined;
}

/**
 * Write a partial update and refresh the snapshot.
 *
 * An empty string clears a value (falling the setting back to its environment
 * value or default); `undefined` leaves it alone. That distinction is what lets
 * the ops panel offer "clear this" without it being the same gesture as "I did
 * not touch this field" — the mistake that silently wipes a Stripe key.
 */
export async function updateSettings(patch: SettingsPatch, editedBy?: string): Promise<void> {
  const data: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && SECRETS.has(column)) {
      data[column] = value === '' ? null : encrypt(value);
    } else {
      data[column] = value === '' ? null : value;
    }
  }
  if (Object.keys(data).length === 0) return;
  data.updated_by = editedBy ?? null;

  await unscopedPrisma.platform_settings.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });
  await loadSettings();
}

/**
 * What the ops panel is allowed to see.
 *
 * Secrets are reported as present or absent with a short hint, never as a value.
 * A settings page that renders your Stripe key is a settings page that puts it in
 * a screenshot, a screen-share and a browser's autofill history.
 */
export function redactedSettings(): Record<string, unknown> {
  const s = snapshot;
  const mask = (value: string | null): { set: boolean; hint: string | null } => ({
    set: Boolean(value),
    hint: value ? `…${value.slice(-4)}` : null,
  });

  return {
    encryption_enabled: encryptionEnabled(),
    ai: {
      provider: s.ai.provider,
      model: s.ai.model,
      anthropic_api_key: mask(s.ai.anthropicApiKey),
      openai_api_key: mask(s.ai.openaiApiKey),
      ollama_url: s.ai.ollamaUrl,
    },
    translate: {
      provider: s.translate.provider,
      deepl_api_key: mask(s.translate.deeplApiKey),
    },
    sms: {
      twilio_account_sid: s.sms.accountSid,
      twilio_auth_token: mask(s.sms.authToken),
    },
    inbound_mail: {
      inbound_mail_secret: mask(s.inboundMail.secret),
      inbound_mail_domain: s.inboundMail.domain,
    },
    mail: {
      smtp_host: s.mail.host,
      smtp_port: s.mail.port,
      smtp_secure: s.mail.secure,
      smtp_user: s.mail.user,
      smtp_password: mask(s.mail.password),
      mail_from: s.mail.from,
    },
    push: {
      // The PUBLIC key is public by definition — the widget ships it to every
      // visitor — so hiding it here would be theatre that makes it unverifiable.
      vapid_public_key: s.push.publicKey,
      vapid_private_key: mask(s.push.privateKey),
      vapid_subject: s.push.subject,
    },
    geo: {
      geolite2_db_path: s.geo.dbPath,
      maxmind_account_id: s.geo.maxmindAccountId,
      maxmind_license_key: mask(s.geo.maxmindLicenseKey),
      maxmind_endpoint: s.geo.maxmindEndpoint,
    },
    billing: {
      stripe_secret_key: mask(s.billing.secretKey),
      stripe_webhook_secret: mask(s.billing.webhookSecret),
      stripe_return_url: s.billing.returnUrl,
    },
    urls: { app_url: s.urls.app, marketing_url: s.urls.marketing },
    // Not masked: an embed key is public by design — it is pasted into a page.
    support: { support_website_key: s.support.websiteKey },
    ops: {
      discord_webhook_url: mask(s.ops.discordWebhookUrl),
      sentry_dsn: s.ops.sentryDsn,
      retention_days: s.ops.retentionDays,
      platform_session_ttl_hours: s.ops.platformSessionTtlHours,
    },
  };
}

/**
 * Reload periodically.
 *
 * A safety net rather than the mechanism: a write refreshes the snapshot
 * immediately. This exists so that a second replica, or a value changed straight
 * in the database, converges within a minute instead of at the next restart.
 */
export function startSettingsRefresh(intervalMs = 60_000): void {
  if (env.NODE_ENV === 'test') return;
  setInterval(() => void loadSettings(), intervalMs).unref();
}
