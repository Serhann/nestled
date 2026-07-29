import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import {
  Bot,
  BookOpen,
  ChevronsUpDown,
  Globe,
  Inbox,
  LogOut,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
  Volume2,
  VolumeX,
  Zap, Timer } from 'lucide-react';
import { useSession } from './providers/SessionProvider';
import { useWorkspace } from './providers/WorkspaceProvider';
import { useRealtime } from './providers/RealtimeProvider';
import { logout } from '../lib/api/auth';
import { resendVerification } from '../lib/api/auth';
import { Spinner } from '../ui/Page';
import { useAppStore } from './store';
import { mountSupportWidget } from '../lib/supportWidget';
import { playChime } from '../lib/sound';
import { get } from '../lib/http';
import type { Capability } from '../lib/api/types';

/**
 * The application frame: navigation, the workspace switcher, and the banners that
 * must not be dismissible.
 */

interface NavItem {
  to: string;
  label: string;
  icon: typeof Inbox;
  capability?: Capability;
  badge?: number;
}

export function AppShell() {
  const { me } = useSession();
  const { workspace, can, impersonated } = useWorkspace();
  const { connected } = useRealtime();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const base = `/w/${workspace.slug}`;

  // Our own support chat, if this install has one configured.
  //
  // It carries a SIGNED description of who is asking — workspace, plan, role —
  // so an agent sees a verified account instead of spending three messages
  // establishing which one it is. Same HMAC mechanism any customer uses to vouch
  // for their own visitors, turned on ourselves.
  useEffect(() => {
    mountSupportWidget(() =>
      get<{ context_token: string | null }>(
        `/api/v1/me/support-context?workspace=${encodeURIComponent(workspace.slug)}`,
      ),
    );
  }, [workspace.slug]);

  const items: NavItem[] = [
    { to: `${base}/inbox`, label: 'Inbox', icon: Inbox, capability: 'conversation:read', badge: workspace.counts.open_conversations },
    { to: `${base}/visitors`, label: 'Visitors', icon: Users, capability: 'visitor:read' },
    { to: `${base}/reports`, label: 'Response times', icon: Timer, capability: 'conversation:read' },
    { to: `${base}/websites`, label: 'Websites', icon: Globe, capability: 'website:read' },
    { to: `${base}/content/kb`, label: 'Knowledge', icon: BookOpen, capability: 'kb:read' },
    { to: `${base}/content/canned`, label: 'Canned replies', icon: MessageSquareText, capability: 'canned:read' },
    { to: `${base}/content/starters`, label: 'Starters', icon: Sparkles, capability: 'starter:write' },
    { to: `${base}/automation/campaigns`, label: 'Campaigns', icon: Zap, capability: 'trigger:write' },
    { to: `${base}/automation/bots`, label: 'Bots', icon: Bot, capability: 'bot:write' },
    { to: `${base}/automation/routing`, label: 'Routing', icon: Route, capability: 'routing:write' },
    { to: `${base}/settings/general`, label: 'Settings', icon: Settings, capability: 'workspace:read' },
  ];

  return (
    <div className="h-dvh flex flex-col bg-canvas text-gray-800">
      {impersonated && <ImpersonationBanner />}
      <VerificationBanner />
      <TrialBanner />

      <div className="flex-1 flex min-h-0">
        <nav
          aria-label="Main"
          className={`hidden md:flex flex-col shrink-0 border-r border-gray-200/70 bg-cream ${
            collapsed ? 'w-16' : 'w-60'
          } transition-[width]`}
        >
          <WorkspaceSwitcher collapsed={collapsed} />
          <ul className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
            {items
              .filter((item) => !item.capability || can(item.capability))
              .map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-2xl px-3 py-2 text-sm font-medium transition ${
                        isActive ? 'bg-blue-100 text-blue-800' : 'text-gray-600 hover:bg-gray-100'
                      }`
                    }
                  >
                    <item.icon className="w-[18px] h-[18px] shrink-0" aria-hidden />
                    {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                    {!collapsed && item.badge ? (
                      <span className="text-[11px] font-semibold bg-blue-600 text-white rounded-full px-1.5 py-0.5">
                        {item.badge}
                      </span>
                    ) : null}
                  </NavLink>
                </li>
              ))}
          </ul>
          <ConnectionDot connected={connected} collapsed={collapsed} />
          <SidebarFooterControls collapsed={collapsed} />
          <AccountMenu collapsed={collapsed} name={me.user.name} email={me.user.email} />
        </nav>

        <main className="flex-1 min-w-0 flex flex-col">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <MobileNav items={items.filter((i) => !i.capability || can(i.capability)).slice(0, 5)} />
    </div>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { me } = useSession();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative p-2 border-b border-gray-200/70">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-full flex items-center gap-2 rounded-2xl px-2.5 py-2 hover:bg-gray-100 transition text-left"
      >
        <span className="w-8 h-8 shrink-0 rounded-xl bg-blue-600 text-white font-display text-lg flex items-center justify-center">
          {workspace.name.charAt(0).toUpperCase()}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold truncate">{workspace.name}</span>
              <span className="block text-[11px] text-gray-500 capitalize">{workspace.plan.name}</span>
            </span>
            <ChevronsUpDown className="w-4 h-4 text-gray-400" aria-hidden />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-2 right-2 top-full mt-1 z-30 bg-white rounded-2xl shadow-lg border border-gray-100 py-1"
        >
          {me.workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                // A workspace switch is a NAVIGATION, not a state change. That is
                // the whole point of the tenant living in the URL: the other tab
                // stays where it was.
                navigate(`/w/${w.slug}/inbox`);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                w.id === workspace.id ? 'font-semibold text-blue-700' : 'text-gray-700'
              }`}
            >
              {w.name}
              {w.counts.open_conversations > 0 && (
                <span className="float-right text-[11px] text-gray-400">
                  {w.counts.open_conversations}
                </span>
              )}
            </button>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/workspaces/new');
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              Create a workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Narrow the sidebar, and mute.
 *
 * Both settings already existed and neither could be reached. `toggleSidebar` was
 * written, persisted and called by nothing, so the collapsed width was dead code;
 * `soundEnabled` was persisted for a sound that was never played. They sit together
 * because they are the two things you change about the frame itself rather than
 * about your account — and mute in particular has to be one click from the inbox,
 * because the moment you want it is the moment a chime went off in a meeting.
 */
function SidebarFooterControls({ collapsed }: { collapsed: boolean }) {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const soundEnabled = useAppStore((s) => s.soundEnabled);
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled);

  return (
    <div className={`px-2 pb-1 flex gap-1 ${collapsed ? 'flex-col items-stretch' : ''}`}>
      <button
        onClick={() => {
          // Play as you turn it ON, so the control proves itself. Silence is the
          // expected result of the other direction and needs no demonstration.
          if (!soundEnabled) playChime();
          setSoundEnabled(!soundEnabled);
        }}
        title={soundEnabled ? 'Mute notification sounds' : 'Unmute notification sounds'}
        aria-pressed={soundEnabled}
        className={`flex items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium transition hover:bg-gray-100 ${
          soundEnabled ? 'text-gray-600' : 'text-gray-400'
        } ${collapsed ? '' : 'flex-1'}`}
      >
        {soundEnabled ? (
          <Volume2 className="w-[18px] h-[18px] shrink-0" aria-hidden />
        ) : (
          <VolumeX className="w-[18px] h-[18px] shrink-0" aria-hidden />
        )}
        {!collapsed && <span className="truncate">{soundEnabled ? 'Sound on' : 'Muted'}</span>}
      </button>
      <button
        onClick={toggleSidebar}
        title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
        aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
        className="flex items-center justify-center rounded-2xl px-3 py-2 text-gray-500 hover:bg-gray-100 transition"
      >
        {collapsed ? (
          <PanelLeftOpen className="w-[18px] h-[18px]" aria-hidden />
        ) : (
          <PanelLeftClose className="w-[18px] h-[18px]" aria-hidden />
        )}
      </button>
    </div>
  );
}

function AccountMenu({
  collapsed,
  name,
  email,
}: {
  collapsed: boolean;
  name: string;
  email: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="p-2 border-t border-gray-200/70 space-y-0.5">
      <button
        onClick={() => navigate('/account/profile')}
        className="w-full flex items-center gap-2.5 rounded-2xl px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition text-left"
      >
        <span className="w-7 h-7 shrink-0 rounded-full bg-gray-200 text-gray-600 text-xs font-semibold flex items-center justify-center">
          {name.charAt(0).toUpperCase()}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-gray-700">{name}</span>
            <span className="block truncate text-[11px] text-gray-400">{email}</span>
          </span>
        )}
      </button>
      <button
        onClick={() => {
          void logout().finally(() => {
            window.location.href = '/login';
          });
        }}
        className="w-full flex items-center gap-2.5 rounded-2xl px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 transition"
      >
        <LogOut className="w-[18px] h-[18px]" aria-hidden />
        {!collapsed && <span>Sign out</span>}
      </button>
    </div>
  );
}

function ConnectionDot({ connected, collapsed }: { connected: boolean; collapsed: boolean }) {
  // Shown only when something is wrong. A permanent green light is noise; a red
  // one that appears when messages have stopped arriving is information.
  if (connected) return null;
  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden />
      {!collapsed && <span>Reconnecting…</span>}
    </div>
  );
}

function ImpersonationBanner() {
  const { me } = useSession();
  const scope = me.impersonation?.scope;
  return (
    <div
      role="alert"
      className="shrink-0 flex items-center justify-center gap-2 bg-violet-600 text-white text-xs font-semibold px-4 py-2"
    >
      <ShieldAlert className="w-4 h-4" aria-hidden />
      Nestled support is signed in to this workspace
      {scope === 'read_only' ? ' (read only)' : ''}. Every action is recorded in your audit log.
    </div>
  );
}

function VerificationBanner() {
  const { me } = useSession();
  const [sent, setSent] = useState(false);
  if (me.user.email_verified) return null;

  /**
   * The version of this banner that is true on an install with no mail.
   *
   * "Check your inbox" when nothing was ever sent is a loop with no exit: unverified
   * blocks invitations, so the owner concludes team management is broken and has no
   * way to find out why. Naming the actual cause turns it into a five-minute fix by
   * whoever runs the install.
   */
  if (me.user.can_send_email === false) {
    return (
      <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 bg-amber-100 text-amber-900 text-xs font-medium px-4 py-2">
        Your email is unconfirmed, and this installation has no mail server set up — so
        no confirmation can be sent. Until it is, invitations cannot go out. An operator
        can add SMTP in the ops panel under Settings → Email.
      </div>
    );
  }

  return (
    <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 bg-amber-100 text-amber-900 text-xs font-medium px-4 py-2">
      Confirm your email to start sending invitations and serving your widget.
      <button
        onClick={() => void resendVerification().then(() => setSent(true))}
        className="font-semibold underline underline-offset-2"
      >
        {sent ? 'Sent — check your inbox' : 'Resend the email'}
      </button>
    </div>
  );
}

function TrialBanner() {
  const { workspace } = useWorkspace();
  const { status, trial_ends_at, grace_until } = workspace.subscription;
  const dismissed = useAppStore((s) => s.isDismissed(`trial:${workspace.id}`));
  const dismiss = useAppStore((s) => s.dismiss);

  if (status === 'trialing' && trial_ends_at) {
    const days = Math.ceil((new Date(trial_ends_at).getTime() - Date.now()) / 86_400_000);
    // Silence until the end is actually near — a countdown from day one is just
    // pressure, and people stop reading banners that are always there.
    if (days > 5 || dismissed) return null;
    return (
      <Banner tone="amber" onDismiss={() => dismiss(`trial:${workspace.id}`)}>
        {days <= 0 ? 'Your trial has ended.' : `${days} day${days === 1 ? '' : 's'} left in your trial.`}{' '}
        <a href={`/w/${workspace.slug}/settings/billing`} className="font-semibold underline">
          Choose a plan
        </a>
      </Banner>
    );
  }

  if (status === 'past_due') {
    return (
      <Banner tone="red">
        We couldn’t take your last payment. Your widget keeps running for now.{' '}
        <a href={`/w/${workspace.slug}/settings/billing`} className="font-semibold underline">
          Update your card
        </a>
      </Banner>
    );
  }

  if (status === 'trial_expired' && grace_until) {
    return (
      <Banner tone="red">
        Your trial has ended. Your widget stays live until{' '}
        {new Date(grace_until).toLocaleDateString()}.{' '}
        <a href={`/w/${workspace.slug}/settings/billing`} className="font-semibold underline">
          Pick a plan
        </a>
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: 'amber' | 'red';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    amber: 'bg-amber-100 text-amber-900',
    red: 'bg-red-100 text-red-800',
  } as const;
  return (
    <div className={`shrink-0 flex items-center justify-center gap-3 text-xs px-4 py-2 ${tones[tone]}`}>
      <span>{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

function MobileNav({ items }: { items: NavItem[] }) {
  return (
    <nav
      aria-label="Main"
      className="md:hidden shrink-0 flex border-t border-gray-200 bg-cream pb-[env(safe-area-inset-bottom)]"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              isActive ? 'text-blue-700' : 'text-gray-500'
            }`
          }
        >
          <item.icon className="w-5 h-5" aria-hidden />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
