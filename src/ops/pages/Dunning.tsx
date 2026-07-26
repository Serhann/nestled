import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, money, relativeDays, shortDate } from '../api';
import type { DunningResponse, DunningRow } from '../types';
import { Badge, Card, Empty, ErrorBox, Spinner, Table, Td } from '../ui';

/**
 * The dunning worklist — a queue, not a dashboard.
 *
 * Ordering comes from the server, and it is the whole feature: money at stake,
 * amplified by how overdue it is and by whether the outcome is reversible. Sorting
 * on the client would let this page disagree with any future alert built on the
 * same endpoint.
 */

const BUCKETS: { key: DunningRow['bucket']; label: string; blurb: string }[] = [
  { key: 'pending_purge', label: 'Pending purge', blurb: 'Data deletion scheduled. Irreversible after the date.' },
  { key: 'payment_failed', label: 'Payment failed', blurb: 'Stripe could not charge them. They usually do not know.' },
  { key: 'grace', label: 'In grace', blurb: 'Failed, but still serving. There is a deadline.' },
  { key: 'trial_ending', label: 'Trial ending', blurb: 'The window to intervene is now.' },
  { key: 'trial_expired', label: 'Trial expired', blurb: 'Dropped to free. The most recoverable segment here.' },
];

const BUCKET_TONE: Record<DunningRow['bucket'], 'fail' | 'warn' | 'accent'> = {
  pending_purge: 'fail',
  payment_failed: 'fail',
  grace: 'warn',
  trial_ending: 'accent',
  trial_expired: 'warn',
};

export function Dunning() {
  const [bucket, setBucket] = useState<string>('');
  const { data, error, isPending } = useQuery({
    queryKey: ['dunning', bucket],
    queryFn: () => api<DunningResponse>(`/platform/dunning${bucket ? `?bucket=${bucket}` : ''}`),
    // Money-at-risk goes stale quickly and this page is left open on a second
    // monitor, so it refreshes itself rather than showing yesterday's queue.
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <Card
        title="At risk"
        action={
          data && (
            <span className="text-sm text-gray-300">{money(data.total_at_risk_cents, 'usd')} outstanding</span>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {BUCKETS.map((b) => {
            const total = data?.totals[b.key];
            const active = bucket === b.key;
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(active ? '' : b.key)}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  active ? 'border-blue-500 bg-blue-600/10' : 'border-gray-700 bg-gray-900/40 hover:border-gray-600'
                }`}
              >
                <div className="text-xs uppercase tracking-wide text-gray-500">{b.label}</div>
                <div className="mt-1 text-lg font-semibold text-gray-100">{total?.count ?? 0}</div>
                <div className="text-xs text-gray-500">{money(total?.amount_due_cents ?? 0, 'usd')}</div>
                <p className="mt-1 text-[11px] leading-snug text-gray-600">{b.blurb}</p>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title={bucket ? `Worklist — ${bucket.replace('_', ' ')}` : 'Worklist'}>
        {error && <ErrorBox error={error} />}
        {isPending && <Spinner />}
        {data && data.rows.length === 0 && <Empty>Nothing needs chasing. Enjoy it.</Empty>}

        {data && data.rows.length > 0 && (
          <Table head={['Workspace', 'Bucket', 'Owner', 'Outstanding', 'Deadline', 'Plan', '']}>
            {data.rows.map((row) => (
              <tr key={`${row.bucket}:${row.workspace_id}`} className="hover:bg-gray-700/20">
                <Td>
                  <Link to={`/ops/workspaces/${row.workspace_id}`} className="font-medium text-blue-300 hover:underline">
                    {row.name}
                  </Link>
                  <span className="block text-xs text-gray-500">/w/{row.slug}</span>
                </Td>
                <Td>
                  <Badge tone={BUCKET_TONE[row.bucket]}>{row.bucket.replace('_', ' ')}</Badge>
                </Td>
                <Td className="text-gray-400">
                  {row.owner_email ? (
                    <a className="hover:underline" href={`mailto:${row.owner_email}`}>
                      {row.owner_email}
                    </a>
                  ) : (
                    // No owner is itself the finding: nobody can be chased, and the
                    // workspace cannot be impersonated as an owner either.
                    <span className="text-amber-300">no active owner</span>
                  )}
                </Td>
                <Td>{row.amount_due_cents > 0 ? money(row.amount_due_cents, row.currency) : '—'}</Td>
                <Td>
                  <span className={row.days_remaining !== null && row.days_remaining < 0 ? 'text-red-300' : ''}>
                    {relativeDays(row.days_remaining)}
                  </span>
                  <span className="block text-xs text-gray-500">{shortDate(row.deadline)}</span>
                </Td>
                <Td className="text-gray-400">{row.plan_code}</Td>
                <Td>
                  {row.last_invoice_url && (
                    <a className="text-blue-300 hover:underline" href={row.last_invoice_url} target="_blank" rel="noreferrer">
                      Invoice
                    </a>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
