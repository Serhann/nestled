import { NavLink, Outlet, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useSession } from '../../providers/SessionProvider';

/**
 * A shell for the account pages.
 *
 * These two routes sit outside the workspace layout, because your account is not a
 * property of a workspace — and until now that meant they had no chrome at all. Two
 * consequences, both visible the moment you opened one:
 *
 *   - **No way back.** No sidebar, no header, no link. The only exit was the browser's
 *     back button, and anyone arriving from a bookmark or an email did not have one.
 *   - **The page did not fill the screen.** `Page` is `flex-1`, which does nothing
 *     without a flex parent, so the background stopped at the end of the content and
 *     the rest of the viewport was bare white.
 *
 * The tabs live here rather than in each page so the two cannot drift, and so a third
 * one added later is a single line.
 */
const TABS = [
  { to: 'profile', label: 'Profile' },
  { to: 'security', label: 'Security' },
];

export default function AccountLayout() {
  const { me } = useSession();
  const navigate = useNavigate();

  /**
   * Back to wherever they actually came from.
   *
   * Their default workspace if they have one, otherwise the first, otherwise the
   * picker. Not `history.back()`: someone who landed here from a link has no history
   * to go back to, and a button that sometimes does nothing is worse than one that
   * always goes somewhere sensible.
   */
  const home =
    me.workspaces.find((w) => w.id === me.user.default_workspace_id) ?? me.workspaces[0];

  return (
    <div className="h-dvh flex flex-col bg-canvas text-gray-800">
      <header className="shrink-0 border-b border-gray-200/70 bg-cream">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4">
          <button
            onClick={() => navigate(home ? `/w/${home.slug}/inbox` : '/workspaces')}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            {home ? home.name : 'Your workspaces'}
          </button>
          <nav className="flex gap-1 ml-auto" aria-label="Account">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={`/account/${tab.to}`}
                className={({ isActive }) =>
                  `rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                    isActive ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
