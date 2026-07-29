import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getUsage } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Section } from '../../../ui/Card';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { SettingsLayout } from './SettingsLayout';

/**
 * What this workspace has used this month.
 *
 * Conversations are a SOFT limit and the copy says so, because the behaviour is
 * unusual enough to be worth stating: going over does not break the widget. The
 * alternative — refusing a conversation — means a visitor on the customer's own
 * site gets a broken chat and the customer silently loses a lead.
 */

const LABELS: Record<string, { label: string; limitKey: string; soft?: boolean }> = {
  conversations: { label: 'Conversations', limitKey: 'conversations_month', soft: true },
  ai_replies: { label: 'AI replies', limitKey: 'ai_replies_month' },
  emails: { label: 'Emails sent', limitKey: '' },
  storage_bytes: { label: 'Storage', limitKey: 'storage_mb' },
};

export default function Usage() {
  const { workspace, can } = useWorkspace();
  const query = useQuery({
    queryKey: qk.usage(workspace.id),
    queryFn: () => getUsage(workspace.id),
  });

  if (!can('billing:read')) return <NoAccess what="usage" />;

  const thisPeriod = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);

  return (
    <SettingsLayout title="Usage" subtitle="This calendar month.">
      {query.isLoading && <Spinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.data && (
        <Section title="This month">
          <div className="space-y-4">
            {Object.entries(LABELS).map(([metric, meta]) => {
              const counter = query.data.counters.find(
                (c) => c.metric === metric && c.period_start.slice(0, 10) === thisPeriod,
              );
              const raw = counter?.value ?? 0;
              const limit = meta.limitKey ? (query.data.limits[meta.limitKey] ?? 0) : 0;
              const used = metric === 'storage_bytes' ? raw / 1_048_576 : raw;
              const ratio = limit > 0 ? used / limit : 0;

              return (
                <div key={metric}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-sm font-medium text-gray-700">{meta.label}</span>
                    <span className="text-xs text-gray-500">
                      {format(used, metric)}
                      {limit > 0 ? ` of ${format(limit, metric)}` : ''}
                    </span>
                  </div>
                  {limit > 0 && (
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          ratio >= 1 ? 'bg-red-500' : ratio > 0.8 ? 'bg-amber-500' : 'bg-blue-600'
                        }`}
                        style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                      />
                    </div>
                  )}
                  {limit > 0 && ratio >= 1 && (
                    <p className="text-xs mt-1 text-gray-600">
                      {meta.soft
                        ? 'Over your allowance. Your widget keeps working — we will never break a live site over a limit — but it is time to move up a plan.'
                        : 'You have reached this limit. The AI falls back to knowledge-base answers and then to a person.'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </SettingsLayout>
  );
}

function format(value: number, metric: string): string {
  if (metric === 'storage_bytes') return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
  return Math.round(value).toLocaleString();
}
