import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, tokenMatchesHash, hashToken } from '../auth/tokens.js';
import { unscopedPrisma } from '../db/unscoped.js';
import { tenantDb, TenantScopeError, type TenantDb, type TenantScope } from '../db/tenant.js';
import {
  capabilitiesFor,
  platformCapabilitiesFor,
  platformRoleAllows,
  type Capability,
  type PlatformCapability,
  type PlatformRole,
  type WorkspaceRole,
} from '../permissions.js';

/**
 * Request authentication and authorization.
 *
 * Two enforcement layers, deliberately:
 *   - `can()` produces the correct 403 with a useful message.
 *   - the tenant client guarantees that a route which FORGOT its `can()` still
 *     cannot cross a workspace or website boundary. Worst case is a privilege bug
 *     inside one tenant (an agent editing the KB), never a data breach.
 *
 * The old `requireAdmin` shim is gone on purpose. Forcing each formerly-admin
 * route to name its capability is a one-time cost that produces a real matrix
 * instead of a binary that drifts.
 */

export interface AuthedMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  allWebsites: boolean;
  websiteIds: string[];
}

export interface AuthContext {
  userId: string;
  email: string;
  member?: AuthedMember;
  workspace?: { id: string; slug: string; subscriptionStatus: string; planId: string };
  caps: ReadonlySet<Capability>;
  impersonation?: {
    platformUserId: string;
    sessionId: string;
    scope: 'read_only' | 'full';
    /** The single workspace this impersonated session may touch. */
    workspaceId: string;
  };
  can(cap: Capability, websiteId?: string): boolean;
}

export interface PlatformContext {
  id: string;
  email: string;
  role: PlatformRole;
  sessionId: string;
  /**
   * What this account may actually do: its role's bundle, plus its granted scopes,
   * minus its denied ones. Resolved once per request here so no route has to remember
   * that the role is only a default — see PLATFORM_CAPABILITIES in permissions.ts.
   */
  capabilities: ReadonlySet<PlatformCapability>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    platform?: PlatformContext;
    tenant?: TenantScope;
    /** Workspace-scoped Prisma client. Throws if accessed without a tenant scope. */
    db: TenantDb;
    visitorConversationId?: string;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

// ── Caches ───────────────────────────────────────────────────────────────────
// requireWorkspace has to load the member row anyway (for the website grant
// list), so a short TTL buys revocation that is effectively immediate without a
// per-request round trip. 30s is the window in which a removed member can still
// act; anything longer starts to feel like a security bug.
const MEMBER_TTL_MS = 30_000;
const IMPERSONATION_TTL_MS = 10_000; // tighter: "end session" must bite fast

interface CacheEntry<T> {
  value: T;
  at: number;
}
const memberCache = new Map<string, CacheEntry<AuthedMember | null>>();
const workspaceCache = new Map<string, CacheEntry<AuthContext['workspace'] | null>>();
const impersonationCache = new Map<string, CacheEntry<boolean>>();

function cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttl) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Drop cached authorization for a member. Call after a role or access change. */
export function invalidateMemberCache(workspaceId: string, userId: string): void {
  memberCache.delete(`${workspaceId}:${userId}`);
}
export function invalidateWorkspaceCache(workspaceId: string): void {
  workspaceCache.delete(workspaceId);
}

async function loadMember(workspaceId: string, userId: string): Promise<AuthedMember | null> {
  const key = `${workspaceId}:${userId}`;
  const hit = cached(memberCache, key, MEMBER_TTL_MS);
  if (hit !== undefined) return hit;

  const row = await unscopedPrisma.workspace_members.findUnique({
    where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: userId } },
    select: {
      id: true,
      workspace_id: true,
      user_id: true,
      role: true,
      status: true,
      all_websites: true,
      websites: { select: { website_id: true } },
    },
  });

  const member: AuthedMember | null =
    row && row.status === 'active'
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          role: row.role as WorkspaceRole,
          allWebsites: row.all_websites,
          websiteIds: row.websites.map((w) => w.website_id),
        }
      : null;

  memberCache.set(key, { value: member, at: Date.now() });
  return member;
}

async function loadWorkspace(workspaceId: string): Promise<AuthContext['workspace'] | null> {
  const hit = cached(workspaceCache, workspaceId, MEMBER_TTL_MS);
  if (hit !== undefined) return hit;

  const row = await unscopedPrisma.workspaces.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, subscription_status: true, plan_id: true, deleted_at: true },
  });
  const value =
    row && !row.deleted_at
      ? {
          id: row.id,
          slug: row.slug,
          subscriptionStatus: row.subscription_status,
          planId: row.plan_id,
        }
      : null;
  workspaceCache.set(workspaceId, { value, at: Date.now() });
  return value;
}

async function impersonationIsLive(sessionId: string): Promise<boolean> {
  const hit = cached(impersonationCache, sessionId, IMPERSONATION_TTL_MS);
  if (hit !== undefined) return hit;
  const row = await unscopedPrisma.impersonation_sessions.findUnique({
    where: { id: sessionId },
    select: { ended_at: true, expires_at: true },
  });
  const live = Boolean(row && !row.ended_at && row.expires_at > new Date());
  impersonationCache.set(sessionId, { value: live, at: Date.now() });
  return live;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/** A valid access token. Populates req.auth with no workspace context yet. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  if (!token) {
    await reply.code(401).send({ error: 'Authentication required' });
    return;
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    await reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }

  // An impersonation token is re-checked against the session row on every
  // request, so "end session" in the ops panel takes effect within seconds rather
  // than waiting out the token's TTL.
  if (payload.act && !(await impersonationIsLive(payload.act.sid))) {
    await reply.code(401).send({ error: 'Impersonation session ended' });
    return;
  }

  const caps: ReadonlySet<Capability> = new Set();
  req.auth = {
    userId: payload.sub,
    email: payload.email,
    caps,
    ...(payload.act
      ? {
          impersonation: {
            platformUserId: payload.act.pu,
            sessionId: payload.act.sid,
            scope: payload.act.scope,
            workspaceId: payload.act.ws,
          },
        }
      : {}),
    can: () => false, // replaced by requireWorkspace once the role is known
  };
}

/** + a verified email address. */
export async function requireVerified(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  const user = await unscopedPrisma.users.findUnique({
    where: { id: req.auth!.userId },
    select: { email_verified_at: true },
  });
  if (!user?.email_verified_at) {
    await reply.code(403).send({ error: 'Verify your email address first', code: 'email_unverified' });
  }
}

/**
 * + membership of the workspace named in the PATH. Populates req.db — the only
 * way a route obtains a database client.
 *
 * Reads `:workspaceId` from params rather than the token, per the token design in
 * auth/tokens.ts.
 */
export async function requireWorkspace(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;

  const params = req.params as Record<string, string | undefined>;
  const workspaceId = params.workspaceId;
  if (!workspaceId) {
    await reply.code(400).send({ error: 'Workspace missing from the request path' });
    return;
  }

  const auth = req.auth!;

  // An impersonated token is bound to ONE workspace. Without this check, a support
  // session opened on customer A could be replayed against customer B by editing
  // the URL.
  if (auth.impersonation && auth.impersonation.workspaceId !== workspaceId) {
    await reply.code(403).send({ error: 'This session is scoped to a different workspace' });
    return;
  }

  const member = await loadMember(workspaceId, auth.userId);
  if (!member) {
    // 404, not 403: a non-member must not be able to learn that this workspace id
    // exists at all.
    await reply.code(404).send({ error: 'Not found' });
    return;
  }
  const workspace = await loadWorkspace(workspaceId);
  if (!workspace) {
    await reply.code(404).send({ error: 'Not found' });
    return;
  }

  const caps = capabilitiesFor(member.role, auth.impersonation?.scope);
  auth.member = member;
  auth.workspace = workspace;
  auth.caps = caps;
  auth.can = (cap: Capability, websiteId?: string) => {
    if (!caps.has(cap)) return false;
    if (websiteId && !member.allWebsites && !member.websiteIds.includes(websiteId)) return false;
    return true;
  };

  req.tenant = {
    workspaceId,
    websiteIds: member.allWebsites ? null : member.websiteIds,
    readOnly: auth.impersonation?.scope === 'read_only',
  };
  req.db = tenantDb(req.tenant);
}

/** preHandler factory: require every listed capability at workspace level. */
export function can(...caps: Capability[]) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.auth;
    if (!auth?.member) {
      await reply.code(500).send({ error: 'can() used without requireWorkspace' });
      return;
    }
    const missing = caps.filter((c) => !auth.caps.has(c));
    if (missing.length > 0) {
      await reply.code(403).send({ error: `Missing permission: ${missing.join(', ')}` });
    }
  };
}

/**
 * preHandler factory: require a capability ON a specific website, taken from the
 * request. Honours a member narrowed to a subset of websites.
 */
export function canOnWebsite(
  cap: Capability,
  source: 'params' | 'body' | 'query' = 'params',
  key = 'websiteId',
) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.auth;
    if (!auth?.member) {
      await reply.code(500).send({ error: 'canOnWebsite() used without requireWorkspace' });
      return;
    }
    const bag = (req[source] ?? {}) as Record<string, unknown>;
    const websiteId = typeof bag[key] === 'string' ? (bag[key] as string) : undefined;
    if (!auth.can(cap, websiteId)) {
      await reply.code(403).send({ error: `Missing permission: ${cap}` });
    }
  };
}

/** Throw-style capability assertion, for branching inside a handler. */
export function assertCan(req: FastifyRequest, cap: Capability, websiteId?: string): void {
  if (!req.auth?.can(cap, websiteId)) {
    const err = new Error(`Missing permission: ${cap}`) as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }
}

/**
 * preHandler factory: a visitor token that matches the conversation in the route
 * params. A visitor may only ever touch its own conversation.
 */
export function requireVisitor(paramName = 'id') {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const params = req.params as Record<string, string | undefined>;
    const conversationId = params[paramName];
    const token = bearer(req);

    if (!conversationId || !token) {
      await reply.code(401).send({ error: 'Visitor token required' });
      return;
    }

    const row = await unscopedPrisma.conversations.findUnique({
      where: { id: conversationId },
      select: { id: true, workspace_id: true, website_id: true, visitor_token_hash: true },
    });

    // Do not distinguish "not found" from "wrong token" — both are 401, so an
    // attacker cannot probe which conversation ids exist.
    if (!row || !tokenMatchesHash(token, row.visitor_token_hash)) {
      await reply.code(401).send({ error: 'Invalid visitor token' });
      return;
    }

    req.visitorConversationId = conversationId;
    // Even the anonymous visitor path gets a narrowed client: scoped to this
    // conversation's workspace AND its single website. A visitor route therefore
    // physically cannot read another website's rows.
    req.tenant = { workspaceId: row.workspace_id, websiteIds: [row.website_id] };
    req.db = tenantDb(req.tenant);
  };
}

/** preHandler factory: platform (vendor) staff with one of the listed roles. */
export function requirePlatform(...allowed: PlatformRole[]) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearer(req);
    if (!token) {
      await reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    // Opaque bearer sessions, checked against the database every request — a
    // different MECHANISM from customer auth, not merely a different secret. There
    // is no JWT verifier on this plane, so a customer token cannot be replayed
    // here even if it were signed with the same key.
    const session = await unscopedPrisma.platform_sessions.findUnique({
      where: { token_hash: hashToken(token) },
      select: {
        id: true,
        revoked_at: true,
        expires_at: true,
        platform_user: {
          select: {
            id: true,
            email: true,
            role: true,
            granted_scopes: true,
            denied_scopes: true,
            disabled_at: true,
          },
        },
      },
    });
    if (
      !session ||
      session.revoked_at ||
      session.expires_at <= new Date() ||
      session.platform_user.disabled_at
    ) {
      await reply.code(401).send({ error: 'Invalid or expired session' });
      return;
    }
    const role = session.platform_user.role as PlatformRole;
    if (allowed.length > 0 && !platformRoleAllows(role, allowed)) {
      await reply.code(403).send({ error: 'Insufficient staff role' });
      return;
    }
    req.platform = {
      id: session.platform_user.id,
      email: session.platform_user.email,
      role,
      sessionId: session.id,
      capabilities: platformCapabilitiesFor(
        role,
        session.platform_user.granted_scopes,
        session.platform_user.denied_scopes,
      ),
    };
  };
}

/**
 * Register the `db` request property.
 *
 * Reading it before a guard has set a tenant scope THROWS, so a route that forgot
 * its preHandler fails loudly on its first query instead of quietly reading
 * another customer's data. The getter needs a matching setter — a getter-only
 * accessor on the prototype would make `req.db = …` in requireWorkspace fail.
 */
const DB = Symbol('nestled.db');

export async function registerAuthPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('db', {
    getter(this: FastifyRequest & { [DB]?: TenantDb }) {
      const client = this[DB];
      if (!client) {
        throw new TenantScopeError(
          'req.db accessed without a tenant scope — the route is missing requireWorkspace / requireVisitor',
        );
      }
      return client;
    },
    setter(this: FastifyRequest & { [DB]?: TenantDb }, value: TenantDb) {
      this[DB] = value;
    },
  } as never);
}
