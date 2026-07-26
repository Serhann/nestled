/**
 * Roles and capabilities.
 *
 * Three customer roles, and a flat list of capabilities they map to. Resist a
 * fourth role until a customer pays for it — every extra role multiplies the
 * matrix below and the number of states anyone has to reason about.
 *
 * Roles are coarse; `all_websites` + member_website_access is the orthogonal
 * narrowing dimension. A workspace admin can be scoped to one website, and both
 * the capability check here and the tenant client in db/tenant.ts honour it.
 */

export const WORKSPACE_ROLES = ['owner', 'admin', 'agent'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PLATFORM_ROLES = ['superadmin', 'support', 'billing', 'readonly'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const CAPABILITIES = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'billing:read',
  'billing:manage',
  'member:read',
  'member:invite',
  'member:update',
  'member:remove',
  'website:create',
  'website:read',
  'website:delete',
  'website_settings:update',
  'conversation:read',
  'conversation:reply',
  'conversation:assign',
  'conversation:resolve',
  'conversation:delete',
  'note:write',
  'visitor:read',
  'visitor:replay',
  'kb:read',
  'kb:write',
  'canned:read',
  'canned:write',
  'starter:write',
  'trigger:write',
  'bot:write',
  'routing:write',
  'hours:write',
  'integration:manage',
  'audit:read',
  'transcript:send',
  'export:data',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities that are meaningful per-website, not just per-workspace. */
export const WEBSITE_SCOPED_CAPABILITIES = new Set<Capability>([
  'website:read',
  'website_settings:update',
  'conversation:read',
  'conversation:reply',
  'conversation:assign',
  'conversation:resolve',
  'conversation:delete',
  'note:write',
  'visitor:read',
  'visitor:replay',
  'kb:read',
  'kb:write',
  'canned:read',
  'canned:write',
  'starter:write',
  'trigger:write',
  'bot:write',
  'routing:write',
  'hours:write',
  'transcript:send',
]);

const AGENT: Capability[] = [
  'workspace:read',
  'member:read',
  'website:read',
  'conversation:read',
  'conversation:reply',
  'conversation:assign',
  'conversation:resolve',
  'note:write',
  'visitor:read',
  'visitor:replay', // plan-gated separately; the role does not forbid it
  'kb:read',
  'canned:read',
  'transcript:send',
];

/** Everything operational. No billing writes, and cannot grant the owner role. */
const ADMIN: Capability[] = [
  ...AGENT,
  'workspace:update',
  'billing:read',
  'member:invite',
  'member:update',
  'member:remove',
  'website:create',
  'website:delete',
  'website_settings:update',
  'conversation:delete',
  'kb:write',
  'canned:write',
  'starter:write',
  'trigger:write',
  'bot:write',
  'routing:write',
  'hours:write',
  'integration:manage',
  'audit:read',
  'export:data',
];

const OWNER: Capability[] = [...ADMIN, 'workspace:delete', 'billing:manage'];

const BY_ROLE: Record<WorkspaceRole, ReadonlySet<Capability>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  agent: new Set(AGENT),
};

/**
 * Capabilities SUBTRACTED during impersonation, whatever the impersonated role.
 *
 * Support staff must never be able to read a customer's integration secrets,
 * rotate their signing key, touch their billing, change who has access, or bulk-
 * export their data — those are the actions where "we were debugging" stops being
 * a defensible explanation.
 */
const IMPERSONATION_DENIED: ReadonlySet<Capability> = new Set<Capability>([
  'billing:manage',
  'integration:manage',
  'workspace:delete',
  'member:invite',
  'member:update',
  'member:remove',
  'export:data',
]);

/**
 * Effective capabilities for a role, narrowed if this is an impersonated session.
 */
export function capabilitiesFor(
  role: WorkspaceRole,
  impersonationScope?: 'read_only' | 'full',
): ReadonlySet<Capability> {
  const base = BY_ROLE[role];
  if (!impersonationScope) return base;

  const out = new Set<Capability>();
  for (const cap of base) {
    if (IMPERSONATION_DENIED.has(cap)) continue;
    // A read-only session keeps only capabilities that cannot mutate. The tenant
    // client enforces this mechanically too (every write throws); this layer just
    // produces an honest 403 with a useful message instead of a 500.
    if (impersonationScope === 'read_only' && !isReadOnlyCapability(cap)) continue;
    out.add(cap);
  }
  return out;
}

function isReadOnlyCapability(cap: Capability): boolean {
  return cap.endsWith(':read') || cap === 'audit:read' || cap === 'billing:read';
}

/** Platform-staff role ordering, for `requirePlatform`. */
export function platformRoleAllows(role: PlatformRole, allowed: readonly PlatformRole[]): boolean {
  return allowed.includes(role) || role === 'superadmin';
}
