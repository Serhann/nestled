import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Sparkles, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { createStarter, deleteStarter, listStarters, updateStarter } from '../../../lib/api/inbox';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, Select, TextArea, TextInput } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { Badge } from '../../../ui/Badge';
import { Toggle } from '../../../ui/Toggle';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope } from '../../../ui/WebsiteScope';
import { FormBuilder } from '../websites/FormBuilder';
import type { PreChatField, Starter } from '../../../lib/api/types';

/**
 * Conversation starters: the buttons a visitor sees before typing anything.
 *
 * `kind` decides what happens on tap — `auto` lets the AI answer, `human` skips
 * straight to a person, `bot` runs a flow. Making that explicit is what stops the
 * common failure where someone in a hurry picks "I have a billing problem" and
 * gets a chatbot.
 */
export default function Starters() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<Starter> | null>(null);

  const items = useQuery({
    queryKey: qk.starters(workspace.id),
    queryFn: () => listStarters(workspace.id),
  });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.starters(workspace.id) });

  const save = useMutation({
    mutationFn: (entry: Partial<Starter>) =>
      entry.id ? updateStarter(workspace.id, entry.id, entry) : createStarter(workspace.id, entry),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteStarter(workspace.id, id),
    onSuccess: invalidate,
  });

  if (!can('starter:write')) return <NoAccess what="conversation starters" />;

  return (
    <Page>
      <PageHeader
        icon={Sparkles}
        title="Conversation starters"
        subtitle="The buttons visitors see before they type."
        action={
          <Button onClick={() => setEditing({ kind: 'auto', fields: [], priority: 10, is_active: true })}>
            New starter
          </Button>
        }
      />

      {items.isLoading && <Spinner />}
      {items.error && <ErrorState error={items.error} onRetry={() => void items.refetch()} />}

      {items.data &&
        (items.data.items.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No starters"
            hint="Two or three cover most reasons people open a chat."
          />
        ) : (
          <div className="space-y-2">
            {items.data.items.map((item) => (
              <Card key={item.id} className="p-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 text-sm">{item.label}</p>
                  {item.message && <p className="text-sm text-gray-600 mt-0.5">{item.message}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge tone={item.kind === 'human' ? 'blue' : item.kind === 'bot' ? 'green' : 'gray'}>
                      {item.kind === 'human' ? 'goes to a person' : item.kind === 'bot' ? 'runs a bot' : 'AI answers'}
                    </Badge>
                    {item.fields.length > 0 && <Badge>{item.fields.length} question(s) first</Badge>}
                    {!item.is_active && <Badge tone="gray">off</Badge>}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <IconButton label="Edit" onClick={() => setEditing(item)}>
                    <Pencil className="w-4 h-4" aria-hidden />
                  </IconButton>
                  <IconButton
                    label="Delete"
                    onClick={() => {
                      if (confirm(`Delete “${item.label}”?`)) remove.mutate(item.id);
                    }}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </IconButton>
                </div>
              </Card>
            ))}
          </div>
        ))}

      {editing && (
        <Modal
          title={editing.id ? 'Edit starter' : 'New starter'}
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
            {save.error && (
              <p role="alert" className="text-sm text-red-600">
                {(save.error as Error).message}
              </p>
            )}
            <Field label="Button label" required>
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.label ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      label: e.target.value,
                      key: editing.id ? editing.key : slugify(e.target.value),
                    })
                  }
                  placeholder="I have a billing question"
                />
              )}
            </Field>
            <Field label="What happens next">
              {(a) => (
                <Select
                  {...a}
                  value={editing.kind ?? 'auto'}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value as Starter['kind'] })}
                >
                  <option value="auto">The AI answers first</option>
                  <option value="human">Go straight to a person</option>
                  <option value="bot">Run a bot flow</option>
                </Select>
              )}
            </Field>
            <Field label="Opening message" hint="Sent as the visitor’s first message. Optional.">
              {(a) => (
                <TextArea
                  {...a}
                  rows={2}
                  value={editing.message ?? ''}
                  onChange={(e) => setEditing({ ...editing, message: e.target.value })}
                />
              )}
            </Field>

            <div>
              <p className="text-sm font-semibold text-gray-700 mb-1.5">Ask for details first</p>
              <FormBuilder
                fields={(editing.fields ?? []).map(toPreChatField)}
                onChange={(fields) =>
                  setEditing({
                    ...editing,
                    fields: fields.map((f) => ({ name: f.name, label: f.label, required: f.required })),
                  })
                }
              />
            </div>

            <Toggle
              checked={editing.is_active ?? true}
              onChange={(v) => setEditing({ ...editing, is_active: v })}
              label="Show this starter"
            />

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

/** Starters store a narrower field shape than pre-chat forms; widen for the builder. */
function toPreChatField(f: { name: string; label: string; required: boolean }): PreChatField {
  return { ...f, type: 'text', placeholder: '' };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
