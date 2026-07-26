import { Prisma } from '@prisma/client';
import { unscopedPrisma } from './unscoped.js';

/**
 * The tenant-scoped Prisma Client.
 *
 * This is the primary enforcement mechanism for tenant isolation. Rather than
 * asking ~40 route handlers to remember `where: { workspace_id }`, the predicate
 * is injected by a Prisma client extension — so forgetting it is not possible,
 * because there is no unscoped client to forget it on (see unscoped.ts and the
 * ESLint rule that guards it).
 *
 * Three layers back each other up:
 *   1. STRUCTURAL — composite foreign keys make a cross-tenant reference a
 *      Postgres error. Holds even if this file is deleted (see tenancy.test.ts).
 *   2. THIS FILE — every query gets a workspace_id predicate, and website-scoped
 *      models additionally honour a member's per-website grants.
 *   3. RLS (Phase 14) — a backstop for non-application database access. NOT the
 *      primary lock: `SET LOCAL app.workspace_id` only survives inside a
 *      transaction, and Prisma hands out a pooled connection per query, so making
 *      RLS authoritative would mean wrapping every request in $transaction —
 *      holding a connection for its whole duration and breaking the fire-and-
 *      forget calls this codebase relies on. That is a permanent tax to buy a
 *      second lock on a door layer 1 already closed.
 */

/**
 * Every tenant-scoped model, and how it is reached.
 *
 *   'workspace' — has a workspace_id column; gets the predicate directly.
 *   'parent'    — reached ONLY through an already-scoped row, and protected by
 *                 that parent's FK cascade. No predicate to inject (it has no
 *                 workspace_id), but listed so the boot assertion knows it was
 *                 considered rather than forgotten.
 *
 * Adding a tenant table without adding it here is caught at startup by
 * assertTenantModelsRegistered(), which throws.
 */
export const TENANT_MODELS = {
  websites: 'workspace',
  website_settings: 'workspace',
  website_business_hours: 'workspace',
  website_domains: 'workspace',
  workspace_private_settings: 'workspace',
  workspace_members: 'workspace',
  member_website_access: 'parent',
  invites: 'workspace',
  conversations: 'workspace',
  messages: 'workspace',
  attachments: 'workspace',
  conversation_notes: 'workspace',
  stored_files: 'workspace',
  knowledge_base: 'workspace',
  canned_responses: 'workspace',
  starters: 'workspace',
  triggers: 'workspace',
  bot_flows: 'workspace',
  bot_flow_versions: 'parent',
  bot_flow_runs: 'workspace',
  routing_rules: 'workspace',
  persons: 'workspace',
  visitor_links: 'workspace',
  person_signals: 'workspace',
  visitor_ips: 'workspace',
  ai_usage: 'workspace',
  usage_counters: 'workspace',
} as const satisfies Record<string, 'workspace' | 'parent'>;

export type TenantModel = keyof typeof TENANT_MODELS;

/**
 * Models that additionally honour a member's per-website grant list. A member
 * scoped to one website must not see another's conversations — enforced here so
 * it holds even on a route that forgot to check `canOnWebsite`.
 */
const WEBSITE_SCOPED = new Set<string>([
  'websites',
  'website_settings',
  'website_business_hours',
  'website_domains',
  'conversations',
  'knowledge_base',
  'canned_responses',
  'starters',
  'triggers',
  'bot_flows',
  'routing_rules',
]);

/**
 * Website-scoped models where `website_id` is NULLABLE and NULL means "applies to
 * every website in the workspace". A member narrowed to one website must still see
 * those, so the filter has to be `website_id IN (...) OR website_id IS NULL`.
 * Getting this wrong would silently hide the workspace's shared knowledge base
 * from every scoped member.
 */
const NULL_WEBSITE_MEANS_ALL = new Set<string>([
  'knowledge_base',
  'canned_responses',
  'starters',
  'triggers',
  'bot_flows',
  'routing_rules',
]);

const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

export class TenantScopeError extends Error {
  statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export interface TenantScope {
  workspaceId: string;
  /** null = every website in the workspace; an array = the member's grants. */
  websiteIds: string[] | null;
  /** Impersonation with scope='read_only'. Every write throws. */
  readOnly?: boolean;
}

export type TenantDb = ReturnType<typeof tenantDb>;

/**
 * Build a client locked to one workspace (and optionally a subset of websites).
 *
 * The returned client is the ONLY thing a route handler ever sees.
 */
export function tenantDb(scope: TenantScope) {
  /**
   * The scope, split into the part that is safe to place at the top level of a
   * `where` and the part that must go into `AND`.
   *
   * `workspace_id` is a plain scalar, so it can sit alongside a caller's unique key.
   * The website narrowing CANNOT: on `website_settings` and
   * `website_business_hours`, `website_id` is itself the primary key, so injecting
   * `website_id: { in: [...] }` at the top level overwrites the caller's scalar and
   * findUnique rejects the object where it requires a string. Pushing it into `AND`
   * composes with any caller `where`, unique or not.
   */
  const scopeOf = (model: string): { top: Record<string, unknown>; and: unknown[] } => {
    const top: Record<string, unknown> = { workspace_id: scope.workspaceId };
    const and: unknown[] = [];
    if (scope.websiteIds && WEBSITE_SCOPED.has(model)) {
      const column = model === 'websites' ? 'id' : 'website_id';
      and.push(
        NULL_WEBSITE_MEANS_ALL.has(model)
          ? // NOT `{ in: [...ids, null] }` — SQL `IN (a, NULL)` never matches a NULL
            // row, so that spelling would silently hide every workspace-wide row
            // from every narrowed member. An explicit OR is required.
            { OR: [{ [column]: { in: scope.websiteIds } }, { [column]: null }] }
          : { [column]: { in: scope.websiteIds } },
      );
    }
    return { top, and };
  };

  /** Merge the scope into a caller `where`, preserving any AND they supplied. */
  const scoped = (model: string, callerWhere: unknown): Record<string, unknown> => {
    const { top, and } = scopeOf(model);
    const caller = (callerWhere ?? {}) as Record<string, unknown>;
    const callerAnd = caller.AND === undefined ? [] : Array.isArray(caller.AND) ? caller.AND : [caller.AND];
    const merged: Record<string, unknown> = { ...caller, ...top };
    const allAnd = [...callerAnd, ...and];
    if (allAnd.length > 0) merged.AND = allAnd;
    else delete merged.AND;
    return merged;
  };

  /** Stamp the workspace onto created rows, OVERWRITING anything the body sent. */
  const own = (data: Record<string, unknown>): Record<string, unknown> => ({
    ...data,
    workspace_id: scope.workspaceId,
  });

  return unscopedPrisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const kind = TENANT_MODELS[model as TenantModel];
          // Untenanted models (users, plans, stripe_events, platform_*) pass
          // through: they are not tenant data, and the boot assertion has already
          // verified that nothing carrying workspace_id reaches this branch.
          if (!kind) return query(args);
          // A 'parent' model has no workspace_id of its own; it is reachable only
          // through a scoped parent whose cascade protects it.
          if (kind === 'parent') return query(args);

          if (scope.readOnly && !READ_OPS.has(operation)) {
            throw new TenantScopeError(
              `read-only session attempted ${operation} on ${model}`,
            );
          }

          const a = args as Record<string, unknown>;

          switch (operation) {
            // extendedWhereUnique (GA since Prisma 5) allows non-unique filters
            // alongside the unique key on findUnique/update/delete/upsert, so the
            // predicate merges straight in.
            //
            // Note we do NOT rewrite findUnique to findFirst: Prisma 6's `query()`
            // callback takes args only — it has no second parameter for changing
            // the operation, and passing one lands in `customDataProxyFetch` and
            // throws at runtime.
            //
            // A wrong-tenant id yields null / P2025, which the error handler turns
            // into a 404 — never a 403, which would confirm the id exists.
            case 'findUnique':
            case 'findUniqueOrThrow':
            case 'update':
            case 'delete':
              return query({ ...a, where: scoped(model, a.where) });

            case 'upsert':
              // `args` here is the union of every model's upsert input, so the
              // rewritten object cannot be proven assignable to any one of them.
              // The extension is model-agnostic by design; the cast is the seam
              // where that generality meets Prisma's per-model types.
              return query({
                ...a,
                where: scoped(model, a.where),
                create: own(a.create as Record<string, unknown>),
              } as typeof args);

            case 'create':
              return query({ ...a, data: own(a.data as Record<string, unknown>) });

            case 'createMany':
            case 'createManyAndReturn': {
              const data = a.data as Record<string, unknown> | Record<string, unknown>[];
              return query({
                ...a,
                data: (Array.isArray(data) ? data : [data]).map(own),
              });
            }

            default:
              if (READ_OPS.has(operation) || operation === 'updateMany' || operation === 'deleteMany') {
                return query({ ...a, where: scoped(model, a.where) });
              }
              // Fail closed. A new Prisma operation we have not reasoned about
              // must not silently run unscoped.
              throw new TenantScopeError(`${operation} is not tenant-safe on ${model}`);
          }
        },
      },
    },
  });
}

/**
 * Boot assertion: every model carrying `workspace_id` must be registered in
 * TENANT_MODELS.
 *
 * Without this, the `if (!kind) return query(args)` fall-through above is a
 * footgun: a newly added tenant table would quietly run unscoped and leak across
 * customers. Called from index.ts before the server listens, so the failure mode
 * is a refused startup rather than a silent breach.
 */
/**
 * workspace_id is nullable on these BY DESIGN — NULL means "platform-level, not
 * any customer's". They are written on the vendor plane and read through explicit,
 * audited queries, so they are deliberately not auto-scoped.
 */
export const INTENTIONALLY_UNSCOPED = new Set([
  'audit_log',
  'outbound_emails',
  'impersonation_sessions',
  'subscriptions',
  'invoices',
]);

/** Minimal shape of what the check needs, so it can be tested with fixtures. */
export interface ModelShape {
  name: string;
  fields: readonly { name: string }[];
}

/**
 * The assertion's pure core, separated so a test can hand it a fabricated model
 * list. Testing that this PASSES on the real schema is nearly worthless; what
 * matters is proving it FAILS when a tenant model goes unregistered — the whole
 * reason it exists.
 */
export function findUnregisteredTenantModels(
  models: readonly ModelShape[],
  registry: Readonly<Record<string, unknown>> = TENANT_MODELS,
  exempt: ReadonlySet<string> = INTENTIONALLY_UNSCOPED,
): { unregistered: string[]; stale: string[] } {
  const unregistered: string[] = [];
  for (const model of models) {
    if (!model.fields.some((f) => f.name === 'workspace_id')) continue;
    if (exempt.has(model.name)) continue;
    if (!(model.name in registry)) unregistered.push(model.name);
  }
  // The reverse direction: a registered model that no longer exists means the
  // registry is drifting from the schema and someone's mental model is stale.
  const stale = Object.keys(registry).filter((name) => !models.some((m) => m.name === name));
  return { unregistered, stale };
}

export function assertTenantModelsRegistered(): void {
  const { unregistered, stale } = findUnregisteredTenantModels(Prisma.dmmf.datamodel.models);

  if (unregistered.length > 0) {
    throw new Error(
      `[tenant] these models carry workspace_id but are not registered in TENANT_MODELS ` +
        `(db/tenant.ts): ${unregistered.join(', ')}.\n` +
        `Register them, or add them to INTENTIONALLY_UNSCOPED with a reason. ` +
        `An unregistered tenant model runs UNSCOPED and leaks across customers.`,
    );
  }
  if (stale.length > 0) {
    throw new Error(`[tenant] TENANT_MODELS lists models that no longer exist: ${stale.join(', ')}`);
  }
}
