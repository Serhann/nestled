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
  type TriggerEvents,
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
 * The event that fires a campaign is evaluated in the visitor's browser, because the
 * useful signals — time on page, leaving the tab — only exist there. What it *does* is
 * decided here.
 *
 * ── Every field on this screen is a field the browser engine actually reads ──────
 *
 * It has to be, and it was not. This screen used to invent its own vocabulary
 * (`events.type: 'time_on_page'`, `actions: { type, message }`,
 * `behaviors.once_per_session`, `platforms: { desktop, mobile }`) against a server schema
 * that rejects unknown keys — so Save returned a 400 listing all four columns and no
 * campaign could ever be created. The names below are the ones in
 * `utils/triggerEngine.ts` and `server/src/routes/v1/automation.ts`.
 *
 * The lesson worth keeping: a control whose value nothing reads is worse than a missing
 * control, because it reads as a configured campaign that simply never fires. Two of the
 * old options were exactly that even before the 400 — a "scroll depth" event the engine
 * has no scroll listener for, and a "once per visit" toggle for behaviour the engine
 * already applies unconditionally (`markExecuted`, persisted in localStorage). Neither is
 * offered here. Anything the engine supports but this screen does not expose — click
 * selectors, URL parameters, country restriction, localized messages — is absent rather
 * than faked.
 */

/** The event kinds this screen offers, each mapping to real `events` flags. */
type When = 'delay' | 'leave_intent' | 'page_view';

function whenOf(events: TriggerEvents): When {
  if (events.after_delay) return 'delay';
  if (events.on_leave_intent) return 'leave_intent';
  return 'page_view';
}

/**
 * Set the event flags for one kind, clearing the others.
 *
 * Exclusive because the select is: leaving both `after_delay` and `on_leave_intent` set
 * would arm two listeners for one campaign and whichever fired first would win, which is
 * not something a dropdown can express.
 */
function withWhen(events: TriggerEvents, when: When): TriggerEvents {
  return {
    ...events,
    after_delay: when === 'delay',
    delay_seconds: when === 'delay' ? (events.delay_seconds ?? 30) : 0,
    on_leave_intent: when === 'leave_intent',
  };
}

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
                events: { after_delay: true, delay_seconds: 30 },
                // `open_chatbox` defaults OFF now that the message shows as a teaser above
                // the closed launcher (Teaser.tsx). It defaulted ON only because the nudge
                // was drawn INSIDE the panel and nothing else surfaced it, so a campaign
                // that did not open the panel was invisible — which made the intrusive
                // option the only working one. With the teaser, the visitor reads the
                // message in place and opening the chat stays their decision.
                actions: { show_message: true, message_content: '', open_chatbox: false },
                behaviors: {},
                platforms: { desktop_enabled: true, mobile_enabled: true },
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
  const events = value.events ?? {};
  const actions = value.actions ?? {};
  const behaviors = value.behaviors ?? {};

  const setEvents = (next: TriggerEvents) => onChange({ ...value, events: next });
  const when = whenOf(events);

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
              value={when}
              onChange={(e) => setEvents(withWhen(events, e.target.value as When))}
            >
              <option value="delay">After a while on a page</option>
              <option value="leave_intent">When they look like they are leaving</option>
              <option value="page_view">As soon as a page loads</option>
            </Select>
          )}
        </Field>

        {when === 'delay' && (
          <Field label="After how many seconds?">
            {(a) => (
              <TextInput
                {...a}
                type="number"
                min={1}
                max={3600}
                value={events.delay_seconds ?? 30}
                onChange={(e) => setEvents({ ...events, delay_seconds: Number(e.target.value) })}
              />
            )}
          </Field>
        )}

        <Field
          label="Only on pages matching"
          hint="Leave blank for every page. * works as a wildcard."
        >
          {(a) => (
            <TextInput
              {...a}
              value={events.page_urls?.[0] ?? ''}
              onChange={(e) => {
                // `on_pages` is the flag the engine tests before it looks at the list, so
                // an empty box has to clear BOTH. Leaving the flag on with no patterns
                // would read as "restricted to nothing".
                const pattern = e.target.value;
                setEvents({
                  ...events,
                  on_pages: pattern.trim().length > 0,
                  page_urls: pattern.trim().length > 0 ? [pattern] : [],
                });
              }}
              placeholder="/pricing*"
            />
          )}
        </Field>

        <Field label="What we say">
          {(a) => (
            <TextArea
              {...a}
              rows={3}
              value={actions.message_content ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  actions: { ...actions, show_message: true, message_content: e.target.value },
                })
              }
              placeholder="Comparing plans? Happy to help you pick."
            />
          )}
        </Field>

        <Toggle
          checked={actions.open_chatbox ?? false}
          onChange={(v) => onChange({ ...value, actions: { ...actions, open_chatbox: v } })}
          label="Open the chat when it fires"
          description="Off, the message shows as a bubble above the launcher and the visitor decides whether to open the chat. On, the panel opens by itself."
        />

        <Toggle
          checked={behaviors.execute_if_online ?? false}
          onChange={(v) => onChange({ ...value, behaviors: { ...behaviors, execute_if_online: v } })}
          label="Only when someone is available"
          description="Skip it if no agent is online, so nobody is invited into an empty room."
        />

        <Toggle
          checked={behaviors.execute_on_first_visit ?? false}
          onChange={(v) =>
            onChange({ ...value, behaviors: { ...behaviors, execute_on_first_visit: v } })
          }
          label="Only on a first visit"
          description="Every campaign already shows at most once per visitor; this narrows it to brand-new ones."
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
  const events = trigger.events ?? {};
  const pages = events.on_pages ? events.page_urls ?? [] : [];
  const where = pages.length > 0 ? ` on ${pages.join(', ')}` : '';
  switch (whenOf(events)) {
    case 'delay':
      return `After ${events.delay_seconds ?? 30}s${where}`;
    case 'leave_intent':
      return `On exit intent${where}`;
    default:
      return `On page view${where}`;
  }
}

/**
 * Name → identifier.
 *
 * DASHES, not underscores. The server's identifier is `/^[a-z0-9-]+$/`, so the old
 * underscore separator made "Help on pricing" fail validation on its own — one of the five
 * errors a Save produced, and the only one that would still have failed after the four
 * column shapes were right.
 *
 * Accents are FOLDED rather than stripped, because stripping them is only invisible in
 * English. "Fiyat sayfasında yardım" became `fiyat-sayfas-nda-yard-m` — a valid identifier
 * and a nonsense one, printed nowhere the author could notice. NFD + combining-mark strip
 * covers ü/ö/ç/ş/é; `ı` carries no mark and is mapped by hand.
 *
 * The fallback matters too: a name of "!!!" folds away to nothing, and an empty identifier
 * is a 400 pointing at a field this screen does not even show.
 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'campaign';
}
