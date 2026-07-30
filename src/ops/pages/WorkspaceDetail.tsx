import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime, money, shortDate } from '../api';
import { useSession } from '../session';
import { DeleteAction } from './DeleteAction';
import type {
  AuditEntry,
  ImpersonationSession,
  WorkspaceConversation,
  WorkspaceMember,
  WorkspaceOverview,
  WorkspacePlanTab,
  WorkspaceUsageTab,
  WorkspaceWebsite,
} from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Meter,
  Modal,
  Spinner,
  Stat,
  Table,
  Td,
  inputClass,
} from '../ui';
import { statusTone } from '../tone';
import { ImpersonateDialog } from './ImpersonateDialog';

/**
 * One customer, eight tabs.
 *
 * Each tab is its own request, fired only when the tab is opened. A support agent
 * usually wants the overview and nothing else, and on the vendor plane an
 * unnecessary read of customer data is not merely slow — it is a thing that shows
 * up in an audit for no reason.
 *
 * The tab lives in the URL so a link pasted into a ticket lands where the sender
 * meant, which is most of why anyone shares a link from here.
 */

const TABS = [
  'overview',
  'plan',
  'usage',
  'websites',
  'members',
  'conversations',
  'activity',
  'notes',
] as const;
type Tab = (typeof TABS)[number];

export function WorkspaceDetail() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [impersonating, setImpersonating] = useState(false);
  const tab = (TABS.find((t) => t === params.get('tab')) ?? 'overview') as Tab;

  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', id],
    queryFn: () => api<WorkspaceOverview>(`/platform/workspaces/${id}`),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  const ws = data.workspace;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{ws.name}</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            /w/{ws.slug} · {ws.plan.name} ·{' '}
            <Badge tone={ws.deleted_at ? 'fail' : statusTone(ws.subscription_status)}>
              {ws.deleted_at ? 'deleted' : ws.subscription_status.replace('_', ' ')}
            </Badge>
          </p>
        </div>
        <Button variant="primary" onClick={() => setImpersonating(true)}>
          Impersonate…
        </Button>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-gray-700 pb-1">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setParams({ tab: t }, { replace: true })}
            className={`whitespace-nowrap rounded-t-lg px-3 py-1.5 text-sm capitalize transition ${
              tab === t ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'plan' && <PlanTab workspaceId={id} />}
      {tab === 'usage' && <UsageTab workspaceId={id} />}
      {tab === 'websites' && <WebsitesTab workspaceId={id} />}
      {tab === 'members' && <MembersTab workspaceId={id} />}
      {tab === 'conversations' && <ConversationsTab workspaceId={id} />}
      {tab === 'activity' && <ActivityTab workspaceId={id} />}
      {tab === 'notes' && <NotesTab workspaceId={id} />}

      {impersonating && (
        <ImpersonateDialog workspaceId={id} workspaceName={ws.name} onClose={() => setImpersonating(false)} />
      )}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: WorkspaceOverview }) {
  const ws = data.workspace;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Members" value={ws._count.members} />
        <Stat label="Websites" value={`${data.signals.installed_websites} / ${ws._count.websites} installed`} />
        <Stat label="Conversations" value={ws._count.conversations} />
        <Stat label="Last chat" value={shortDate(data.signals.last_conversation_at)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Who to talk to">
          {data.owners.length === 0 ? (
            <Empty>No active owner. This workspace cannot be impersonated as an owner.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.owners.map((owner) => (
                <li key={owner.id} className="flex justify-between gap-3">
                  <span>
                    <span className="text-gray-100">{owner.name}</span>
                    <span className="block text-xs text-gray-500">{owner.email}</span>
                  </span>
                  <span className="text-xs text-gray-500">last in {shortDate(owner.last_login_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Lifecycle">
          <dl className="space-y-2 text-sm">
            <Row label="Created" value={shortDate(ws.created_at)} />
            <Row label="Trial ends" value={shortDate(ws.trial_ends_at)} />
            <Row label="Grace until" value={shortDate(ws.grace_until)} />
            <Row
              label="Purge scheduled"
              value={ws.purge_after ? <span className="text-red-300">{shortDate(ws.purge_after)}</span> : '—'}
            />
            <Row label="Stripe customer" value={ws.stripe_customer_id ?? '—'} />
            <Row label="Timezone" value={ws.timezone} />
          </dl>
        </Card>
      </div>

      <LifecyclePanel workspaceId={ws.id} workspaceName={ws.name} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right text-gray-200">{value}</dd>
    </div>
  );
}

/**
 * The levers. Every one takes a reason, and the form will not submit without it —
 * enforced on the server too, so this is a courtesy rather than the control.
 */
function LifecyclePanel({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [action, setAction] = useState('extend_trial');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(14);

  const mutation = useMutation({
    mutationFn: () =>
      api(`/platform/workspaces/${workspaceId}/lifecycle`, {
        method: 'POST',
        body: { action, reason: reason.trim(), ...(action === 'set_status' ? {} : { days }) },
      }),
    onSuccess: () => {
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
    },
  });

  const needsDays = action === 'extend_trial' || action === 'grant_grace';

  return (
    <Card
      title="Support actions"
      action={
        /*
          Deliberately on the same card as the reversible levers rather than in a
          separate "danger zone": the levers people reach for by mistake are the ones
          that look harmless, and the dialog behind this button is what does the work of
          slowing somebody down — it names what goes, asks why, and requires the
          workspace name typed out.
        */
        <DeleteAction
          type="workspace"
          id={workspaceId}
          label={workspaceName}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })}
        />
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Action">
          <select className={`${inputClass} max-w-[14rem]`} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="extend_trial">Extend trial</option>
            <option value="grant_grace">Grant grace period</option>
            <option value="cancel_purge">Cancel scheduled purge</option>
            <option value="restore">Restore deleted workspace</option>
          </select>
        </Field>
        {needsDays && (
          <Field label="Days">
            <input
              type="number"
              min={1}
              max={90}
              className={`${inputClass} w-24`}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="Reason">
          <input
            className={`${inputClass} min-w-[20rem]`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why — goes into the customer's audit log"
          />
        </Field>
        <Button
          variant="primary"
          onClick={() => mutation.mutate()}
          disabled={reason.trim().length < 3 || mutation.isPending || !session?.user.can_write}
          title={session?.user.can_write ? undefined : 'Enroll an authenticator first'}
        >
          {mutation.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </div>
      {mutation.error && (
        <div className="mt-3">
          <ErrorBox error={mutation.error} />
        </div>
      )}
    </Card>
  );
}

// ── Plan ─────────────────────────────────────────────────────────────────────

const OVERRIDE_FIELDS = [
  ['max_seats', 'Seats'],
  ['max_websites', 'Websites'],
  ['max_conversations_month', 'Conversations / month'],
  ['max_ai_replies_month', 'AI replies / month'],
  ['max_kb_entries', 'KB entries'],
  ['max_bot_flows', 'Bot flows'],
  ['max_triggers', 'Triggers'],
  ['storage_mb', 'Storage (MB)'],
  ['retention_days', 'Retention (days)'],
] as const;

function PlanTab({ workspaceId }: { workspaceId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'plan'],
    queryFn: () => api<WorkspacePlanTab>(`/platform/workspaces/${workspaceId}/plan`),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  return (
    <div className="space-y-4">
      <Card
        title={
          <span>
            {data.plan.name}{' '}
            {data.is_override && <Badge tone="warn">custom — this workspace only</Badge>}{' '}
            {/* Not decoration: while this says manual, Stripe webhooks do not touch this
                workspace's plan or status and the trial/dunning sweeps skip it. Anyone
                wondering why a past_due customer never advanced needs to see it here. */}
            {data.billing_mode === 'manual' && <Badge tone="warn">billed by hand — Stripe ignored</Badge>}
          </span>
        }
        action={
          <div className="flex gap-2">
            <Button onClick={() => setAssigning(true)} disabled={!session?.user.can_write}>
              Set plan by hand
            </Button>
            <Button onClick={() => setEditing(true)} disabled={!session?.user.can_write}>
              {data.is_override ? 'Adjust override' : 'Grant exception'}
            </Button>
            {data.is_override && (
              <Button
                variant="danger"
                disabled={!session?.user.can_write}
                onClick={() => {
                  const code = window.prompt('Move this workspace back to which catalog plan? (code)');
                  const why = code ? window.prompt('Reason?') : null;
                  if (!code || !why) return;
                  void api(`/platform/workspaces/${workspaceId}/plan-override`, {
                    method: 'DELETE',
                    body: { plan_code: code, reason: why },
                  }).then(() => queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] }));
                }}
              >
                Remove override
              </Button>
            )}
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {OVERRIDE_FIELDS.map(([key, label]) => (
            <Stat key={key} label={label} value={(data.plan[key] || 'unlimited').toLocaleString()} />
          ))}
          <Stat label="Remove branding" value={data.plan.allow_remove_branding ? 'yes' : 'no'} />
          <Stat label="Live view" value={data.plan.allow_live_view ? 'yes' : 'no'} />
          <Stat label="Bot" value={data.plan.allow_bot ? 'yes' : 'no'} />
        </div>
      </Card>

      <Card title="Invoices">
        {data.invoices.length === 0 ? (
          <Empty>No invoices. Either they have never paid, or Stripe is not configured.</Empty>
        ) : (
          <Table head={['Number', 'Status', 'Due', 'Paid', 'Date', '']}>
            {data.invoices.map((inv) => (
              <tr key={inv.id}>
                <Td>{inv.number ?? inv.id.slice(0, 8)}</Td>
                <Td>
                  <Badge tone={inv.status === 'paid' ? 'ok' : inv.status === 'open' ? 'warn' : 'neutral'}>
                    {inv.status}
                  </Badge>
                </Td>
                <Td>{money(inv.amount_due, inv.currency)}</Td>
                <Td>{money(inv.amount_paid, inv.currency)}</Td>
                <Td className="text-gray-400">{shortDate(inv.created_at)}</Td>
                <Td>
                  {inv.hosted_invoice_url && (
                    <a className="text-blue-300 hover:underline" href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {assigning && (
        <AssignPlanDialog
          workspaceId={workspaceId}
          current={data}
          onClose={() => setAssigning(false)}
          onSaved={() => {
            setAssigning(false);
            void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
          }}
        />
      )}

      {editing && (
        <OverrideDialog
          workspaceId={workspaceId}
          current={data}
          onClose={() => {
            setEditing(false);
            void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Granting an exception.
 *
 * Every field starts at the customer's CURRENT value, because an override is
 * almost always "the same plan but with X changed", and a form that starts empty
 * invites someone to submit a plan that silently removes everything they already
 * had. The server clones for the same reason.
 */
/**
 * Assigning a plan without Stripe.
 *
 * The plan picker is the small half of this dialog. The important control is the billing
 * mode, because a plan set on a workspace Stripe still owns lasts exactly until the next
 * `customer.subscription.updated` — and nobody watching the panel would ever connect the
 * two events. `manual` is what makes it stick: while it is set the webhook mirrors
 * nothing here, the trial and dunning sweeps skip this workspace, and the customer's own
 * billing page stops offering checkout.
 *
 * Two things it deliberately does NOT do. It does not cancel a live Stripe subscription —
 * so if one exists, the card is still being charged and the dialog says so, because
 * "their plan is sorted" and "they have stopped paying twice" are different facts. And
 * handing a workspace back to Stripe reconciles nothing: the next webhook wins.
 */
function AssignPlanDialog({
  workspaceId,
  current,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  current: WorkspacePlanTab;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [planId, setPlanId] = useState(current.plan.id);
  // Defaults to manual whichever way it is set today: someone opening this dialog is
  // almost always taking a customer OFF self-service, and handing one back is the rare
  // direction that deserves an explicit choice.
  const [mode, setMode] = useState<'manual' | 'stripe'>('manual');
  const [status, setStatus] = useState('active');
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api<{ stripe_subscription: { id: string; status: string } | null }>(
        `/platform/workspaces/${workspaceId}/plan`,
        {
          method: 'POST',
          body: { plan_id: planId, billing_mode: mode, status, reason: reason.trim() },
        },
      ),
    onSuccess: onSaved,
  });

  return (
    <Modal title="Set this plan by hand" onClose={onClose}>
      {current.subscription && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          This workspace has a live Stripe subscription. Switching to manual makes us ignore it — it
          does NOT cancel it, so cancel it in Stripe as well or they keep being charged.
        </p>
      )}

      {save.error && (
        <div className="mt-3">
          <ErrorBox error={save.error} />
        </div>
      )}

      <div className="mt-3 space-y-3">
        <Field label="Plan">
          <select className={inputClass} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {current.catalog.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
                {plan.is_public ? '' : ' (private)'}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Billing"
          hint="Manual = we invoice them (transfer, purchase order, partner deal). Stripe = hand it back; the next webhook wins."
        >
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as 'manual' | 'stripe')}>
            <option value="manual">Manual — we bill them another way</option>
            <option value="stripe">Stripe — self-service again</option>
          </select>
        </Field>

        <Field
          label="Subscription status"
          hint="Usually active. A workspace left on trialing is expired by the sweep the moment it goes back to Stripe."
        >
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">active</option>
            <option value="trialing">trialing</option>
            <option value="past_due">past_due</option>
            <option value="unpaid">unpaid</option>
            <option value="canceled">canceled</option>
            <option value="suspended">suspended</option>
          </select>
        </Field>

        <Field label="Reason" hint="Goes into the customer's audit log.">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Paying yearly by bank transfer — invoice INV-2031."
          />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={save.isPending || reason.trim().length < 3}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Apply'}
        </Button>
      </div>
    </Modal>
  );
}

function OverrideDialog({
  workspaceId,
  current,
  onClose,
}: {
  workspaceId: string;
  current: WorkspacePlanTab;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(OVERRIDE_FIELDS.map(([key]) => [key, current.plan[key]])),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Only send what actually changed, so the audit entry names the real diff
      // rather than every field on the plan.
      const changed = Object.fromEntries(
        Object.entries(values).filter(([key, value]) => value !== current.plan[key as keyof typeof current.plan]),
      );
      await api(`/platform/workspaces/${workspaceId}/plan-override`, {
        method: 'PUT',
        body: { reason: reason.trim(), ...changed },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the override');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Per-workspace exception" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          This creates a private plan visible only to this workspace. It does not appear in pricing or the upgrade
          flow, and every limit check in the product reads it immediately.
        </p>
        <div className="grid max-h-64 gap-3 overflow-y-auto sm:grid-cols-2">
          {OVERRIDE_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min={0}
                className={inputClass}
                value={values[key]}
                onChange={(e) => setValues((v) => ({ ...v, [key]: Number(e.target.value) }))}
              />
            </Field>
          ))}
        </div>
        <Field label="Reason" hint="Recorded against the customer. Name the agreement, not the ticket.">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || reason.trim().length < 3}>
            {busy ? 'Saving…' : 'Save exception'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Usage ────────────────────────────────────────────────────────────────────

function UsageTab({ workspaceId }: { workspaceId: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'usage'],
    queryFn: () => api<WorkspaceUsageTab>(`/platform/workspaces/${workspaceId}/usage`),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  const metered: [string, number, number][] = [
    ['Conversations', data.current.conversations ?? 0, data.limits.conversations ?? 0],
    ['AI replies', data.current.ai_replies ?? 0, data.limits.ai_replies ?? 0],
    ['Seats', data.levels.seats, data.limits.seats ?? 0],
    ['Websites', data.levels.websites, data.limits.websites ?? 0],
    ['Storage (MB)', Math.round((data.current.storage_bytes ?? 0) / 1_048_576), data.limits.storage_mb ?? 0],
  ];

  return (
    <div className="space-y-4">
      <Card title="This billing period">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {metered.map(([label, used, limit]) => (
            <div key={label}>
              <div className="mb-1 text-sm text-gray-300">{label}</div>
              <Meter used={used} limit={limit} />
            </div>
          ))}
        </div>
      </Card>

      <Card title="AI cost this period">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Calls" value={data.ai_this_period.calls.toLocaleString()} />
          <Stat label="Input tokens" value={data.ai_this_period.input_tokens.toLocaleString()} />
          <Stat label="Output tokens" value={data.ai_this_period.output_tokens.toLocaleString()} />
          {/* The number that decides whether this customer is worth their plan. */}
          <Stat label="Cost" value={money(Math.round(data.ai_this_period.cost_micros / 10_000), 'usd')} />
        </div>
      </Card>
    </div>
  );
}

// ── Websites ─────────────────────────────────────────────────────────────────

function WebsitesTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'websites'],
    queryFn: () => api<{ websites: WorkspaceWebsite[] }>(`/platform/workspaces/${workspaceId}/websites`),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;
  if (data.websites.length === 0) return <Empty>No websites. Onboarding never got past step one.</Empty>;

  return (
    <div className="space-y-4">
      {data.websites.map((site) => (
        <Card
          key={site.id}
          title={site.name}
          action={
            <span className="flex items-center gap-2">
              {site.deleted_at && <Badge tone="fail">deleted</Badge>}
              <Badge tone={site.installed_at ? 'ok' : 'warn'}>
                {site.installed_at ? 'installed' : 'never installed'}
              </Badge>
              <Badge tone={site.is_active ? 'ok' : 'neutral'}>{site.is_active ? 'active' : 'inactive'}</Badge>
              {/* Nothing to delete twice: a soft-deleted website is already gone from
                  the customer's side, and a second event over the same rows would make
                  the first one's undo list wrong. */}
              {!site.deleted_at && (
                <DeleteAction
                  type="website"
                  id={site.id}
                  label={site.name}
                  compact
                  onDone={() => void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })}
                />
              )}
            </span>
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Public key" value={<code className="text-xs">{site.public_key}</code>} />
            <Stat label="Primary domain" value={site.primary_domain ?? '—'} />
            <Stat label="Conversations" value={site._count.conversations} />
            <Stat label="Signing secret" value={site.has_identity_secret ? 'configured' : 'none'} />
          </div>

          {site.domains.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Hosts seen loading the widget</h3>
              <Table head={['Host', 'Loads', 'Authorized', 'Last seen']}>
                {site.domains.map((d) => (
                  <tr key={d.host}>
                    <Td>{d.host}</Td>
                    <Td>{d.hits.toLocaleString()}</Td>
                    <Td>
                      {/* An unauthorized host with real traffic is the most useful
                          support signal on this page — it means the widget is live
                          somewhere the customer never listed. */}
                      <Badge tone={d.authorized ? 'ok' : 'warn'}>{d.authorized ? 'yes' : 'no'}</Badge>
                    </Td>
                    <Td className="text-gray-400">{dateTime(d.last_seen)}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

function MembersTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'members'],
    queryFn: () =>
      api<{ members: WorkspaceMember[]; pending_invites: { id: string; email: string; role: string; expires_at: string }[] }>(
        `/platform/workspaces/${workspaceId}/members`,
      ),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  return (
    <div className="space-y-4">
      <Card title="Members">
        <Table head={['Name', 'Email', 'Role', 'Status', 'Verified', 'Scope', 'Last seen', '']}>
          {data.members.map((m) => (
            <tr key={m.id}>
              <Td>
                {m.user.name}
                {m.is_online && <span className="ml-2 text-xs text-green-300">online</span>}
              </Td>
              <Td className="text-gray-400">{m.user.email}</Td>
              <Td>{m.role}</Td>
              <Td>
                <Badge tone={m.status === 'active' ? 'ok' : 'warn'}>{m.status}</Badge>
              </Td>
              <Td>
                {m.user.email_verified_at ? (
                  'yes'
                ) : (
                  <ConfirmEmailButton
                    userId={m.user.id}
                    email={m.user.email}
                    onDone={() => void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })}
                  />
                )}
              </Td>
              <Td>{m.all_websites ? 'all websites' : 'restricted'}</Td>
              <Td className="text-gray-400">{dateTime(m.last_seen)}</Td>
              <Td>
                {(
                  <DeleteAction
                    type="user"
                    id={m.user.id}
                    label={m.user.email}
                    compact
                    onDone={() => void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })}
                  />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {data.pending_invites.length > 0 && (
        <Card title="Pending invites">
          <Table head={['Email', 'Role', 'Expires']}>
            {data.pending_invites.map((i) => (
              <tr key={i.id}>
                <Td>{i.email}</Td>
                <Td>{i.role}</Td>
                <Td className="text-gray-400">{shortDate(i.expires_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

/**
 * Confirming an address by hand.
 *
 * The button only exists on an unverified member, and it is the answer to a loop the
 * customer cannot leave on their own: unverified blocks invitations, leaving it needs a
 * link in an email, and the email is exactly what is not arriving. The reason is
 * required because this bypasses an identity check — a recorded bypass is a support
 * action, an unrecorded one is a hole.
 */
function ConfirmEmailButton({
  userId,
  email,
  onDone,
}: {
  userId: string;
  email: string;
  onDone: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const confirm = useMutation({
    mutationFn: () =>
      api(`/platform/users/${userId}/confirm-email`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  return (
    <>
      <button onClick={() => setOpen(true)} className="text-xs text-amber-300 underline hover:text-amber-200">
        no — confirm it
      </button>
      {open && (
        <Modal title="Confirm this address" onClose={() => setOpen(false)}>
          <p className="text-sm text-gray-200">{email}</p>
          <p className="mt-2 text-xs text-gray-500">
            Marks the address confirmed without them clicking a link, and spends any outstanding
            verification link. Recorded in their workspace&rsquo;s audit log.
          </p>
          {confirm.error && (
            <div className="mt-3">
              <ErrorBox error={confirm.error} />
            </div>
          )}
          <div className="mt-3">
            <Field label="Reason" hint="Visible to the customer.">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={inputClass}
                placeholder="Their mail provider is rejecting our verification mail — ticket 5120."
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={confirm.isPending || reason.trim().length < 3 || !session?.user.can_write}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? 'Confirming…' : 'Confirm'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Conversations ───────────────────────────────────────────────

function ConversationsTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const query = status ? `?status=${status}` : '';

  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'conversations', status],
    queryFn: () =>
      api<{ conversations: WorkspaceConversation[]; total: number }>(
        `/platform/workspaces/${workspaceId}/conversations${query}`,
      ),
  });

  return (
    <Card
      title="Conversations"
      action={
        <select className={`${inputClass} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
        </select>
      }
    >
      <p className="mb-3 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 text-xs text-gray-400">
        Metadata only. Reading what was said requires impersonation with a recorded reason — the transcript is the
        customer's, and staff reaching it silently is the thing this panel deliberately cannot do.
      </p>

      {error && <ErrorBox error={error} />}
      {isPending && <Spinner />}
      {data && data.conversations.length === 0 && <Empty>No conversations.</Empty>}

      {data && data.conversations.length > 0 && (
        <Table head={['Visitor', 'Website', 'Status', 'Messages', 'Rating', 'Started', 'Updated', '']}>
          {data.conversations.map((c) => (
            <tr key={c.id}>
              <Td>
                {c.visitor_name ?? 'Anonymous'}
                {c.visitor_email && <span className="block text-xs text-gray-500">{c.visitor_email}</span>}
              </Td>
              <Td className="text-gray-400">{c.website?.name ?? '—'}</Td>
              <Td>
                <Badge tone={c.status === 'resolved' ? 'ok' : c.status === 'pending' ? 'warn' : 'accent'}>
                  {c.status}
                </Badge>
              </Td>
              <Td>{c.message_count}</Td>
              <Td>{c.rating_stars ? `${c.rating_stars}/5` : '—'}</Td>
              <Td className="text-gray-400">{shortDate(c.created_at)}</Td>
              <Td className="text-gray-400">{dateTime(c.updated_at)}</Td>
              <Td>
                <DeleteAction
                  type="conversation"
                  id={c.id}
                  label={c.visitor_name ?? c.visitor_email ?? 'this conversation'}
                  compact
                  onDone={() =>
                    void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'conversations'] })
                  }
                />
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

function ActivityTab({ workspaceId }: { workspaceId: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'activity'],
    queryFn: () =>
      api<{ entries: AuditEntry[]; impersonations: ImpersonationSession[] }>(
        `/platform/workspaces/${workspaceId}/activity`,
      ),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  return (
    <div className="space-y-4">
      <Card title="Staff sessions inside this account">
        {data.impersonations.length === 0 ? (
          <Empty>Nobody from our side has ever been in here.</Empty>
        ) : (
          <Table head={['Who', 'Reason', 'Scope', 'Started', 'Ended']}>
            {data.impersonations.map((s) => (
              <tr key={s.id}>
                <Td>{s.platform_user.email}</Td>
                <Td className="max-w-md text-gray-300">{s.reason}</Td>
                <Td>
                  <Badge tone={s.scope === 'full' ? 'warn' : 'neutral'}>{s.scope.replace('_', ' ')}</Badge>
                </Td>
                <Td className="text-gray-400">{dateTime(s.created_at)}</Td>
                <Td className="text-gray-400">{s.ended_at ? dateTime(s.ended_at) : 'expired or live'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Audit log">
        {data.entries.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <Table head={['When', 'Actor', 'Action', 'Target']}>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-gray-400">{dateTime(e.created_at)}</Td>
                <Td>
                  {e.actor_email ?? e.actor_type}
                  {e.actor_type === 'platform_user' && <Badge tone="warn">staff</Badge>}
                </Td>
                <Td className="font-mono text-xs">{e.action}</Td>
                <Td className="text-gray-400">{e.target_type ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ── Notes ────────────────────────────────────────────────────────────────────

function NotesTab({ workspaceId }: { workspaceId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const { data, error, isPending } = useQuery({
    queryKey: ['workspace', workspaceId, 'notes'],
    queryFn: () =>
      api<{ notes: { id: string; actor_email: string | null; details: { body?: string }; created_at: string }[] }>(
        `/platform/workspaces/${workspaceId}/notes`,
      ),
  });

  const add = useMutation({
    mutationFn: () =>
      api(`/platform/workspaces/${workspaceId}/notes`, { method: 'POST', body: { body: body.trim() } }),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'notes'] });
    },
  });

  return (
    <Card title="Staff notes">
      <p className="mb-3 text-xs text-gray-500">
        Notes are audit entries: attributable, timestamped and permanent. There is no edit and no delete, which is the
        point — this is the record of what we said about a customer.
      </p>

      <div className="mb-4 flex gap-2">
        <textarea
          className={`${inputClass} h-20`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What should the next person to open this account know?"
        />
        <Button
          variant="primary"
          onClick={() => add.mutate()}
          disabled={body.trim().length === 0 || add.isPending || !session?.user.can_write}
        >
          Add
        </Button>
      </div>

      {add.error && <ErrorBox error={add.error} />}
      {error && <ErrorBox error={error} />}
      {isPending && <Spinner />}
      {data && data.notes.length === 0 && <Empty>No notes yet.</Empty>}

      <ul className="space-y-3">
        {data?.notes.map((note) => (
          <li key={note.id} className="rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2">
            <div className="text-xs text-gray-500">
              {note.actor_email ?? 'staff'} · {dateTime(note.created_at)}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-200">{note.details.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
