import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Monitor, ShieldCheck, StickyNote, Tag as TagIcon } from 'lucide-react';
import { addNote, assign, setTags, visitorIps, visitorPerson } from '../../../lib/api/inbox';
import { listMembers } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import { Select, TextInput } from '../../../ui/Form';
import { relative } from './ConversationList';
import { HANDLED_HINTS, toFacts, visitorContext, type Fact } from './visitorFacts';
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

  const attributes = toFacts(conversation.custom_attributes);
  // The well-known hints get the block below; only what is left over falls through
  // to a generic list, which is usually nothing.
  const context = visitorContext(conversation.metadata);
  const otherHints = toFacts(conversation.metadata, HANDLED_HINTS);
  const location = ips.data?.ips[0];
  const place = [location?.city, location?.country].filter(Boolean).join(', ');
  const earlier = (person.data?.person?.conversations ?? []).filter((c) => c.id !== conversation.id);

  return (
    <aside className="w-72 shrink-0 border-l border-gray-200/70 bg-cream overflow-y-auto hidden xl:block">
      <div className="p-4 space-y-5">
        {/*
          A person, not a row.

          The panel used to open on a bare name over a raw timestamp. An initial and
          a mail link cost nothing and make the top of this column answer "who am I
          talking to" at a glance, which is the only question it is here for.
        */}
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 shrink-0 rounded-full bg-blue-100 text-blue-800 font-display text-lg flex items-center justify-center">
            {(conversation.visitor_name || conversation.visitor_email || '?').charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-gray-800 truncate">
              {conversation.visitor_name || conversation.visitor_email || 'Visitor'}
            </p>
            {conversation.visitor_email && (
              <a
                href={`mailto:${conversation.visitor_email}`}
                className="block text-xs text-blue-700 hover:underline truncate"
              >
                {conversation.visitor_email}
              </a>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              {conversation.message_count} message{conversation.message_count === 1 ? '' : 's'} ·
              first seen {relative(conversation.created_at)} ago
              {place ? ` · ${place}` : ''}
            </p>
          </div>
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
          <Block title="Verified details" icon={ShieldCheck}>
            <p className="text-[10px] text-gray-400 mb-1.5">
              Signed by your own server, so these can be trusted.
            </p>
            <FactList facts={attributes} strong />
          </Block>
        )}

        {/*
          What the page can see, arranged by what an agent asks.

          Which page they are on, where they came from, what they are using, and what
          language they read — four questions, not eight key-value pairs. The two that
          matter most are links, because "which page" is usually followed by wanting
          to look at it.
        */}
        {(context.page || context.referrer || context.device || context.locale) && (
          <Block title="Right now" icon={Monitor}>
            <p className="text-[10px] text-gray-400 mb-1.5">
              Reported by their browser. Not verified.
            </p>
            <div className="space-y-1.5 text-xs">
              {context.page && <LinkedLine label="On" fact={context.page} />}
              {context.referrer && <LinkedLine label="Came from" fact={context.referrer} />}
              {context.device && <p className="text-gray-600">{context.device}</p>}
              {context.locale && <p className="text-gray-600">{context.locale}</p>}
              {context.ip && (
                <p className="text-gray-400">
                  {context.ip}
                  {place ? ` · ${place}` : ''}
                </p>
              )}
            </div>
          </Block>
        )}

        {otherHints.length > 0 && (
          <Block title="Also sent by the page">
            <FactList facts={otherHints} />
          </Block>
        )}

        {/*
          "Also seen" used to say that a match had been made — a fact about our
          database rather than about the customer. What an agent actually wants is
          the thing they said last time, so this is a list of links.
        */}
        {earlier.length > 0 && (
          <Block title="Earlier conversations" icon={History}>
            <ul className="space-y-1">
              {earlier.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/w/${workspace.slug}/inbox/${c.id}`}
                    className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-gray-100"
                  >
                    <span className="text-xs text-gray-700 flex-1 truncate">
                      {c.message_count} message{c.message_count === 1 ? '' : 's'}
                    </span>
                    <span className="text-[10px] text-gray-400 shrink-0">
                      {relative(String(c.updated_at))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {earlier.length > 5 && (
              <p className="text-[10px] text-gray-400 mt-1">
                and {earlier.length - 5} more
              </p>
            )}
          </Block>
        )}

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

/**
 * A labelled row whose value is worth clicking.
 *
 * The label is above the value rather than beside it. In a 288px column a
 * side-by-side pair gives the value about 150px, which is why every URL in this
 * panel used to end in an ellipsis before it reached the part that differs.
 */
function LinkedLine({ label, fact }: { label: string; fact: Fact }) {
  return (
    <p className="min-w-0">
      <span className="text-gray-400">{label} </span>
      {fact.href ? (
        <a
          href={fact.href}
          target="_blank"
          rel="noreferrer noopener"
          title={fact.title}
          className="text-blue-700 hover:underline break-all"
        >
          {fact.value}
        </a>
      ) : (
        <span className="text-gray-700 break-all" title={fact.title}>
          {fact.value}
        </span>
      )}
    </p>
  );
}

/** Longer than this and a value gets the full width instead of half. */
const WIDE_VALUE = 16;

/**
 * Facts in two columns, with long ones spanning both.
 *
 * Stacked in one column, nine signed attributes are eighteen lines, which pushes
 * "Right now" — the block an agent reads on every conversation — off the bottom of
 * the panel. Most values are a word ("business", "owner", "active"), so half the
 * width is plenty; an email or a URL takes the whole row rather than wrapping into
 * a narrow ribbon.
 */
function FactList({ facts, strong }: { facts: Fact[]; strong?: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
      {facts.map((fact) => (
        <div
          key={fact.key}
          className={`min-w-0 ${fact.value.length > WIDE_VALUE ? 'col-span-2' : ''}`}
        >
          <dt className="text-[10px] uppercase tracking-wide text-gray-400">{fact.label}</dt>
          <dd
            className={`text-xs break-words ${strong ? 'text-gray-800 font-medium' : 'text-gray-600'}`}
            title={fact.title}
          >
            {fact.href ? (
              <a
                href={fact.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-700 hover:underline"
              >
                {fact.value}
              </a>
            ) : (
              fact.value
            )}
          </dd>
        </div>
      ))}
    </dl>
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
