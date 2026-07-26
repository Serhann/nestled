import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getAudit } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Section } from '../../../ui/Card';
import { Badge } from '../../../ui/Badge';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { SettingsLayout } from './SettingsLayout';

/**
 * Who did what.
 *
 * Actions taken by Nestled support while impersonating this workspace land here
 * too, marked as such. That is the point of the log rather than an afterthought:
 * a customer must be able to see everything done inside their account, including
 * by us.
 */
export default function Audit() {
  const { workspace, can } = useWorkspace();
  const query = useQuery({
    queryKey: qk.audit(workspace.id),
    queryFn: () => getAudit(workspace.id),
    enabled: can('audit:read'),
  });

  if (!can('audit:read')) return <NoAccess what="the audit log" />;

  return (
    <SettingsLayout title="Audit log" subtitle="The last 200 changes in this workspace.">
      {query.isLoading && <Spinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.data && (
        <Section title="Activity">
          {query.data.entries.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {query.data.entries.map((entry) => (
                <li key={entry.id} className="py-2.5 flex items-start gap-3 text-sm">
                  <span className="text-[11px] text-gray-400 w-32 shrink-0 pt-0.5">
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-gray-800">
                      <span className="font-medium">{entry.actor_name ?? 'System'}</span>{' '}
                      <span className="text-gray-500">{humanise(entry.action)}</span>
                    </p>
                    {entry.target_type && (
                      <p className="text-[11px] text-gray-400">
                        {entry.target_type} {entry.target_id?.slice(0, 8)}
                      </p>
                    )}
                  </div>
                  {entry.actor_type === 'platform_user' && <Badge tone="violet">Nestled support</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </SettingsLayout>
  );
}

function humanise(action: string): string {
  return action.replace(/[._]/g, ' ');
}
