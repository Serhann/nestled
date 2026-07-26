import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';

/**
 * Signed visitor attributes (server-pull + client-hint hybrid).
 *
 * The host site already knows who the logged-in visitor is and whatever state
 * matters to them (plan, account tier, an open ticket, a pending order — it is
 * the customer's domain, not ours). Rather than expose a queryable API, the host
 * signs that data into a short-lived JWT (HS256) with a per-website shared secret
 * and drops the token into the page. The widget carries the token to us; we verify
 * the signature with the same secret. A valid signature proves the data came from
 * the host's server — so it is TRUSTED, not client-spoofable, even though it
 * travelled through the browser.
 *
 * Read-only: we display and use these attributes; we never write back to the host.
 *
 * The schema is deliberately domain-neutral. `customer` is the small reserved set
 * that drives identity resolution and display; everything else is a flat bag of
 * `attributes` the customer names themselves and renders through their own
 * per-website field mapping.
 */

// Ids may arrive as a string or a number; normalise to a string so everything
// downstream is consistent.
const idField = z.union([z.string().max(64), z.number()]).transform((v) => String(v));

/** Attribute keys are snake_case identifiers — no HTML, no path traversal, no PII smuggling in the key itself. */
const ATTRIBUTE_KEY = /^[a-z0-9_]{1,40}$/;

const attributeValue = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
]);

const attributesSchema = z
  .record(z.string(), attributeValue)
  .refine((rec) => Object.keys(rec).length <= 50, {
    message: 'at most 50 attributes',
  })
  .refine((rec) => Object.keys(rec).every((k) => ATTRIBUTE_KEY.test(k)), {
    message: 'attribute keys must match ^[a-z0-9_]{1,40}$',
  });

const eventSchema = z.object({
  name: z.string().max(60),
  at: z.string().max(40).optional(),
  data: z.record(z.string(), attributeValue).optional(),
});

// Unknown top-level keys are silently stripped by zod's default object mode — we
// only keep what we model, so no untrusted HTML is ever stored.
const contextSchema = z.object({
  customer: z
    .object({
      id: idField.optional(),
      name: z.string().max(200).optional(),
      email: z.string().email().max(200).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
  attributes: attributesSchema.optional(),
  events: z.array(eventSchema).max(20).optional(),
});

export type VerifiedContext = z.infer<typeof contextSchema>;

/** Longest lifetime we accept on a signed token. A long-lived token is a durable forgery target. */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/** The per-site HMAC secret for a given site key, or null if unset. */
export async function siteContextSecret(siteKey: string | null | undefined): Promise<string | null> {
  if (!siteKey) return null;
  const site = await prisma.sites.findUnique({
    where: { key: siteKey },
    select: { context_secret: true },
  });
  return site?.context_secret || null;
}

/**
 * Verify a signed context token against a site's secret and return the parsed,
 * schema-validated attributes. Returns null on any failure (bad signature,
 * expired, malformed, unknown site, or signing disabled) — callers treat null as
 * "no trusted context" and fall back to unsigned client hints for display only.
 */
export async function verifyContextToken(
  siteKey: string | null | undefined,
  token: string | null | undefined,
): Promise<VerifiedContext | null> {
  if (!token) return null; // no token supplied — normal, stay quiet
  const secret = await siteContextSecret(siteKey);
  if (!secret) {
    // A token WAS sent but we can't check it — almost always a misconfig.
    console.warn(
      `[context] token received for site "${siteKey ?? '(none)'}" but that site has no context_secret set (or no matching site row).`,
    );
    return null;
  }
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 60 });
    if (typeof decoded !== 'object' || decoded === null) return null;

    const claims = decoded as Record<string, unknown>;

    // Require an expiry, and refuse tokens minted to live for longer than a day.
    // jwt.verify already enforces `exp` when present, but a token WITHOUT one
    // never expires — that is the failure we care about.
    const exp = typeof claims.exp === 'number' ? claims.exp : null;
    if (exp === null) {
      console.warn(`[context] token for site "${siteKey}" rejected — no exp claim`);
      return null;
    }
    const iat = typeof claims.iat === 'number' ? claims.iat : null;
    if (iat !== null && exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
      console.warn(
        `[context] token for site "${siteKey}" rejected — lifetime ${exp - iat}s exceeds the ${MAX_TOKEN_LIFETIME_SECONDS}s cap`,
      );
      return null;
    }

    // Strip standard JWT claims before validating the payload shape.
    const rest = { ...claims };
    for (const claim of ['iss', 'iat', 'exp', 'nbf', 'aud', 'sub', 'jti']) delete rest[claim];
    const parsed = contextSchema.safeParse(rest);
    if (!parsed.success) {
      console.warn(
        `[context] token for site "${siteKey}" verified but payload shape is invalid:`,
        parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', '),
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    // Distinguish the common failures so misconfig is obvious in the logs.
    const name = (err as { name?: string }).name;
    const reason =
      name === 'TokenExpiredError'
        ? 'token expired'
        : name === 'JsonWebTokenError'
          ? `bad signature (secret mismatch?): ${(err as Error).message}`
          : (err as Error).message;
    console.warn(`[context] token for site "${siteKey}" rejected — ${reason}`);
    return null;
  }
}
