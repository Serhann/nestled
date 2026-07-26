import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, Pencil, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { createCanned, deleteCanned, listCanned, updateCanned } from '../../../lib/api/inbox';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, TextArea, TextInput } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope } from '../../../ui/WebsiteScope';
import type { CannedResponse } from '../../../lib/api/types';

/** Saved replies, reached from the composer by typing `/shortcut`. */
export default function Canned() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<CannedResponse> | null>(null);

  const items = useQuery({ queryKey: qk.canned(workspace.id), queryFn: () => listCanned(workspace.id) });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.canned(workspace.id) });

  const save = useMutation({
    mutationFn: (entry: Partial<CannedResponse>) =>
      entry.id ? updateCanned(workspace.id, entry.id, entry) : createCanned(workspace.id, entry),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCanned(workspace.id, id),
    onSuccess: invalidate,
  });

  if (!can('canned:read')) return <NoAccess what="canned replies" />;
  const writable = can('canned:write');

  return (
    <Page>
      <PageHeader
        icon={MessageSquareText}
        title="Canned replies"
        subtitle="Type / in the composer to insert one."
        action={writable && <Button onClick={() => setEditing({})}>New reply</Button>}
      />

      {items.isLoading && <Spinner />}
      {items.error && <ErrorState error={items.error} onRetry={() => void items.refetch()} />}

      {items.data &&
        (items.data.items.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title="No saved replies"
            hint="The greeting you type twenty times a day is a good first one."
          />
        ) : (
          <div className="space-y-2">
            {items.data.items.map((item) => (
              <Card key={item.id} className="p-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-blue-700">/{item.shortcut}</p>
                  <p className="font-semibold text-gray-800 text-sm mt-0.5">{item.title}</p>
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.content}</p>
                </div>
                {writable && (
                  <div className="flex gap-1 shrink-0">
                    <IconButton label="Edit" onClick={() => setEditing(item)}>
                      <Pencil className="w-4 h-4" aria-hidden />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      onClick={() => {
                        if (confirm(`Delete /${item.shortcut}?`)) remove.mutate(item.id);
                      }}
                    >
                      <Trash2 className="w-4 h-4" aria-hidden />
                    </IconButton>
                  </div>
                )}
              </Card>
            ))}
          </div>
        ))}

      {editing && (
        <Modal
          title={editing.id ? 'Edit reply' : 'New reply'}
          onClose={() => setEditing(null)}
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
            <Field label="Shortcut" hint="Lowercase letters, numbers and dashes." required>
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.shortcut ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                  }
                  placeholder="hello"
                />
              )}
            </Field>
            <Field label="Title" required>
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.title ?? ''}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  placeholder="Greeting"
                />
              )}
            </Field>
            <Field label="Message" required>
              {(a) => (
                <TextArea
                  {...a}
                  rows={4}
                  value={editing.content ?? ''}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })}
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
