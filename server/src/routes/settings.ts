import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireAdmin } from '../plugins/auth.js';
import { parseBody } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

// Columns an admin may write. Secrets are handled separately (write-only).
const PUBLIC_COLUMNS = [
  'widget_title',
  'welcome_message',
  'primary_color',
  'widget_position',
  'widget_avatar_url',
  'ai_enabled',
  'pre_chat_enabled',
  'pre_chat_fields',
  'auto_welcome_enabled',
  'auto_welcome_message',
  'auto_welcome_delay',
  'notification_sound_enabled',
  'magic_browse_enabled',
] as const;

const PRIVATE_NONSECRET_COLUMNS = [
  'ai_provider',
  'ai_model',
  'ai_response_mode',
  'system_prompt',
  'openai_model',
  'ollama_url',
  'ollama_model',
  'discord_webhook_enabled',
  'discord_notify_new_chat',
  'discord_notify_new_message',
] as const;

// Secret columns are never returned verbatim; on write, empty/omitted = unchanged.
const SECRET_COLUMNS = ['anthropic_api_key', 'openai_api_key', 'discord_webhook_url'] as const;

const publicUpdate = z
  .object({
    widget_title: z.string().max(200),
    welcome_message: z.string().max(1000),
    primary_color: z.string().max(20),
    widget_position: z.enum(['left', 'right']),
    widget_avatar_url: z.string().max(500).nullable(),
    ai_enabled: z.boolean(),
    pre_chat_enabled: z.boolean(),
    pre_chat_fields: z.array(z.record(z.string(), z.unknown())),
    auto_welcome_enabled: z.boolean(),
    auto_welcome_message: z.string().max(1000).nullable(),
    auto_welcome_delay: z.number().int().min(0).max(600),
    notification_sound_enabled: z.boolean(),
    magic_browse_enabled: z.boolean(),
  })
  .partial();

const privateUpdate = z
  .object({
    ai_provider: z.enum(['knowledge_base', 'anthropic', 'openai', 'ollama']),
    ai_model: z.string().max(100),
    ai_response_mode: z.enum(['off', 'first_message', 'when_no_agent_online', 'always']),
    system_prompt: z.string().max(8000),
    openai_model: z.string().max(100),
    ollama_url: z.string().max(500).nullable(),
    ollama_model: z.string().max(100),
    discord_webhook_enabled: z.boolean(),
    discord_notify_new_chat: z.boolean(),
    discord_notify_new_message: z.boolean(),
    // Secrets: string writes the value; empty string / omitted leaves unchanged; null clears.
    anthropic_api_key: z.string().nullable(),
    openai_api_key: z.string().nullable(),
    discord_webhook_url: z.string().nullable(),
  })
  .partial();

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `••••${tail}`;
}

function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  allowed: readonly string[],
): { sql: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const key of allowed) {
    if (!(key in data)) continue;
    // For secrets, an empty string means "leave unchanged".
    if ((SECRET_COLUMNS as readonly string[]).includes(key) && data[key] === '') continue;
    sets.push(`${key} = $${i++}`);
    params.push(data[key]);
  }
  if (sets.length === 0) return null;
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`,
    params,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Admin view: full config with secrets masked (booleans indicate presence).
  app.get('/api/settings', { preHandler: requireAdmin }, async (_req, reply) => {
    const publicSettings = await queryOne(`SELECT * FROM public_settings WHERE id = 1`);
    const priv = await queryOne<Record<string, unknown>>(`SELECT * FROM private_settings WHERE id = 1`);

    const privateSettings: Record<string, unknown> = { ...priv };
    for (const col of SECRET_COLUMNS) {
      const value = (priv?.[col] as string | null) ?? null;
      privateSettings[col] = maskSecret(value); // masked display value
      privateSettings[`${col}_set`] = Boolean(value); // presence flag for the UI
    }
    return reply.send({ public: publicSettings, private: privateSettings });
  });

  app.put('/api/settings/public', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(publicUpdate, req.body, reply);
    if (!body) return;
    const update = buildUpdate('public_settings', body, PUBLIC_COLUMNS);
    if (update) await query(update.sql, update.params as never[]);
    await audit(req, { action: 'settings.public.update', targetType: 'public_settings' });
    const settings = await queryOne(`SELECT * FROM public_settings WHERE id = 1`);
    return reply.send({ public: settings });
  });

  app.put('/api/settings/private', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseBody(privateUpdate, req.body, reply);
    if (!body) return;
    const allowed = [...PRIVATE_NONSECRET_COLUMNS, ...SECRET_COLUMNS];
    const update = buildUpdate('private_settings', body, allowed);
    if (update) await query(update.sql, update.params as never[]);
    // Record which fields changed WITHOUT recording secret values.
    const changedKeys = Object.keys(body).filter((k) => k in body);
    await audit(req, {
      action: 'settings.private.update',
      targetType: 'private_settings',
      details: { fields: changedKeys, secrets_touched: SECRET_COLUMNS.filter((c) => c in body) },
    });
    return reply.send({ ok: true });
  });

  // AI token usage — current calendar month total, for cost monitoring.
  app.get('/api/ai/usage', { preHandler: requireAdmin }, async (_req, reply) => {
    const row = await queryOne<{ replies: number; input_tokens: number; output_tokens: number }>(
      `SELECT COUNT(*)::int AS replies,
              COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::int AS output_tokens
         FROM ai_usage
        WHERE created_at >= date_trunc('month', now())`,
    );
    return reply.send({ month: row });
  });
}
