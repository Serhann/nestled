import { createContext, useContext } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getSettings, updateSettings, type SettingsBundle } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import type { WebsiteSettings } from '../../../lib/api/types';

/**
 * One website's settings, split across tabs.
 *
 * The settings bundle is loaded once here and shared with every tab through
 * context. Each tab fetching it separately would mean four requests to render one
 * screen, and four chances for them to disagree after a save.
 */

interface WebsiteSettingsValue {
  data: SettingsBundle;
  websiteId: string;
  /** Patch settings. Optimistic, because these are toggles and colour pickers. */
  save: (patch: Partial<WebsiteSettings>) => void;
  saving: boolean;
  error: unknown;
}

const Ctx = createContext<WebsiteSettingsValue | null>(null);

export function useWebsiteSettings(): WebsiteSettingsValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useWebsiteSettings must be used inside the website settings routes');
  return value;
}

const TABS = [
  { to: 'install', label: 'Install' },
  { to: 'appearance', label: 'Appearance' },
  { to: 'copy', label: 'Wording' },
  { to: 'forms', label: 'Forms' },
  { to: 'behavior', label: 'Behaviour' },
  { to: 'hours', label: 'Hours' },
  { to: 'security', label: 'Security' },
];

export default function WebsiteLayout() {
  const { websiteId = '' } = useParams();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.websiteSettings(workspace.id, websiteId),
    queryFn: () => getSettings(workspace.id, websiteId),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<WebsiteSettings>) => updateSettings(workspace.id, websiteId, patch),
    onMutate: async (patch) => {
      // Optimistic: a colour picker that lags behind the cursor feels broken. The
      // server may still override a plan-gated value, and the refetch below is
      // what makes that visible rather than silently divergent.
      const key = qk.websiteSettings(workspace.id, websiteId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SettingsBundle>(key);
      if (previous) {
        queryClient.setQueryData<SettingsBundle>(key, {
          ...previous,
          settings: { ...previous.settings, ...patch },
        });
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.websiteSettings(workspace.id, websiteId), context.previous);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: qk.websiteSettings(workspace.id, websiteId) }),
  });

  if (query.isLoading) return <Spinner />;
  if (query.error) return <Page><ErrorState error={query.error} onRetry={() => void query.refetch()} /></Page>;
  if (!query.data) return null;

  return (
    <Ctx.Provider
      value={{
        data: query.data,
        websiteId,
        save: (patch) => save.mutate(patch),
        saving: save.isPending,
        error: save.error,
      }}
    >
      <Page wide>
        <PageHeader
          title={query.data.website.name}
          subtitle={query.data.website.primary_domain ?? 'No domain set'}
        />
        <nav className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1" aria-label="Website settings">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </Page>
    </Ctx.Provider>
  );
}
