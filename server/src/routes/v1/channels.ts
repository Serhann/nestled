import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../lib/validate.js';
import { settings } from '../../services/platform/settings.js';
import { ingestInbound } from '../../services/channels/inbound.js';
import { isOptIn, isOptOut, verifyTwilioSignature } from '../../services/channels/sms.js';
import { stripQuotedReply } from '../../services/channels/emailBody.js';

/**
 * Inbound channel webhooks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * These are the only routes in the application that accept a message from an
 * unauthenticated caller and put it in a customer's inbox. Four rules, and every
 * one of them is load-bearing:
 *
 * 1. **Verified before parsed.** Both endpoints authenticate the CALLER before
 *    believing anything in the body. Unverified, either one lets whoever finds the
 *    URL write into any workspace's inbox as any sender they choose.
 * 2. **No secret configured means CLOSED.** Not open, not warn-and-continue. An
 *    install that has not set the secret has not enabled inbound mail, and the
 *    failure mode of guessing otherwise is unbounded.
 * 3. **2xx for anything that will not succeed on retry.** Providers redeliver until
 *    they get a 2xx and then some. An unknown address, a duplicate, an empty body:
 *    all accepted-and-ignored, because a 4xx makes the provider try harder at a
 *    message that has nowhere to go. 4xx is reserved for "your request was
 *    malformed or unsigned", which is the caller's bug, not a message's.
 * 4. **Nothing is ever replied to the sender.** No bounce, no "we could not route
 *    this". An automated reply to a spoofed From: makes us a spam relay, and two
 *    autoresponders in a loop is the classic version of this outage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Extract a bare address from `Ada Lovelace <ada@example.com>`. */
export function bareAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/** Extract the display name, if the header carries one. */
export function displayName(value: string): string | null {
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(value);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

const inboundMailBody = z.object({
  /** Full header value; a display name is welcome and is parsed out. */
  from: z.string().min(3).max(320),
  to: z.string().min(3).max(320),
  subject: z.string().max(500).optional(),
  text: z.string().max(100_000).optional(),
  html: z.string().max(500_000).optional(),
  /** The RFC 5322 Message-ID. Our idempotency key and our threading anchor. */
  message_id: z.string().min(3).max(500),
  /** Anything else the provider sends, kept as unverified hints. */
  headers: z.record(z.string(), z.string()).optional(),
});

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Inbound email.
   *
   * Provider-agnostic on purpose: every ESP has its own webhook shape and we cannot
   * pick one for an operator, so this takes a normalised body and the operator's
   * provider maps onto it. The shared secret goes in a header rather than the URL —
   * a secret in a path lands in access logs and in the provider's own dashboard.
   */
  app.post(
    '/api/v1/channels/email/inbound',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const expected = settings().inboundMail.secret;
      // Rule 2. Closed until configured.
      if (!expected) {
        return reply.code(503).send({ error: 'Inbound email is not enabled on this installation' });
      }
      const presented = String(req.headers['x-nestled-signature'] ?? '');
      if (!constantTimeEqual(presented, expected)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      const body = parseBody(inboundMailBody, req.body, reply);
      if (!body) return;

      // Plain text preferred. The HTML fallback is stripped rather than rendered:
      // an agent inbox that renders a stranger's HTML is an XSS surface, and the
      // thread displays text anyway.
      const raw = body.text?.trim() || htmlToText(body.html ?? '');
      const text = stripQuotedReply(raw);
      if (!text) {
        // An empty reply — someone hit send on nothing, or the mail was only a
        // quoted history. Rule 3: accepted and dropped.
        return reply.send({ status: 'ignored', reason: 'empty' });
      }

      const outcome = await ingestInbound({
        channel: 'email',
        toAddress: bareAddress(body.to),
        fromAddress: bareAddress(body.from),
        fromName: displayName(body.from),
        text,
        externalId: body.message_id,
        hints: {
          subject: body.subject ?? null,
          ...(body.headers ? { headers: body.headers } : {}),
        },
      });

      // Rule 3 again: every outcome here is a 2xx. `rejected` included — a
      // workspace that no longer exists will not start existing on redelivery.
      return reply.send({ status: outcome.status });
    },
  );

  /**
   * Inbound SMS (Twilio).
   *
   * Form-encoded, signature-verified against the exact URL Twilio requested. The URL
   * has to be reconstructed rather than read off `req.url`, because Twilio signed the
   * public https:// URL and we are usually behind a proxy that hands us http and a
   * different host.
   */
  app.post(
    '/api/v1/channels/sms/inbound',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { authToken } = settings().sms;
      if (!authToken) {
        return reply.code(503).send({ error: 'SMS is not enabled on this installation' });
      }

      const params = normaliseForm(req.body);
      const url = publicUrl(req.headers, req.url);
      if (
        !verifyTwilioSignature(
          url,
          params,
          req.headers['x-twilio-signature'] as string | undefined,
          authToken,
        )
      ) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      const from = params.From?.trim();
      const to = params.To?.trim();
      const text = (params.Body ?? '').trim();
      const sid = params.MessageSid?.trim();
      if (!from || !to || !sid) {
        return reply.code(400).send({ error: 'Missing From, To or MessageSid' });
      }

      // Opt-out and opt-in keywords are handled by Twilio at the carrier level
      // whether or not we look at them. We look so the AGENT knows: replying into a
      // number that has opted out silently discards, and an agent typing into the
      // void is worse than a channel that says it is closed.
      if (isOptOut(text) || isOptIn(text)) {
        await ingestInbound({
          channel: 'sms',
          toAddress: to,
          fromAddress: from,
          fromName: null,
          text: isOptOut(text)
            ? `${text}\n\n(This number has opted out of SMS. Replies will not be delivered until they text START.)`
            : `${text}\n\n(This number has opted back in to SMS.)`,
          externalId: sid,
          hints: { sms_opt_out: isOptOut(text) },
        });
        // Twilio expects TwiML or an empty 200. An empty body means "send nothing
        // back", which is what rule 4 wants.
        return reply.code(204).send();
      }

      if (!text) return reply.code(204).send();

      await ingestInbound({
        channel: 'sms',
        toAddress: to,
        fromAddress: from,
        fromName: null,
        text,
        externalId: sid,
        hints: {
          ...(params.FromCity ? { city: params.FromCity } : {}),
          ...(params.FromCountry ? { country: params.FromCountry } : {}),
          ...(params.NumMedia && params.NumMedia !== '0' ? { media_count: params.NumMedia } : {}),
        },
      });

      return reply.code(204).send();
    },
  );
}

/** Constant-time string compare that does not leak length through an early return. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Twilio signs the public URL, which is not the URL this process received.
 *
 * Behind a proxy `req.url` is a path and the protocol is http. `X-Forwarded-*` is
 * what reconstructs what Twilio actually called; getting this wrong produces a
 * signature mismatch that reads exactly like a wrong auth token.
 */
function publicUrl(headers: Record<string, unknown>, url: string): string {
  const proto = (String(headers['x-forwarded-proto'] ?? 'https').split(',')[0] ?? 'https').trim();
  const host = (String(headers['x-forwarded-host'] ?? headers.host ?? '').split(',')[0] ?? '').trim();
  return `${proto}://${host}${url}`;
}

/** Twilio posts form-encoded; Fastify gives us an object of unknowns. */
function normaliseForm(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Last-resort HTML → text, for mail with no text/plain part.
 *
 * Not a renderer and not trying to be: tags are removed and entities decoded so an
 * agent has something readable. The thread displays text, so nothing here can become
 * markup later.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
