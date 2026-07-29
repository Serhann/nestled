import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

/**
 * The widget session token.
 *
 * THE FIX for a full conversation-takeover hole in the pre-tenant build:
 * `/ws/presence?visitor_id=…` accepted a client-supplied visitor id with no
 * authentication, and the proactive frame carried the conversation's
 * `visitor_token`. Anyone who opened that socket with a guessed or observed
 * visitor id was handed read/write access to that visitor's conversation.
 *
 * Now the widget first exchanges its website's public key for a signed session
 * token, and the presence socket takes `visitor_id` and `website_id` FROM THE
 * TOKEN PAYLOAD — never from the query string. Consequences:
 *
 *  - a visitor id cannot be impersonated: it is inside a signature we produced,
 *  - presence is per-website, so two customers cannot collide on one visitor id,
 *  - the endpoint becomes rate-limitable per website instead of only per IP.
 *
 * This is our own signature over our own claim, so it is unrelated to
 * verifiedAttributes.ts, which verifies the CUSTOMER's signature over THEIR data.
 */

const TTL_SECONDS = 24 * 60 * 60;

export interface WidgetSessionPayload {
  /** Discriminator, checked explicitly so an agent token can never be used here. */
  typ: 'widget';
  /** visitor id — minted by us on first session, then echoed back by the widget. */
  vid: string;
  /** website id (internal uuid, not the public key). */
  wsite: string;
  /** workspace id, so the presence plane never has to look it up. */
  ws: string;
  /** session id, for correlating logs. */
  sid: string;
}

export function issueWidgetSession(args: {
  workspaceId: string;
  websiteId: string;
  visitorId?: string | null;
}): { token: string; visitorId: string } {
  // A client-supplied visitor id is accepted so a returning visitor keeps their
  // identity across page loads, but it is NOT trusted for anything: it only ever
  // names rows already scoped to this website, and the signature is what makes it
  // unforgeable from here on.
  const visitorId =
    args.visitorId && /^[A-Za-z0-9_-]{4,64}$/.test(args.visitorId)
      ? args.visitorId
      : `v_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

  const payload: WidgetSessionPayload = {
    typ: 'widget',
    vid: visitorId,
    wsite: args.websiteId,
    ws: args.workspaceId,
    sid: randomUUID(),
  };
  const token = jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: TTL_SECONDS });
  return { token, visitorId };
}

/** Verify a widget session token. Returns null on any failure — never throws. */
export function verifyWidgetSession(token: string | undefined | null): WidgetSessionPayload | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const d = decoded as Record<string, unknown>;
    if (d.typ !== 'widget') return null;
    if (typeof d.vid !== 'string' || typeof d.wsite !== 'string' || typeof d.ws !== 'string') return null;
    return { typ: 'widget', vid: d.vid, wsite: d.wsite, ws: d.ws, sid: String(d.sid ?? '') };
  } catch {
    return null;
  }
}
