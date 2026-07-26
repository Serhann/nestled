import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Pencil, Route, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import {
  createRouting,
  deleteRouting,
  listRouting,
  updateRouting,
  type RoutingRule,
} from '../../../lib/api/automation';
import { listMembers, listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { Modal } from '../../../ui/Modal';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope } from '../../../ui/WebsiteScope';

/**
 * Who gets the next conversation.
 *
 * An ordered when/then table, not a graph. A graph editor here would be strictly
 * worse: the rules are short, they are evaluated top to bottom, and "which rule
 * wins" is the only question anyone actually asks — which a list answers by
 * reading it.
 */
export default function Routing() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<RoutingRule> | null>(null);

  const list = useQuery({
    queryKey: qk.routing(workspace.id),
    queryFn: () => listRouting(workspace.id),
    enabled: can('routing:write'),
  });
  const members = useQuery({
    queryKey: qk.members(workspace.id),
    queryFn: () => listMembers(workspace.id),
    enabled: can('member:read'),
    staleTime: 5 * 60_000,
  });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.routing(workspace.id) });

  const save = useMutation({
    mutationFn: (rule: Partial<RoutingRule>) =>
      rule.id ? updateRouting(workspace.id, rule.id, rule) : createRouting(workspace.id, rule),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRouting(workspace.id, id),
    onSuccess: invalidate,
  });

  if (!can('routing:write')) return <NoAccess what="routing" />;

  const rules = [...(list.data?.items ?? [])].sort((a, b) => a.priority - b.priority);

  return (
    <Page>
      <PageHeader
        icon={Route}
        title="Routing"
        subtitle="Checked top to bottom. The first rule that matches wins."
        action={
          <Button
            onClick={() =>
              setEditing({
                name: '',
                priority: (rules.length ? rules[rules.length - 1]!.priority : 0) + 10,
                is_active: true,
                strategy: 'round_robin',
                member_pool: [],
                conditions: {},
              })
            }
          >
            New rule
          </Button>
        }
      />

      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}

      {list.data &&
        (rules.length === 0 ? (
          <EmptyState
            icon={Route}
            title="No routing rules"
            hint="Without one, conversations stay unassigned until somebody picks them up."
          />
        ) : (
          <div className="space-y-1">
            {rules.map((rule, index) => (
              <div key={rule.id}>
                <Card className="p-4 flex items-start gap-3">
                  <span className="w-6 h-6 shrink-0 rounded-full bg-gray-100 text-gray-500 text-xs font-semibold flex items-center justify-center mt-0.5">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 text-sm">{rule.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {strategyLabel(rule.strategy)} across{' '}
                      {rule.member_pool.length === 0
                        ? 'everyone'
                        : `${rule.member_pool.length} teammate${rule.member_pool.length === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <Toggle
                    checked={rule.is_active}
                    onChange={(v) => save.mutate({ id: rule.id, is_active: v })}
                  />
                  <IconButton label="Edit" onClick={() => setEditing(rule)}>
                    <Pencil className="w-4 h-4" aria-hidden />
                  </IconButton>
                  <IconButton
                    label="Delete"
                    onClick={() => {
                      if (confirm(`Delete “${rule.name}”?`)) remove.mutate(rule.id);
                    }}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </IconButton>
                </Card>
                {index < rules.length - 1 && (
                  <div className="flex justify-center py-0.5">
                    <ArrowDown className="w-3 h-3 text-gray-300" aria-hidden />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

      {editing && (
        <Modal
          title={editing.id ? 'Edit rule' : 'New rule'}
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button busy={save.isPending} onClick={() => save.mutate(editing)}>
                Save
              </Button>
            </>
          }
        >
          <div className="space-y-4 pb-2">
            {save.error ? (
              <p role="alert" className="text-sm text-red-600">
                {(save.error as Error).message}
              </p>
            ) : null}
            <Field label="Name" required>
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Billing questions to the finance team"
                />
              )}
            </Field>

            <Field label="Only when the page matches" hint="Blank means any page.">
              {(a) => (
                <TextInput
                  {...a}
                  value={String((editing.conditions as Record<string, unknown>)?.url_pattern ?? '')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      conditions: { ...(editing.conditions ?? {}), url_pattern: e.target.value },
                    })
                  }
                  placeholder="/billing*"
                />
              )}
            </Field>

            <Field label="Only when tagged" hint="Blank means any conversation.">
              {(a) => (
                <TextInput
                  {...a}
                  value={String((editing.conditions as Record<string, unknown>)?.tag ?? '')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      conditions: { ...(editing.conditions ?? {}), tag: e.target.value },
                    })
                  }
                />
              )}
            </Field>

            <Field label="How to pick someone">
              {(a) => (
                <Select
                  {...a}
                  value={editing.strategy ?? 'round_robin'}
                  onChange={(e) =>
                    setEditing({ ...editing, strategy: e.target.value as RoutingRule['strategy'] })
                  }
                >
                  <option value="round_robin">Take turns</option>
                  <option value="least_active">Whoever has the fewest open chats</option>
                  <option value="specific">Always the same person</option>
                </Select>
              )}
            </Field>

            <div>
              <span className="block text-sm font-semibold text-gray-700 mb-1.5">Who is in the pool</span>
              <div className="flex flex-wrap gap-2">
                {(members.data?.members ?? []).map((member) => {
                  const selected = (editing.member_pool ?? []).includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setEditing({
                          ...editing,
                          member_pool: selected
                            ? (editing.member_pool ?? []).filter((id) => id !== member.id)
                            : [...(editing.member_pool ?? []), member.id],
                        })
                      }
                      className={`rounded-full border-[1.5px] px-3.5 py-1.5 text-sm font-semibold transition ${
                        selected
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {member.user.name}
                    </button>
                  );
                })}
              </div>
              <span className="block text-xs text-gray-400 mt-1">
                People who are offline are skipped, and their turn is kept for when they come back.
              </span>
            </div>

            <Field
              label="Most open chats one person should have"
              hint="Reached, and we move on to the next person in the pool. 0 for no cap."
            >
              {(a) => (
                <TextInput
                  {...a}
                  type="number"
                  min={0}
                  max={100}
                  value={Number((editing.conditions as Record<string, unknown>)?.max_concurrent ?? 0)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      conditions: {
                        ...(editing.conditions ?? {}),
                        max_concurrent: Number(e.target.value),
                      },
                    })
                  }
                />
              )}
            </Field>

            <WebsiteScope
              websites={websites.data?.websites ?? []}
              value={editing.website_id ? [editing.website_id] : []}
              onChange={(ids) => setEditing({ ...editing, website_id: ids[0] ?? null })}
            />
          </div>
        </Modal>
      )}
    </Page>
  );
}

function strategyLabel(strategy: RoutingRule['strategy']): string {
  return strategy === 'round_robin'
    ? 'Takes turns'
    : strategy === 'least_active'
      ? 'Fewest open chats'
      : 'A specific person';
}
