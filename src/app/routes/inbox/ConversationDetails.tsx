import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, MapPin, Monitor, StickyNote, Tag as TagIcon } from 'lucide-react';
import { addNote, assign, setTags, visitorIps, visitorPerson } from '../../../lib/api/inbox';
import { listMembers } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import { Select, TextInput } from '../../../ui/Form';
import { relative } from './ConversationList';
import type { ConversationDetail } from '../../../lib/api/types';

/**
 * The right-hand panel: who this is, where they are, and what the team knows.
 *
 * `custom_attributes` and `metadata` are shown separately and labelled, because
 * they are not equally trustworthy: attributes are HMAC-signed by the customer's
 * own server, metadata is whatever the browser sent. An agent making a decision
 * about someone's account needs to know which is which.
 */
export function ConversationDetails({ conversation }: { conversation: ConversationDetail }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  const members = useQuery({
    queryKey: qk.members(workspace.id),
    queryFn: () => listMembers(workspace.id),
    enabled: can('member:read'),
    staleTime: 5 * 60_000,
  });

  const person = useQuery({
    queryKey: qk.visitorPerson(workspace.id, conversation.visitor_id),
    queryFn: () => visitorPerson(workspace.id, conversation.visitor_id),
    enabled: can('visitor:read'),
  });

  const ips = useQuery({
    queryKey: qk.visitorIps(workspace.id, conversation.visitor_id),
    queryFn: () => visitorIps(workspace.id, conversation.visitor_id),
    enabled: can('visitor:read'),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: qk.conversation(workspace.id, conversation.id) });

  const assignTo = useMutation({
    mutationFn: (memberId: string | null) => assign(workspace.id, conversation.id, memberId),
    onSuccess: invalidate,
  });

  const saveTags = useMutation({
    mutationFn: (tags: string[]) => setTags(workspace.id, conversation.id, tags),
    onSuccess: invalidate,
  });

  const saveNote = useMutation({
    mutationFn: () => addNote(workspace.id, conversation.id, note),
    onSuccess: async () => {
      setNote('');
      await invalidate();
    },
  });

  const attributes = Object.entries(conversation.custom_attributes ?? {});
  const hints = Object.entries(conversation.metadata ?? {}).filter(
    ([key]) => !key.startsWith('_'),
  );
  const location = ips.data?.ips[0];

  return (
    <aside className="w-72 shrink-0 border-l border-gray-200/70 bg-cream overflow-y-auto hidden xl:block">
      <div className="p-4 space-y-5">
        <div>
          <p className="font-semibold text-gray-800">
            {conversation.visitor_name || conversation.visitor_email || 'Visitor'}
          </p>
          {conversation.visitor_email && (
            <p className="text-xs text-gray-500 truncate">{conversation.visitor_email}</p>
          )}
          <p className="text-[11px] text-gray-400 mt-1">
            First seen {relative(conversation.created_at)} ago · {conversation.message_count} messages
          </p>
        </div>

        {can('conversation:assign') && (
          <Block title="Assigned to">
            <Select
              value={conversation.assigned_member_id ?? ''}
              onChange={(e) => assignTo.mutate(e.target.value || null)}
            >
              <option value="">Nobody</option>
              {(members.data?.members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.user.name}
                  {m.is_online ? ' (online)' : ''}
                </option>
              ))}
            </Select>
          </Block>
        )}

        <Block title="Tags" icon={TagIcon}>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {conversation.tags.map((tag) => (
              <button
                key={tag}
                onClick={() => saveTags.mutate(conversation.tags.filter((t) => t !== tag))}
                className="group"
                aria-label={`Remove tag ${tag}`}
              >
                <Badge tone="violet">
                  {tag}
                  <span className="opacity-40 group-hover:opacity-100">✕</span>
                </Badge>
              </button>
            ))}
          </div>
          <TextInput
            value={tagDraft}
            placeholder="Add a tag…"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !tagDraft.trim()) return;
              saveTags.mutate([...conversation.tags, tagDraft.trim()]);
              setTagDraft('');
            }}
          />
        </Block>

        {attributes.length > 0 && (
          <Block title="Verified details">
            <p className="text-[10px] text-gray-400 mb-1.5">
              Signed by your own server, so these can be trusted.
            </p>
            <dl className="space-y-1">
              {attributes.map(([key, value]) => (
                <div key={key} className="flex gap-2 text-xs">
                  <dt className="text-gray-500 shrink-0">{key}</dt>
                  <dd className="text-gray-800 truncate">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Block>
        )}

        {hints.length > 0 && (
          <Block title="Browser hints" icon={Monitor}>
            <p className="text-[10px] text-gray-400 mb-1.5">Sent by the page. Unverified.</p>
            <dl className="space-y-1">
              {hints.slice(0, 8).map(([key, value]) => (
                <div key={key} className="flex gap-2 text-xs">
                  <dt className="text-gray-500 shrink-0">{key}</dt>
                  <dd className="text-gray-600 truncate">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Block>
        )}

        {location && (
          <Block title="Location" icon={MapPin}>
            <p className="text-xs text-gray-600">
              {[location.city, location.country].filter(Boolean).join(', ') || 'Unknown'}
            </p>
          </Block>
        )}

        {person.data?.person ? (
          <Block title="Also seen" icon={Globe}>
            <p className="text-xs text-gray-600">
              This visitor has been matched to a known person in this workspace.
            </p>
          </Block>
        ) : null}

        {can('note:write') && (
          <Block title="Internal notes" icon={StickyNote}>
            <div className="space-y-2 mb-2">
              {conversation.notes.map((n) => (
                <div key={n.id} className="rounded-xl bg-amber-50 px-3 py-2">
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{n.content}</p>
                  <p className="text-[10px] text-gray-400 mt-1">
                    {n.author_name} · {relative(n.created_at)}
                  </p>
                </div>
              ))}
            </div>
            <TextInput
              value={note}
              placeholder="Only your team sees this"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && note.trim()) saveNote.mutate();
              }}
            />
            {note.trim() && (
              <Button size="sm" className="mt-2" busy={saveNote.isPending} onClick={() => saveNote.mutate()}>
                Add note
              </Button>
            )}
          </Block>
        )}
      </div>
    </aside>
  );
}

function Block({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof TagIcon;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">
        {Icon && <Icon className="w-3 h-3" aria-hidden />}
        {title}
      </h3>
      {children}
    </section>
  );
}
