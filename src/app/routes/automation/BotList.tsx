import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { createBot, deleteBot, listBots } from '../../../lib/api/automation';
import { qk } from '../../../lib/queryKeys';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Badge } from '../../../ui/Badge';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { Locked, NoAccess } from '../../../ui/Locked';

export default function BotList() {
  const { workspace, can, plan } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: qk.bots(workspace.id),
    queryFn: () => listBots(workspace.id),
    enabled: can('bot:write') && plan.has('bot'),
  });

  const create = useMutation({
    mutationFn: () => createBot(workspace.id, { name: 'Untitled flow' }),
    onSuccess: async ({ item }) => {
      await queryClient.invalidateQueries({ queryKey: qk.bots(workspace.id) });
      navigate(`/w/${workspace.slug}/automation/bots/${item.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBot(workspace.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.bots(workspace.id) }),
  });

  if (!can('bot:write')) return <NoAccess what="bots" />;

  if (!plan.has('bot')) {
    return (
      <Page>
        <PageHeader icon={Bot} title="Bots" subtitle="Answer the predictable questions without anyone typing." />
        <Locked feature="Bot flows" onUpgrade={() => navigate(`/w/${workspace.slug}/settings/billing`)}>
          <Card className="p-10 text-center">
            <p className="font-semibold text-gray-800">Build a flow</p>
            <p className="text-sm text-gray-500 mt-1">
              Greet, ask a couple of questions, then hand over to the right person.
            </p>
          </Card>
        </Locked>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        icon={Bot}
        title="Bots"
        subtitle="Flows run on our servers, so a visitor sees the same thing wherever they are."
        action={
          <Button busy={create.isPending} onClick={() => create.mutate()}>
            New flow
          </Button>
        }
      />

      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}

      {list.data &&
        (list.data.items.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No flows yet"
            hint="Start with a greeting that asks what someone needs and routes them accordingly."
            action={<Button onClick={() => create.mutate()}>New flow</Button>}
          />
        ) : (
          <div className="space-y-2">
            {list.data.items.map((flow) => (
              <Card key={flow.id} className="p-4 flex items-center gap-3">
                <Link
                  to={`/w/${workspace.slug}/automation/bots/${flow.id}`}
                  className="min-w-0 flex-1"
                >
                  <p className="font-semibold text-gray-800 text-sm truncate">{flow.name}</p>
                  <p className="text-[11px] text-gray-400">
                    {flow.published_version
                      ? `Published v${flow.published_version}`
                      : 'Never published'}{' '}
                    · edited {new Date(flow.updated_at).toLocaleDateString()}
                  </p>
                </Link>
                <Badge tone={flow.is_active ? 'green' : 'gray'}>
                  {flow.is_active ? 'live' : 'off'}
                </Badge>
                <IconButton
                  label={`Delete ${flow.name}`}
                  onClick={() => {
                    if (confirm(`Delete “${flow.name}”?`)) remove.mutate(flow.id);
                  }}
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </IconButton>
              </Card>
            ))}
          </div>
        ))}
    </Page>
  );
}
