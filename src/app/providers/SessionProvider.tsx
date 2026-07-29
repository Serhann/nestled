import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { me as fetchMe } from '../../lib/api/auth';
import type { Me } from '../../lib/api/types';
import { onAuthLost } from '../../lib/http';
import { getSession, onSessionChange } from '../../lib/tokens';
import { qk } from '../../lib/queryKeys';

/**
 * `/api/v1/me` is the single most important request the app makes: it returns the
 * user, every workspace they belong to, and for each one the effective
 * capabilities, website scope, plan, limits and onboarding state. Route guards,
 * nav filtering and plan gating all read from here, so anything missing becomes a
 * second request on every page load.
 *
 * It is fetched once and shared. Nothing else in the app may call `/me` directly.
 */

interface SessionValue {
  me: Me;
  refresh: () => Promise<unknown>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

export function SessionProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (state: { loading: boolean; error: unknown }) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.me(),
    queryFn: () => fetchMe(),
    enabled: Boolean(getSession()),
    // The user's own record changes rarely; the pieces that change often
    // (unread counts) arrive over the socket.
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    // A session that ended anywhere — expired refresh token, sign-out in another
    // tab — drops every cached tenant row immediately. Leaving them would show the
    // previous user's inbox to whoever signs in next on a shared machine.
    const offAuth = onAuthLost(() => queryClient.clear());
    const offSession = onSessionChange((session) => {
      if (!session) queryClient.clear();
      else void queryClient.invalidateQueries({ queryKey: qk.me() });
    });
    return () => {
      offAuth();
      offSession();
    };
  }, [queryClient]);

  if (!query.data) {
    return <>{fallback({ loading: query.isLoading, error: query.error })}</>;
  }

  return (
    <SessionContext.Provider value={{ me: query.data, refresh: () => query.refetch() }}>
      {children}
    </SessionContext.Provider>
  );
}
