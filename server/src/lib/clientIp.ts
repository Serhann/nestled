import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../env.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The calling client's IP, resolved once per request. Prefer this over
     * `req.ip`, which sees the last proxy hop rather than the visitor.
     */
    clientIp: string;
  }
}

/**
 * Who is actually calling.
 *
 * One function, one decorated property, because the client IP is read by five
 * things that must all agree: the rate limiter's bucket key, the geo lookup shown
 * on the presence board, the audit log, the session records an agent reviews under
 * "where am I signed in", and the visitor IP history. Any two of those disagreeing
 * is a support conversation nobody can win.
 *
 * ── Behind a CDN ────────────────────────────────────────────────────────────────
 *
 * With Cloudflare in front, the socket peer is a Cloudflare edge and so is much of
 * what arrives in `X-Forwarded-For`. Fastify's `trustProxy: true` takes the LEFTMOST
 * XFF entry, which is the visitor only as long as every hop appends honestly — and
 * the visitor's own browser is the first thing in that chain, so a client that sends
 * its own `X-Forwarded-For` header is what the leftmost entry then reports.
 *
 * `CLIENT_IP_HEADER` names a header to believe ahead of that. Cloudflare's
 * `CF-Connecting-IP` is the one to use there: unlike XFF, Cloudflare OVERWRITES it,
 * so a visitor cannot inject a value into it. Empty (the default) keeps the old
 * XFF behaviour exactly.
 *
 * ── The requirement that comes with it ──────────────────────────────────────────
 *
 * Naming a header is an assertion that nothing can reach this app except through
 * the CDN that sets it. If the origin is reachable directly — its bare IP with a
 * Host header will do — then anyone can send `CF-Connecting-IP: 1.2.3.4` and choose
 * which rate-limit bucket to spend, which country the presence board shows, and
 * which IP the audit log blames. Lock the origin to Cloudflare's ranges (or put it
 * behind a tunnel) when you set this. DEPLOY.md says so where the variable is
 * documented; this comment exists so the next person to read the code learns it
 * here too.
 */

/** Lower-cased, or '' when the install is not behind a CDN that sets one. */
const CONFIGURED_HEADER = env.CLIENT_IP_HEADER.trim().toLowerCase();

/**
 * The IP to attribute this request to.
 *
 * `socketFallback` is Fastify's own `req.ip`. It is the last resort rather than the
 * first, and it is never wrong to fall back to: with no proxy at all it IS the
 * client.
 */
export function resolveClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketFallback: string,
): string {
  if (CONFIGURED_HEADER) {
    const configured = normalize(first(headers[CONFIGURED_HEADER]));
    if (configured) return configured;
    // No fallthrough warning here: the health checks and the container-to-container
    // calls legitimately arrive without it, and a log line per request is not a
    // diagnostic, it is a bill. `/platform/diagnostics/client-ip` answers this on
    // demand instead.
  }

  const forwarded = first(headers['x-forwarded-for']);
  if (forwarded) {
    // Leftmost: the hop closest to the client. Every proxy in the chain appends,
    // so the entries to the right are progressively closer to us.
    const leftmost = normalize(forwarded.split(',')[0]);
    if (leftmost) return leftmost;
  }

  const real = normalize(first(headers['x-real-ip']));
  if (real) return real;

  return normalize(socketFallback) || socketFallback;
}

/**
 * Install `req.clientIp`.
 *
 * A lazy getter rather than an onRequest hook that assigns: the WebSocket upgrade
 * path and the health checks would pay for a resolution neither reads, and a getter
 * cannot be bypassed by a route registered before the hook.
 */
export function registerClientIp(app: FastifyInstance): void {
  app.decorateRequest('clientIp', {
    getter(this: FastifyRequest) {
      return resolveClientIp(this.headers, this.ip);
    },
  } as never);
}

/**
 * What the resolver saw, for the ops panel's diagnostics. Returned to staff only:
 * it is the caller's own headers, but printing which header wins is also printing
 * which header an attacker would need to forge.
 */
export function clientIpDiagnostics(req: FastifyRequest): {
  resolved: string;
  configured_header: string | null;
  headers: Record<string, string | null>;
  socket: string;
} {
  const seen = ['cf-connecting-ip', 'true-client-ip', 'x-forwarded-for', 'x-real-ip'];
  if (CONFIGURED_HEADER && !seen.includes(CONFIGURED_HEADER)) seen.unshift(CONFIGURED_HEADER);
  return {
    resolved: resolveClientIp(req.headers, req.ip),
    configured_header: CONFIGURED_HEADER || null,
    headers: Object.fromEntries(seen.map((h) => [h, first(req.headers[h]) ?? null])),
    socket: req.ip,
  };
}

function first(value: string | string[] | undefined): string | undefined {
  // A repeated header arrives as an array. The first occurrence is the one a
  // parser walking left to right would have used.
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Trim what proxies add around an address: an IPv6 bracket pair, a `:port` suffix,
 * and the `::ffff:` prefix Node puts on IPv4 addresses arriving over a dual-stack
 * socket. Anything that is not recognisably an address returns '' so the caller
 * falls through — a header holding `unknown` (some proxies send exactly that)
 * must not become the rate-limit key that every such request shares.
 */
function normalize(value: string | undefined): string {
  if (!value) return '';
  let ip = value.trim();

  if (ip.startsWith('[')) {
    const close = ip.indexOf(']');
    if (close > 0) ip = ip.slice(1, close); // [2001:db8::1]:443 → 2001:db8::1
  }

  // Before the port trim below, which would otherwise cut this at its first colon
  // and leave nothing.
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7); // ::ffff:1.2.3.4 → 1.2.3.4

  // Only meaningful for IPv4: a bare IPv6 address is mostly colons, and one with a
  // port is required to be bracketed precisely because that is ambiguous.
  if (ip.includes('.') && ip.includes(':')) ip = ip.slice(0, ip.indexOf(':'));

  return isIpish(ip) ? ip : '';
}

function isIpish(value: string): boolean {
  if (value === '') return false;
  if (/^[0-9.]+$/.test(value)) return value.split('.').length === 4;
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}
