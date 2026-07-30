import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, ExternalLink } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { changePlan, getBilling, listPlans, openPortal, startCheckout, type DowngradeBlock } from '../../../lib/api/billing';
import { qk } from '../../../lib/queryKeys';
import { ApiError } from '../../../lib/http';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Badge } from '../../../ui/Badge';
import { Modal } from '../../../ui/Modal';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { SettingsLayout } from './SettingsLayout';

export default function Billing() {
  const { workspace, can } = useWorkspace();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [blocked, setBlocked] = useState<{ code: string; problems: DowngradeBlock[] } | null>(null);

  const billing = useQuery({
    queryKey: qk.billing(workspace.id),
    queryFn: () => getBilling(workspace.id),
    enabled: can('billing:read'),
  });
  const plans = useQuery({ queryKey: qk.plans(), queryFn: () => listPlans() });

  const checkout = useMutation({
    mutationFn: (code: string) => startCheckout(workspace.id, { plan_code: code, interval }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const portal = useMutation({
    mutationFn: () => openPortal(workspace.id),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const change = useMutation({
    mutationFn: (input: { code: string; confirm?: boolean }) =>
      changePlan(workspace.id, { plan_code: input.code, interval, confirm: input.confirm }),
    onSuccess: (result, input) => {
      if ('blocked' in result) setBlocked({ code: input.code, problems: result.blocked });
      else window.location.reload();
    },
  });

  if (!can('billing:read')) return <NoAccess what="billing" />;

  const state = billing.data;
  const currentCode = state?.plan.code ?? workspace.plan.code;
  const manageDisabled = !can('billing:manage');
  /**
   * Whether this customer can change their own plan.
   *
   * False when there is no payment provider connected, and false when we bill them
   * directly — those are different reasons for the same UI, and the second one matters
   * more: a Subscribe button in front of somebody paying us by bank transfer charges
   * them twice. The API refuses both cases too (409 `billing_manual`); this is what
   * stops the button existing in the first place.
   */
  const selfServe = Boolean(state?.stripe.configured) && state?.billing_mode !== 'manual';

  return (
    <SettingsLayout
      title="Plan & billing"
      subtitle={state?.subscription ? `${state.plan.name}, billed ${state.subscription.interval}ly` : workspace.plan.name}
      action={
        selfServe &&
        state?.subscription &&
        !manageDisabled && (
          <Button variant="ghost" busy={portal.isPending} onClick={() => portal.mutate()}>
            <ExternalLink className="w-4 h-4" aria-hidden />
            Card & invoices
          </Button>
        )
      }
    >
      {billing.isLoading && <Spinner />}
      {billing.error && <ErrorState error={billing.error} onRetry={() => void billing.refetch()} />}

      {state && !selfServe && (
        /*
          No card on file because there is no payment provider connected — which from
          the customer's side is simply "we bill you directly". The earlier wording
          ("this deployment has no payment provider connected, so plans and limits are
          set directly in the database") described our architecture to someone who
          wanted to know whether their plan was fine.
        */
        <Section title="We look after your plan">
          <p className="text-sm text-gray-600">
            Your plan and limits are managed for you, so there’s no card to set up here. Get
            in touch if you want to change plans or need an invoice.
          </p>
        </Section>
      )}

      {state?.subscription && (
        <Section title="Current subscription">
          <dl className="grid gap-3 sm:grid-cols-3 text-sm">
            <div>
              <dt className="text-xs text-gray-500">Status</dt>
              <dd className="mt-0.5">
                <Badge tone={state.subscription.status === 'active' ? 'green' : 'amber'}>
                  {state.subscription.status}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Seats</dt>
              <dd className="mt-0.5 text-gray-800">
                {state.seats.used} of {state.seats.included}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">
                {state.subscription.cancel_at_period_end ? 'Ends' : 'Renews'}
              </dt>
              <dd className="mt-0.5 text-gray-800">
                {state.subscription.current_period_end
                  ? new Date(state.subscription.current_period_end).toLocaleDateString()
                  : '—'}
              </dd>
            </div>
          </dl>
        </Section>
      )}

      <Section
        title="Plans"
        action={
          <div className="flex rounded-full bg-gray-100 p-0.5 text-xs font-semibold">
            <button
              onClick={() => setInterval('month')}
              className={`rounded-full px-3 py-1 ${interval === 'month' ? 'bg-white shadow-sm' : 'text-gray-500'}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setInterval('year')}
              className={`rounded-full px-3 py-1 ${interval === 'year' ? 'bg-white shadow-sm' : 'text-gray-500'}`}
            >
              Yearly
            </button>
          </div>
        }
      >
        {plans.isLoading && <Spinner />}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(plans.data?.plans ?? []).map((plan) => {
            const current = plan.code === currentCode;
            const price = interval === 'year' ? plan.price_yearly_cents : plan.price_monthly_cents;
            return (
              <div
                key={plan.code}
                className={`rounded-3xl border p-5 ${
                  current ? 'border-blue-500 bg-blue-50/40' : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold text-gray-800">{plan.name}</p>
                  {current && <Badge tone="blue">current</Badge>}
                </div>
                <p className="mt-2">
                  <span className="font-display text-3xl text-gray-800">
                    {price === 0 ? 'Free' : `$${(price / 100).toFixed(0)}`}
                  </span>
                  {price > 0 && (
                    <span className="text-xs text-gray-500"> /{interval === 'year' ? 'yr' : 'mo'}</span>
                  )}
                </p>
                <ul className="mt-4 space-y-1.5 text-xs text-gray-600">
                  <Line>{plan.limits.seats} seat{plan.limits.seats === 1 ? '' : 's'}</Line>
                  <Line>{plan.limits.websites} website{plan.limits.websites === 1 ? '' : 's'}</Line>
                  <Line>{plan.limits.conversations_month.toLocaleString()} conversations a month</Line>
                  <Line>{plan.limits.ai_replies_month.toLocaleString()} AI replies a month</Line>
                  {plan.features.bot && <Line>Bot flows</Line>}
                  {plan.features.live_view && <Line>Live view</Line>}
                  {plan.features.remove_branding && <Line>No Nestled branding</Line>}
                </ul>
                {!current && !manageDisabled && selfServe && (
                  <Button
                    className="w-full mt-4"
                    variant={price === 0 ? 'ghost' : 'primary'}
                    busy={checkout.isPending || change.isPending}
                    onClick={() =>
                      state?.subscription ? change.mutate({ code: plan.code }) : checkout.mutate(plan.code)
                    }
                  >
                    {state?.subscription ? 'Switch to this plan' : 'Choose'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {checkout.error instanceof ApiError && (
          <p role="alert" className="text-sm text-red-600 mt-3">
            {checkout.error.message}
          </p>
        )}
      </Section>

      {state && state.invoices.length > 0 && (
        <Section title="Invoices">
          <ul className="divide-y divide-gray-100 text-sm">
            {state.invoices.map((invoice) => (
              <li key={invoice.id} className="flex items-center gap-3 py-2.5">
                <span className="text-gray-500 text-xs w-24 shrink-0">
                  {new Date(invoice.created_at).toLocaleDateString()}
                </span>
                <span className="flex-1 text-gray-800">{invoice.number ?? invoice.id}</span>
                <Badge tone={invoice.status === 'paid' ? 'green' : 'amber'}>{invoice.status}</Badge>
                <span className="text-gray-700 w-20 text-right">
                  {(invoice.amount_due / 100).toFixed(2)} {invoice.currency.toUpperCase()}
                </span>
                {invoice.hosted_invoice_url && (
                  <a
                    href={invoice.hosted_invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-700 hover:underline text-xs font-semibold"
                  >
                    View
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {blocked && (
        <Modal
          title="That plan is smaller than what you are using"
          onClose={() => setBlocked(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setBlocked(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                busy={change.isPending}
                onClick={() => {
                  change.mutate({ code: blocked.code, confirm: true });
                  setBlocked(null);
                }}
              >
                Switch anyway
              </Button>
            </>
          }
        >
          <div className="space-y-3 pb-2 text-sm text-gray-600">
            <p>
              Nothing is deleted. What does not fit is switched off, newest first, and you can turn
              any of it back on by choosing what to keep.
            </p>
            <ul className="space-y-1">
              {blocked.problems.map((problem) => (
                <li key={problem.metric} className="text-gray-800">
                  <strong>{problem.metric.replace(/_/g, ' ')}</strong>: {problem.used} in use, the new
                  plan allows {problem.limit}
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </SettingsLayout>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-px" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
