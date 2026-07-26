import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSession } from './session';
import { Shell } from './Shell';
import { Login } from './pages/Login';
import { Workspaces } from './pages/Workspaces';
import { WorkspaceDetail } from './pages/WorkspaceDetail';
import { SearchResults } from './pages/SearchResults';
import { Plans } from './pages/Plans';
import { Dunning } from './pages/Dunning';
import { Health } from './pages/Health';
import { Impersonations } from './pages/Impersonations';
import { Account } from './pages/Account';

/**
 * The ops panel's own QueryClient and router.
 *
 * A separate client from the customer app is not just tidiness: the two surfaces
 * cache data belonging to different subjects (one customer's own rows versus every
 * customer's), so sharing a cache would make a stale key from one visible to the
 * other. On a separate production origin they cannot share one anyway; keeping them
 * separate in dev means the dev environment tests the real arrangement.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Support work is bursty and re-reads the same customer repeatedly within a
      // few minutes; refetching on every window focus would turn a second monitor
      // into a request generator for no new information.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // A 401 already redirects to login inside api(), so retrying is wasted work
      // that only delays the redirect.
      retry: 1,
    },
  },
});

/**
 * Everything is behind the session. There is no public page on this surface —
 * `/ops` is either the login form or the panel, never a landing page.
 */
const router = createBrowserRouter([
  {
    path: '/ops',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/ops/workspaces" replace /> },
      { path: 'workspaces', element: <Workspaces /> },
      { path: 'workspaces/:id', element: <WorkspaceDetail /> },
      { path: 'search', element: <SearchResults /> },
      { path: 'plans', element: <Plans /> },
      { path: 'dunning', element: <Dunning /> },
      { path: 'impersonations', element: <Impersonations /> },
      { path: 'health', element: <Health /> },
      { path: 'account', element: <Account /> },
      // A mistyped deep link lands on the list rather than a blank screen; there is
      // nothing useful a 404 page could tell a staff member here.
      { path: '*', element: <Navigate to="/ops/workspaces" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/ops" replace /> },
]);

export function App() {
  const session = useSession();

  // The router is only mounted once signed in. Gating inside a loader would put a
  // redirect on every navigation for the same result with more moving parts.
  if (!session) {
    return (
      <QueryClientProvider client={queryClient}>
        <Login />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
