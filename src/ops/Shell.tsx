import { NavLink, Outlet, useNavigate } from 'react-router';
import { api } from './api';
import { setSession, useSession } from './session';
import { GlobalSearch } from './GlobalSearch';

/**
 * The frame every signed-in page renders inside.
 *
 * Two things here are not decoration:
 *  - the search box lives in the header, so it is reachable without navigating;
 *  - the read-only banner is permanent, not a toast. A staff member without a
 *    second factor will otherwise discover the restriction from a 403 on the
 *    thing they were trying to do, at the moment they are least able to fix it.
 */

const NAV = [
  { to: '/ops/workspaces', label: 'Workspaces' },
  { to: '/ops/dunning', label: 'Dunning' },
  { to: '/ops/plans', label: 'Plans' },
  { to: '/ops/impersonations', label: 'Impersonations' },
  { to: '/ops/health', label: 'Health' },
  { to: '/ops/settings', label: 'Settings' },
  { to: '/ops/account', label: 'Account' },
];

export function Shell() {
  const session = useSession();
  const navigate = useNavigate();

  async function signOut() {
    // Best-effort: the local session is dropped either way, so a network failure
    // cannot leave a staff member apparently signed in.
    await api('/platform/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
    navigate('/ops');
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-700 bg-gray-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5">
          <NavLink to="/ops/workspaces" className="shrink-0 text-sm font-semibold tracking-tight">
            Nestled <span className="text-gray-500">ops</span>
          </NavLink>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3 text-xs text-gray-400">
            <span title={session?.user.email}>
              {session?.user.name} · {session?.user.role}
            </span>
            <button type="button" onClick={signOut} className="rounded px-2 py-1 hover:bg-gray-700">
              Sign out
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 pb-1.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${
                  isActive ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {session && !session.user.can_write && (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-200">
          This session is <strong>read-only</strong>. A password alone cannot change customer data —{' '}
          <NavLink to="/ops/account" className="underline">
            enroll an authenticator
          </NavLink>{' '}
          to make changes.
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
