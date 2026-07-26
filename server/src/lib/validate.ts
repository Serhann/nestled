import type { FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * Parse an unknown body against a zod schema. On failure, sends a 400 with the
 * issues and returns null so the caller can `if (!data) return;`.
 */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    void reply.code(400).send({
      error: 'Invalid request',
      details: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return null;
  }
  return result.data;
}

/**
 * Parse a PARTIAL update, keeping only the fields the caller actually sent.
 *
 * This exists because of a genuinely surprising zod behaviour: `.partial()` makes
 * a field optional but does NOT remove its `.default()`. So validating
 * `{ question: 'new text' }` against `kbBody.partial()` yields
 * `{ question: 'new text', category: 'general', is_active: true }` — and writing
 * that straight to the database silently resets two columns the customer never
 * touched. It is the worst kind of bug: no error, no clue, and the damage is only
 * noticed later by someone wondering why their entry turned itself back on.
 *
 * Intersecting the parsed object with the keys present in the raw body removes
 * every value zod invented.
 */
export function parsePatch<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): Partial<z.infer<T>> | null {
  const parsed = parseBody(schema.partial(), body, reply);
  if (!parsed) return null;
  if (typeof body !== 'object' || body === null) return {};

  const sent = new Set(Object.keys(body as Record<string, unknown>));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (sent.has(key)) out[key] = value;
  }
  return out as Partial<z.infer<T>>;
}
