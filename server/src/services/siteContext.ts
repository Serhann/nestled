import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';

/**
 * Signed visitor context (server-pull + client-hint hybrid).
 *
 * The host site (e.g. JetFood, an old PHP SSR app) already knows the logged-in
 * customer and their orders server-side. Rather than expose a queryable API, it
 * signs that data into a short-lived JWT (HS256) with a per-site shared secret
 * and drops the token into the page. The widget carries the token to us; we
 * verify the signature with the same secret. A valid signature proves the data
 * came from the host's server — so it is TRUSTED, not client-spoofable, even
 * though it travelled through the browser.
 *
 * Read-only: we display and use this context; we never write back to the host.
 */

const orderSchema = z.object({
  id: z.string().max(64).optional(),
  status: z.string().max(64).optional(),
  eta: z.string().max(64).optional(),
  restaurant: z.string().max(160).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(8).optional(),
  date: z.string().max(40).optional(),
  url: z.string().max(500).optional(),
});

const contextSchema = z.object({
  customer: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      name: z.string().max(200).optional(),
      email: z.string().email().max(200).optional(),
      phone: z.string().max(40).optional(),
      orders_count: z.number().int().nonnegative().optional(),
      since: z.string().max(40).optional(),
    })
    .optional(),
  current_order: orderSchema.optional(),
  recent_orders: z.array(orderSchema).max(20).optional(),
});

export type VisitorContext = z.infer<typeof contextSchema>;

/** The per-site HMAC secret for a given site key (`mode`), or null if unset. */
export async function siteContextSecret(mode: string | null | undefined): Promise<string | null> {
  if (!mode) return null;
  const site = await prisma.sites.findUnique({
    where: { key: mode },
    select: { context_secret: true },
  });
  return site?.context_secret || null;
}

/**
 * Verify a signed context token against a site's secret and return the parsed,
 * schema-validated context. Returns null on any failure (bad signature, expired,
 * malformed, unknown site, or signing disabled) — callers treat null as "no
 * trusted context" and fall back to unsigned client hints for display only.
 */
export async function verifyContextToken(
  mode: string | null | undefined,
  token: string | null | undefined,
): Promise<VisitorContext | null> {
  if (!token) return null;
  const secret = await siteContextSecret(mode);
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 60 });
    if (typeof decoded !== 'object' || decoded === null) return null;
    // Strip standard JWT claims before validating the payload shape.
    const { iss: _iss, iat: _iat, exp: _exp, nbf: _nbf, aud: _aud, sub: _sub, ...rest } =
      decoded as Record<string, unknown>;
    const parsed = contextSchema.safeParse(rest);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
