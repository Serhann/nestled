import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Zap } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import {
  createTrigger,
  deleteTrigger,
  listTriggers,
  updateTrigger,
  type Trigger,
} from '../../../lib/api/automation';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { ApiError } from '../../../lib/http';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, Select, TextArea, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { Badge } from '../../../ui/Badge';
import { Modal } from '../../../ui/Modal';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope } from '../../../ui/WebsiteScope';

/**
 * Campaigns: say something without waiting to be asked.
 *
 * The event that fires a campaign is evaluated in the visitor's browser, because
 * the useful signals — time on page, scroll depth, leaving the tab — only exist
 * there. What it *does* is decided here.
 */
export default function Campaigns() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<Trigger> | null>(null);

  const list = useQuery({
    queryKey: qk.triggers(workspace.id),
    queryFn: () => listTriggers(workspace.id),
    enabled: can('trigger:write'),
  });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.triggers(workspace.id) });

  const save = useMutation({
    mutationFn: (item: Partial<Trigger>) =>
      item.id ? updateTrigger(workspace.id, item.id, item) : createTrigger(workspace.id, item),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteTrigger(workspace.id, id),
    onSuccess: invalidate,
  });

  if (!can('trigger:write')) return <NoAccess what="campaigns" />;

  const limit = save.error instanceof ApiError ? save.error.planLimit : null;

  return (
    <Page>
      <PageHeader
        icon={Zap}
        title="Campaigns"
        subtitle="Reach out before someone asks."
        action={
          <Button
            onClick={() =>
              setEditing({
                is_active: false,
                priority: 10,
                events: { type: 'time_on_page', seconds: 30 },
                actions: { type: 'message', message: '' },
                behaviors: { once_per_session: true },
                platforms: { desktop: true, mobile: true },
              })
            }
          >
            New campaign
          </Button>
        }
      />

      {limit && (
        <p role="alert" className="text-sm text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
          Your plan includes {limit.limit} campaign{limit.limit === 1 ? '' : 's'}.
        </p>
      )}
      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}

      {list.data &&
        (list.data.items.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No campaigns"
            hint="A good first one: offer help after thirty seconds on the pricing page."
          />
        ) : (
          <div className="space-y-2">
            {list.data.items.map((item) => (
              <Card key={item.id} className="p-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 text-sm">{item.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{describe(item)}</p>
                  <div className="flex gap-1.5 mt-2">
                    <Badge tone={item.is_active ? 'green' : 'gray'}>
                      {item.is_active ? 'live' : 'paused'}
                    </Badge>
                    {item.fire_count > 0 && (
                      <Badge>
                        shown {item.fire_count}× · {item.conversation_count} chats
                      </Badge>
                    )}
                  </div>
                </div>
                <Toggle
                  checked={item.is_active}
                  onChange={(v) => save.mutate({ id: item.id, is_active: v })}
                />
                <IconButton label="Edit" onClick={() => setEditing(item)}>
                  <Pencil className="w-4 h-4" aria-hidden />
                </IconButton>
                <IconButton
                  label="Delete"
                  onClick={() => {
                    if (confirm(`Delete “${item.name}”?`)) remove.mutate(item.id);
                  }}
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </IconButton>
              </Card>
            ))}
          </div>
        ))}

      {editing && (
        <CampaignDialog
          value={editing}
          websites={websites.data?.websites ?? []}
          saving={save.isPending}
          error={save.error}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => save.mutate(editing)}
        />
      )}
    </Page>
  );
}

function CampaignDialog({
  value,
  websites,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  value: Partial<Trigger>;
  websites: { id: string; name: string }[];
  saving: boolean;
  error: unknown;
  onChange: (next: Partial<Trigger>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const events = (value.events ?? {}) as Record<string, unknown>;
  const actions = (value.actions ?? {}) as Record<string, unknown>;
  const behaviors = (value.behaviors ?? {}) as Record<string, unknown>;

  const setEvents = (patch: Record<string, unknown>) =>
    onChange({ ...value, events: { ...events, ...patch } });

  return (
    <Modal
      title={value.id ? 'Edit campaign' : 'New campaign'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={saving} onClick={onSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {(error as Error).message}
          </p>
        ) : null}

        <Field label="Name" hint="Only your team sees this." required>
          {(a) => (
            <TextInput
              {...a}
              value={value.name ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  name: e.target.value,
                  identifier: value.id ? value.identifier : slugify(e.target.value),
                })
              }
              placeholder="Help on the pricing page"
            />
          )}
        </Field>

        <Field label="When">
          {(a) => (
            <Select
              {...a}
              value={String(events.type ?? 'time_on_page')}
              onChange={(e) => setEvents({ type: e.target.value })}
            >
              <option value="time_on_page">After a while on a page</option>
              <option value="scroll_depth">After scrolling down</option>
              <option value="exit_intent">When they look like they are leaving</option>
              <option value="page_view">As soon as a page loads</option>
            </Select>
          )}
        </Field>

        {events.type === 'time_on_page' && (
          <Field label="After how many seconds?">
            {(a) => (
              <TextInput
                {...a}
                type="number"
                min={1}
                max={600}
                value={Number(events.seconds ?? 30)}
                onChange={(e) => setEvents({ seconds: Number(e.target.value) })}
              />
            )}
          </Field>
        )}
        {events.type === 'scroll_depth' && (
          <Field label="How far down? (percent)">
            {(a) => (
              <TextInput
                {...a}
                type="number"
                min={1}
                max={100}
                value={Number(events.percent ?? 50)}
                onChange={(e) => setEvents({ percent: Number(e.target.value) })}
              />
            )}
          </Field>
        )}

        <Field label="Only on pages matching" hint="Leave blank for every page. * works as a wildcard.">
          {(a) => (
            <TextInput
              {...a}
              value={String(events.url_pattern ?? '')}
              onChange={(e) => setEvents({ url_pattern: e.target.value })}
              placeholder="/pricing*"
            />
          )}
        </Field>

        <Field label="What we say">
          {(a) => (
            <TextArea
              {...a}
              rows={3}
              value={String(actions.message ?? '')}
              onChange={(e) =>
                onChange({ ...value, actions: { ...actions, type: 'message', message: e.target.value } })
              }
              placeholder="Comparing plans? Happy to help you pick."
            />
          )}
        </Field>

        <Toggle
          checked={Boolean(behaviors.once_per_session ?? true)}
          onChange={(v) => onChange({ ...value, behaviors: { ...behaviors, once_per_session: v } })}
          label="Only once per visit"
          description="Off, and the same person sees it on every page they open."
        />

        <WebsiteScope
          websites={websites}
          value={value.website_id ? [value.website_id] : []}
          onChange={(ids) => onChange({ ...value, website_id: ids[0] ?? null })}
        />
      </div>
    </Modal>
  );
}

function describe(trigger: Trigger): string {
  const events = trigger.events as { type?: string; seconds?: number; percent?: number; url_pattern?: string };
  const where = events.url_pattern ? ` on ${events.url_pattern}` : '';
  switch (events.type) {
    case 'time_on_page':
      return `After ${events.seconds ?? 30}s${where}`;
    case 'scroll_depth':
      return `After scrolling ${events.percent ?? 50}%${where}`;
    case 'exit_intent':
      return `On exit intent${where}`;
    default:
      return `On page view${where}`;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}
