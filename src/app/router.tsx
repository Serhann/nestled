import { lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { APP_BASENAME } from '../lib/origins';
import { getSession } from '../lib/tokens';
import { SessionProvider, useSession } from './providers/SessionProvider';
import { WorkspaceProvider } from './providers/WorkspaceProvider';
import { RealtimeProvider } from './providers/RealtimeProvider';
import { AppShell } from './AppShell';
import { Spinner, ErrorState } from '../ui/Page';

/**
 * The route tree.
 *
 * Two structural decisions worth stating, because both are easy to undo by
 * accident:
 *
 * - **The workspace is a path segment** (`/w/:workspaceSlug/...`), not ambient
 *   state. Deep links work, two tabs can sit on two workspaces, and no component
 *   can accidentally write to whichever workspace was selected last.
 *
 * - **Inbox filters live in the query string.** That makes a filtered view
 *   shareable with a colleague and gives TanStack Query a natural cache key for
 *   free.
 */

const lazyRoute = (loader: () => Promise<{ default: React.ComponentType }>) => {
  const Component = lazy(loader);
  return { Component };
};

/** Everything that needs a signed-in user and a loaded /me. */
function Authenticated() {
  if (!getSession()) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return (
    <SessionProvider
      fallback={({ loading, error }) =>
        loading ? <Spinner label="Loading your account" /> : <ErrorState error={error} />
      }
    >
      <Outlet />
    </SessionProvider>
  );
}

/** `/` — send people where they were last, or to the picker. */
function Landing() {
  const { me } = useSession();
  if (me.workspaces.length === 0) return <Navigate to="/setup/workspace" replace />;
  const preferred =
    me.workspaces.find((w) => w.id === me.user.default_workspace_id) ?? me.workspaces[0]!;
  // An unfinished setup goes back to the wizard rather than to an inbox with
  // nothing in it and no explanation of what to do next.
  if (!preferred.onboarding.completed) {
    return <Navigate to={`/w/${preferred.slug}/setup`} replace />;
  }
  return <Navigate to={`/w/${preferred.slug}/inbox`} replace />;
}

/** The workspace frame: tenant context, then the socket, then the chrome. */
function WorkspaceLayout() {
  return (
    <WorkspaceProvider>
      <RealtimeProvider>
        <AppShell />
      </RealtimeProvider>
    </WorkspaceProvider>
  );
}

export const router = createBrowserRouter(
  [
    // ── Public ────────────────────────────────────────────────────────────
    { path: '/login', ...lazyRoute(() => import('./routes/auth/Login')) },
    { path: '/signup', ...lazyRoute(() => import('./routes/auth/Signup')) },
    { path: '/verify', ...lazyRoute(() => import('./routes/auth/Verify')) },
    { path: '/forgot', ...lazyRoute(() => import('./routes/auth/Forgot')) },
    { path: '/reset', ...lazyRoute(() => import('./routes/auth/Reset')) },
    { path: '/invite/:token', ...lazyRoute(() => import('./routes/auth/AcceptInvite')) },

    // ── Authenticated ─────────────────────────────────────────────────────
    {
      element: <Authenticated />,
      children: [
        { path: '/', element: <Landing /> },
        { path: '/workspaces', ...lazyRoute(() => import('./routes/WorkspacePicker')) },
        { path: '/workspaces/new', ...lazyRoute(() => import('./routes/setup/CreateWorkspace')) },
        { path: '/setup/workspace', ...lazyRoute(() => import('./routes/setup/CreateWorkspace')) },
        { path: '/account/profile', ...lazyRoute(() => import('./routes/account/Profile')) },
        { path: '/account/security', ...lazyRoute(() => import('./routes/account/Security')) },

        {
          path: '/w/:workspaceSlug',
          element: <WorkspaceLayout />,
          children: [
            { index: true, element: <Navigate to="inbox" replace /> },

            { path: 'inbox', ...lazyRoute(() => import('./routes/inbox/Inbox')) },
            { path: 'inbox/:conversationId', ...lazyRoute(() => import('./routes/inbox/Inbox')) },

            { path: 'visitors', ...lazyRoute(() => import('./routes/visitors/Visitors')) },
            { path: 'visitors/:visitorId', ...lazyRoute(() => import('./routes/visitors/Visitors')) },

            { path: 'websites', ...lazyRoute(() => import('./routes/websites/WebsiteList')) },
            { path: 'websites/new', ...lazyRoute(() => import('./routes/websites/NewWebsite')) },
            {
              path: 'websites/:websiteId',
              ...lazyRoute(() => import('./routes/websites/WebsiteLayout')),
              children: [
                { index: true, element: <Navigate to="install" replace /> },
                { path: 'install', ...lazyRoute(() => import('./routes/websites/Install')) },
                { path: 'appearance', ...lazyRoute(() => import('./routes/websites/Appearance')) },
                { path: 'copy', ...lazyRoute(() => import('./routes/websites/CopyEditor')) },
                { path: 'forms', ...lazyRoute(() => import('./routes/websites/Forms')) },
                { path: 'behavior', ...lazyRoute(() => import('./routes/websites/Behavior')) },
                { path: 'hours', ...lazyRoute(() => import('./routes/websites/Hours')) },
                { path: 'channels', ...lazyRoute(() => import('./routes/websites/Channels')) },
                { path: 'security', ...lazyRoute(() => import('./routes/websites/Security')) },
              ],
            },

            { path: 'content/kb', ...lazyRoute(() => import('./routes/content/KnowledgeBase')) },
            { path: 'content/canned', ...lazyRoute(() => import('./routes/content/Canned')) },
            { path: 'content/starters', ...lazyRoute(() => import('./routes/content/Starters')) },

            { path: 'automation/campaigns', ...lazyRoute(() => import('./routes/automation/Campaigns')) },
            { path: 'automation/routing', ...lazyRoute(() => import('./routes/automation/Routing')) },
            { path: 'automation/bots', ...lazyRoute(() => import('./routes/automation/BotList')) },
            { path: 'automation/bots/:flowId', ...lazyRoute(() => import('./routes/automation/BotBuilder')) },

            { path: 'settings/general', ...lazyRoute(() => import('./routes/settings/General')) },
            { path: 'settings/team', ...lazyRoute(() => import('./routes/settings/Team')) },
            { path: 'settings/billing', ...lazyRoute(() => import('./routes/settings/Billing')) },
            { path: 'settings/usage', ...lazyRoute(() => import('./routes/settings/Usage')) },
            { path: 'settings/integrations', ...lazyRoute(() => import('./routes/settings/Integrations')) },
            { path: 'settings/audit', ...lazyRoute(() => import('./routes/settings/Audit')) },

            // The wizard lives INSIDE the workspace frame so a customer can leave
            // it and come back; the server owns which step they are on.
            { path: 'setup', ...lazyRoute(() => import('./routes/setup/SetupFlow')) },
            { path: 'setup/:step', ...lazyRoute(() => import('./routes/setup/SetupFlow')) },
          ],
        },
      ],
    },

    { path: '*', ...lazyRoute(() => import('./routes/NotFound')) },
  ],
  { basename: APP_BASENAME || undefined },
);
