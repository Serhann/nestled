import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { router } from '../app/router';
import { ApiError } from '../lib/http';
import '../index.css';
import { registerServiceWorker } from '../utils/registerSW';

// The customer team app is the installable PWA (Web Push, home screen). Only this
// entry registers the service worker — the widget and the ops panel never do.
registerServiceWorker();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime keeps the cache fresh, so background refetching is turned DOWN
      // rather than up: a refetch storm every time an agent alt-tabs is pure load
      // for data the socket already delivered.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Retrying an authorization or plan-limit failure only delays telling the
        // user something they have to act on.
        if (error instanceof ApiError && error.status < 500 && error.status !== 429) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
