import { createContext, useContext } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
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
  { to: 'channels', label: 'Email & SMS' },
  { to: 'response-times', label: 'Response times' },
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
        {/*
          A rejected save, said out loud.
          
          Every control on these tabs saves optimistically on change and rolls back on
          failure, and the rollback was silent — so a refused value looked exactly like
          a control that does not work. Adding a pre-chat question was the clearest
          case: the row appeared and vanished on the next frame, with a 400 nobody saw.
          
          Rendered here rather than on each tab so a page added later cannot forget it.
        */}
        {save.error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span className="flex-1">
              <b>That change was not saved.</b> {messageFor(save.error)}
            </span>
            <button onClick={() => save.reset()} className="font-semibold underline shrink-0">
              Dismiss
            </button>
          </div>
        )}
        <Outlet />
      </Page>
    </Ctx.Provider>
  );
}

/**
 * The server's own words where it has any.
 *
 * A validation failure names the field that was refused, and that is exactly what the
 * person looking at the form needs. "Something went wrong" would make them try the
 * same thing again.
 */
function messageFor(error: unknown): string {
  // On `body`, not on the error: ApiError keeps the parsed payload there, and the
  // validation shape is `{ error, details: [{ path, message }] }`.
  const body = (error as { body?: unknown } | null)?.body;
  const details = (body as { details?: { path?: string; message?: string }[] } | null)?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details
      .map((d) => (d.path ? `${d.path}: ${d.message ?? 'invalid'}` : (d.message ?? 'invalid')))
      .join('; ');
  }
  const message = (error as { message?: string } | null)?.message;
  return message && message !== 'Invalid request' ? message : 'The server refused the value.';
}
