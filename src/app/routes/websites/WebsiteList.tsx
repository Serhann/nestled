import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Globe } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';

export default function WebsiteList() {
  const { workspace, can, plan } = useWorkspace();
  const query = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
  });

  if (!can('website:read')) return <NoAccess what="websites" />;

  const used = query.data?.websites.length ?? 0;
  const allowed = plan.limit('websites');
  const atLimit = allowed > 0 && used >= allowed;

  return (
    <Page>
      <PageHeader
        icon={Globe}
        title="Websites"
        subtitle={`Each website gets its own widget, settings and inbox filter. ${used} of ${allowed} used.`}
        action={
          can('website:create') && (
            <Link to={atLimit ? `/w/${workspace.slug}/settings/billing` : `/w/${workspace.slug}/websites/new`}>
              <Button>{atLimit ? 'Upgrade for more' : 'Add a website'}</Button>
            </Link>
          )
        }
      />

      {query.isLoading && <Spinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.data &&
        (query.data.websites.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No websites yet"
            hint="Add the site you want to chat on and we will give you a snippet."
            action={
              <Link to={`/w/${workspace.slug}/websites/new`}>
                <Button>Add a website</Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">
            {query.data.websites.map((site) => (
              <Link key={site.id} to={`/w/${workspace.slug}/websites/${site.id}/install`}>
                <Card className="p-4 hover:shadow transition flex items-center gap-3">
                  <span
                    className={`w-9 h-9 shrink-0 rounded-2xl flex items-center justify-center ${
                      site.installed_at ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                    }`}
                  >
                    {site.installed_at ? (
                      <CheckCircle2 className="w-5 h-5" aria-hidden />
                    ) : (
                      <Circle className="w-5 h-5" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 truncate">{site.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {site.primary_domain ?? 'No domain'} ·{' '}
                      {site.installed_at ? 'installed' : 'not installed yet'}
                    </p>
                  </div>
                  <code className="hidden sm:block text-[11px] text-gray-400 font-mono">
                    {site.public_key}
                  </code>
                </Card>
              </Link>
            ))}
          </div>
        ))}
    </Page>
  );
}
