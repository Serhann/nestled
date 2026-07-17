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
