import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useSession } from './SessionProvider';
import type { Capability, WorkspaceSummary } from '../../lib/api/types';

/**
 * The workspace is a PATH SEGMENT, resolved here from `:workspaceSlug`.
 *
 * Keeping it in the URL rather than in ambient state kills a whole class of bug
 * outright: two tabs open on two workspaces, the user switches in one, and the
 * other writes to the wrong tenant. It also makes every screen deep-linkable and
 * shareable with a colleague, which the old panel could not do at all.
 */

interface WorkspaceValue {
  workspace: WorkspaceSummary;
  /** Capability check, already narrowed for impersonation by the server. */
  can: (capability: Capability) => boolean;
  /** Is this member scoped to a subset of websites? */
  scopedTo: string[] | null;
  plan: {
    code: string;
    name: string;
    has: (feature: keyof WorkspaceSummary['plan']['features']) => boolean;
    limit: (metric: keyof WorkspaceSummary['plan']['limits']) => number;
  };
  /** True while a member of staff is acting inside this account. */
  impersonated: boolean;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside a /w/:workspaceSlug route');
  return value;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { workspaceSlug } = useParams();
  const { me } = useSession();

  const workspace = me.workspaces.find((w) => w.slug === workspaceSlug);

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!workspace) return null;
    const caps = new Set(workspace.permissions);
    return {
      workspace,
      can: (capability) => caps.has(capability),
      scopedTo: workspace.website_scope,
      plan: {
        code: workspace.plan.code,
        name: workspace.plan.name,
        has: (feature) => workspace.plan.features[feature],
        limit: (metric) => workspace.plan.limits[metric],
      },
      impersonated: me.impersonation?.workspace_id === workspace.id,
    };
  }, [workspace, me.impersonation]);

  if (!value) {
    // An unknown slug is far more often a stale bookmark or a workspace the user
    // has left than an attack, so it goes to the picker rather than to an error.
    return <Navigate to="/workspaces" replace />;
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
