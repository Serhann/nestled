import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Pencil, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { createKb, deleteKb, listKb, updateKb } from '../../../lib/api/inbox';
import { listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, TextArea, TextInput } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { Badge } from '../../../ui/Badge';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope, scopeLabel } from '../../../ui/WebsiteScope';
import type { KbEntry } from '../../../lib/api/types';

/**
 * The knowledge base.
 *
 * This is what the AI answers from, so the editor says so plainly. A customer who
 * thinks of it as a help-centre article writes prose; one who knows the model
 * reads it writes an answer, and the difference shows up immediately in reply
 * quality.
 */
export default function KnowledgeBase() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<KbEntry> | null>(null);

  const entries = useQuery({ queryKey: qk.kb(workspace.id), queryFn: () => listKb(workspace.id) });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.kb(workspace.id) });

  const save = useMutation({
    mutationFn: (entry: Partial<KbEntry>) =>
      entry.id ? updateKb(workspace.id, entry.id, entry) : createKb(workspace.id, entry),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteKb(workspace.id, id),
    onSuccess: invalidate,
  });

  if (!can('kb:read')) return <NoAccess what="the knowledge base" />;
  const writable = can('kb:write');
  const sites = websites.data?.websites ?? [];

  return (
    <Page>
      <PageHeader
        icon={BookOpen}
        title="Knowledge base"
        subtitle="What your AI answers from. Short, specific answers beat long articles."
        action={
          writable && (
            <Button onClick={() => setEditing({ category: 'general', keywords: [], is_active: true })}>
              Add an answer
            </Button>
          )
        }
      />

      {entries.isLoading && <Spinner />}
      {entries.error && <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />}

      {entries.data &&
        (entries.data.items.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No answers yet"
            hint="Start with the five questions you answer most. That covers more chats than you would expect."
          />
        ) : (
          <div className="space-y-2">
            {entries.data.items.map((entry) => (
              <Card key={entry.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800">{entry.question}</p>
                    <p className="text-sm text-gray-600 mt-1 line-clamp-2">{entry.answer}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <Badge>{entry.category}</Badge>
                      {!entry.is_active && <Badge tone="gray">off</Badge>}
                      <span className="text-[11px] text-gray-400">
                        {scopeLabel(sites, entry.website_id ? [entry.website_id] : [])}
                      </span>
                    </div>
                  </div>
                  {writable && (
                    <div className="flex gap-1 shrink-0">
                      <IconButton label="Edit" onClick={() => setEditing(entry)}>
                        <Pencil className="w-4 h-4" aria-hidden />
                      </IconButton>
                      <IconButton
                        label="Delete"
                        onClick={() => {
                          if (confirm(`Delete “${entry.question}”?`)) remove.mutate(entry.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </IconButton>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ))}

      {editing && (
        <Modal
          title={editing.id ? 'Edit answer' : 'New answer'}
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
            <Field label="Question" required>
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.question ?? ''}
                  onChange={(e) => setEditing({ ...editing, question: e.target.value })}
                  placeholder="How do I get a refund?"
                />
              )}
            </Field>
            <Field label="Answer" hint="Write it the way you would say it in chat." required>
              {(a) => (
                <TextArea
                  {...a}
                  rows={5}
                  value={editing.answer ?? ''}
                  onChange={(e) => setEditing({ ...editing, answer: e.target.value })}
                />
              )}
            </Field>
            <Field label="Category">
              {(a) => (
                <TextInput
                  {...a}
                  value={editing.category ?? 'general'}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Also match these words"
              hint="Comma separated. Helps when people phrase it differently."
            >
              {(a) => (
                <TextInput
                  {...a}
                  value={(editing.keywords ?? []).join(', ')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      keywords: e.target.value
                        .split(',')
                        .map((k) => k.trim())
                        .filter(Boolean),
                    })
                  }
                />
              )}
            </Field>
            <WebsiteScope
              websites={sites}
              value={editing.website_id ? [editing.website_id] : []}
              onChange={(ids) => setEditing({ ...editing, website_id: ids[0] ?? null })}
            />
          </div>
        </Modal>
      )}
    </Page>
  );
}
