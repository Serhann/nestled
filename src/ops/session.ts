import { useSyncExternalStore } from 'react';
import { clearSession, loadSession, saveSession, type StoredSession } from './api';

/**
 * The signed-in staff member, as a subscribable store.
 *
 * `useSyncExternalStore` over a context provider because the session also changes
 * from outside React — `api()` clears it on a 401. A context would go stale in that
 * path and leave the panel rendering a logged-in shell over 401s.
 */

const listeners = new Set<() => void>();
let snapshot: StoredSession | null = loadSession();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSession(session: StoredSession | null): void {
  snapshot = session;
  if (session) saveSession(session);
  else clearSession();
  emit();
}

/** Re-read from storage after a partial update (e.g. TOTP enrollment). */
export function refreshSession(): void {
  snapshot = loadSession();
  emit();
}

export function useSession(): StoredSession | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
