import { NavLink } from 'react-router';
import type { ReactNode } from 'react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { Page, PageHeader } from '../../../ui/Page';
import type { Capability } from '../../../lib/api/types';

/**
 * Workspace settings tabs.
 *
 * Not a layout route, because each settings page is reached directly and the tab
 * list is cheap to render. Keeping it a component means a page can be linked to
 * without threading through a parent that also fetches.
 */
const TABS: { to: string; label: string; capability?: Capability }[] = [
  { to: 'general', label: 'General' },
  { to: 'team', label: 'Team', capability: 'member:read' },
  { to: 'billing', label: 'Plan & billing', capability: 'billing:read' },
  { to: 'usage', label: 'Usage', capability: 'billing:read' },
  { to: 'integrations', label: 'Integrations', capability: 'integration:manage' },
  { to: 'audit', label: 'Audit log', capability: 'audit:read' },
];

export function SettingsLayout({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { workspace, can } = useWorkspace();
  return (
    <Page>
      <PageHeader title={title} subtitle={subtitle} action={action} />
      <nav className="flex gap-1 overflow-x-auto -mx-1 px-1" aria-label="Settings">
        {TABS.filter((t) => !t.capability || can(t.capability)).map((tab) => (
          <NavLink
            key={tab.to}
            to={`/w/${workspace.slug}/settings/${tab.to}`}
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
      {children}
    </Page>
  );
}
