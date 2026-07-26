import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money } from '../api';
import { useSession } from '../session';
import type { Plan } from '../types';
import { Badge, Button, Card, ErrorBox, Field, Modal, Spinner, Table, Td, inputClass } from '../ui';

/**
 * The plan catalog.
 *
 * The editable fields are limits and entitlements, not Stripe price ids — those are
 * set per environment and getting one wrong charges a real customer the wrong
 * amount. They are shown, read-only, so a mismatch is visible without being
 * casually editable from a support screen.
 */

const NUMERIC: [keyof Plan, string][] = [
  ['max_seats', 'Seats'],
  ['max_websites', 'Websites'],
  ['max_conversations_month', 'Conversations'],
  ['max_ai_replies_month', 'AI replies'],
  ['max_kb_entries', 'KB entries'],
  ['max_bot_flows', 'Bot flows'],
  ['max_triggers', 'Triggers'],
  ['storage_mb', 'Storage MB'],
  ['retention_days', 'Retention days'],
];

const FLAGS: [keyof Plan, string][] = [
  ['allow_remove_branding', 'Remove branding'],
  ['allow_live_view', 'Live view'],
  ['allow_bot', 'Bot'],
];

export function Plans() {
  const [editing, setEditing] = useState<Plan | null>(null);
  const { data, error, isPending } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api<{ plans: Plan[] }>('/platform/plans'),
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  const catalog = data.plans.filter((p) => p.is_public);
  const overrides = data.plans.filter((p) => !p.is_public);

  return (
    <div className="space-y-4">
      <Card title="Catalog">
        <PlanTable plans={catalog} onEdit={setEditing} />
      </Card>

      {overrides.length > 0 && (
        <Card title="Per-workspace exceptions">
          <p className="mb-3 text-xs text-gray-500">
            Private plans, each granted to one workspace. They never appear in pricing or the upgrade flow. Edit them
            from that workspace's plan tab so the change is recorded against the customer.
          </p>
          <PlanTable plans={overrides} onEdit={setEditing} />
        </Card>
      )}

      {editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanTable({ plans, onEdit }: { plans: Plan[]; onEdit: (plan: Plan) => void }) {
  const session = useSession();
  return (
    <Table head={['Plan', 'Price / mo', 'Seats', 'Sites', 'Chats', 'AI', 'Features', 'Workspaces', '']}>
      {plans.map((plan) => (
        <tr key={plan.id}>
          <Td>
            <span className="font-medium text-gray-100">{plan.name}</span>
            <span className="block text-xs text-gray-500">
              {plan.code}
              {plan.is_trial_default && ' · trial default'}
            </span>
          </Td>
          <Td>{money(plan.price_monthly_cents, 'usd')}</Td>
          <Td>{plan.max_seats}</Td>
          <Td>{plan.max_websites}</Td>
          <Td>{plan.max_conversations_month.toLocaleString()}</Td>
          <Td>{plan.max_ai_replies_month.toLocaleString()}</Td>
          <Td>
            <span className="flex flex-wrap gap-1">
              {FLAGS.filter(([key]) => plan[key]).map(([key, label]) => (
                <Badge key={key} tone="ok">
                  {label}
                </Badge>
              ))}
            </span>
          </Td>
          <Td>{plan._count?.workspaces ?? 0}</Td>
          <Td>
            <Button onClick={() => onEdit(plan)} disabled={!session?.user.can_write}>
              Edit
            </Button>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function PlanEditor({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Plan>(plan);
  const [affected, setAffected] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: draft.name, is_trial_default: draft.is_trial_default };
      for (const [key] of NUMERIC) body[key] = Number(draft[key]);
      for (const [key] of FLAGS) body[key] = Boolean(draft[key]);
      return api<{ workspaces_affected: number }>(`/platform/plans/${plan.id}`, { method: 'PATCH', body });
    },
    onSuccess: (result) => {
      setAffected(result.workspaces_affected);
      void queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  return (
    <Modal title={`Edit ${plan.name}`} onClose={onClose}>
      <div className="space-y-4">
        {/* Editing a catalog plan changes the limits of every customer on it at
            once. That is easy to forget from a form, so the count is stated before
            and after. */}
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {plan._count?.workspaces ?? 0} workspace(s) are on this plan. Saving changes their limits immediately.
        </p>

        <Field label="Name">
          <input className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>

        <div className="grid max-h-56 gap-3 overflow-y-auto sm:grid-cols-2">
          {NUMERIC.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min={0}
                className={inputClass}
                value={Number(draft[key])}
                onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          {FLAGS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-gray-300">
              <input
                type="checkbox"
                checked={Boolean(draft[key])}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={draft.is_trial_default}
              onChange={(e) => setDraft({ ...draft, is_trial_default: e.target.checked })}
            />
            Trial default
          </label>
        </div>

        <div className="rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 text-xs text-gray-500">
          Stripe: product {plan.id.slice(0, 8)} · prices are set per environment and are not editable here, because a
          wrong price id charges a real customer the wrong amount.
        </div>

        {save.error && <ErrorBox error={save.error} />}
        {affected !== null && (
          <p className="text-sm text-green-300">Saved. {affected} workspace(s) updated.</p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
