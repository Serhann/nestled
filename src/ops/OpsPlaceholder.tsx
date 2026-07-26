/**
 * Stand-in for the platform (vendor) panel until Phase 13 builds it.
 *
 * It exists now so the `ops` build entry is real from Phase 0 onward: the origin
 * split, the nginx block and the bundle topology can all be verified before any
 * ops feature is written.
 */
export function OpsPlaceholder() {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 grid place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Nestled
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Platform panel</h1>
        <p className="mt-3 text-sm text-gray-400">
          Staff surface. Workspaces, plans, usage, impersonation and health land here
          in Phase 13.
        </p>
      </div>
    </div>
  );
}
