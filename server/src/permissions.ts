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

// ═══════════════════════════════════════════════════════════════════════════════
// THE VENDOR PLANE'S SCOPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * What a staff account may do, one entry per decision somebody could reasonably
 * want to grant separately.
 *
 * Four roles used to be the whole model, with `superadmin` bypassing every check.
 * That is fine until the first real request for something in between: a support lead
 * who should be able to delete an account, a finance contractor who should touch the
 * plan catalog and nothing else, an engineer who needs the install's settings but has
 * no business impersonating a customer. Each of those became either "make them
 * superadmin" — which grants all of it — or a fifth role, then a sixth.
 *
 * So the ROLE is now a named bundle of these scopes, and an account can be granted or
 * denied individual ones on top. The four roles stay because they are the right answer
 * nine times out of ten, and because a list of fourteen checkboxes is a worse default
 * than a word.
 *
 * The list is deliberately shaped around CONSEQUENCES rather than routes. `plan:write`
 * is separate from `workspace:plan` because one changes what every customer is sold and
 * the other changes what one customer pays; `impersonate:full` is separate from
 * `impersonate:read_only` because one can type into a customer's inbox.
 */
export const PLATFORM_CAPABILITIES = [
  /** The whole read surface: lists, detail tabs, search, dunning, health, audit. */
  'panel:read',
  /** Staff notes on a customer. The one write every role has had. */
  'note:write',
  /** Extend a trial, grant grace, set status, cancel a scheduled purge, restore. */
  'workspace:lifecycle',
  /** Set one customer's plan, their billing mode, or a private plan override. */
  'workspace:plan',
  /** The plan catalog — what every customer can be sold. */
  'plan:write',
  /** Confirm a customer's email address without them clicking a link. */
  'user:confirm_email',
  /** Delete a workspace, website, user or conversation. */
  'deletion:create',
  /** Undo one inside the window. Separate because undoing is the safe direction. */
  'deletion:restore',
  /** Sign in as a customer, read-only. */
  'impersonate:read_only',
  /** Sign in as a customer and act. */
  'impersonate:full',
  /** End somebody's impersonation session. Anyone should be able to stop a colleague. */
  'impersonate:end',
  /** Install-wide settings: AI keys, SMTP, Stripe, GeoIP, VAPID, retention. */
  'settings:write',
  /**
   * Rewrite the assistant's instructions for ONE website — notably when it hands off.
   *
   * Separate from `settings:write` because the consequences are different sizes. That one
   * holds the Stripe key and the SMTP host: get it wrong and every customer on the install
   * feels it at once. This one changes how one customer's assistant behaves, which is
   * exactly the kind of tuning a support engineer does while a customer is on the phone —
   * and exactly the reason it should not require handing them the credentials.
   */
  'ai:prompt',
  /** Create staff accounts and change their roles, scopes and status. */
  'staff:manage',
] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const PLATFORM_READONLY: PlatformCapability[] = ['panel:read'];

/** Reads, notes, and stopping a colleague's impersonation. Nothing that changes a customer. */
const PLATFORM_BASE: PlatformCapability[] = [...PLATFORM_READONLY, 'note:write', 'impersonate:end'];

/** Day-to-day support: the reversible levers, and read-only impersonation. */
const PLATFORM_SUPPORT: PlatformCapability[] = [
  ...PLATFORM_BASE,
  'workspace:lifecycle',
  'user:confirm_email',
  'deletion:restore',
  'impersonate:read_only',
  'impersonate:full',
  'ai:prompt',
];

/** Money: one customer's plan, and the catalog everyone is sold. */
const PLATFORM_BILLING: PlatformCapability[] = [
  ...PLATFORM_BASE,
  'workspace:lifecycle',
  'workspace:plan',
  'plan:write',
  'deletion:restore',
];

const PLATFORM_BY_ROLE: Record<PlatformRole, ReadonlySet<PlatformCapability>> = {
  // Everything, including the two nobody else gets by default: deleting a customer's
  // data, and creating the staff accounts that could grant themselves the rest.
  superadmin: new Set(PLATFORM_CAPABILITIES),
  support: new Set(PLATFORM_SUPPORT),
  billing: new Set(PLATFORM_BILLING),
  readonly: new Set(PLATFORM_READONLY),
};

/** The scopes a role carries with no per-account adjustment. For the panel's UI. */
export function platformRoleCapabilities(role: PlatformRole): ReadonlySet<PlatformCapability> {
  return PLATFORM_BY_ROLE[role];
}

/**
 * What this account can actually do: its role's bundle, plus what it was granted,
 * minus what it was denied.
 *
 * **Deny wins, and it wins over `superadmin` too.** That is the only thing that makes
 * these scopes more than decoration: before this, `platformRoleAllows` returned true
 * for a superadmin whatever was asked, so there was no way to say "this person
 * administers the install but does not read customer conversations". Now there is, and
 * it is a single row.
 *
 * Unknown strings in either column are ignored rather than throwing. These are stored
 * values; a capability removed from the list in a later release must not stop an
 * account from logging in.
 */
export function platformCapabilitiesFor(
  role: PlatformRole,
  granted: readonly string[] = [],
  denied: readonly string[] = [],
): ReadonlySet<PlatformCapability> {
  const known = new Set<string>(PLATFORM_CAPABILITIES);
  const out = new Set<PlatformCapability>(PLATFORM_BY_ROLE[role]);
  for (const scope of granted) if (known.has(scope)) out.add(scope as PlatformCapability);
  for (const scope of denied) out.delete(scope as PlatformCapability);
  return out;
}

/**
 * Scopes that cannot be handed out by somebody who does not hold them.
 *
 * Which is all of them — `staff:manage` without this rule is a path to every other
 * scope: create an account with the scopes you want, set its password yourself, sign in
 * as it. The check lives in the staff routes; this constant exists so the reasoning has
 * one home, and so nobody adds a scope believing that rule applies only to some.
 */
export function canGrantPlatformCapabilities(
  actor: ReadonlySet<PlatformCapability>,
  wanted: readonly string[],
): { ok: true } | { ok: false; missing: string[] } {
  const missing = wanted.filter((scope) => !actor.has(scope as PlatformCapability));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
