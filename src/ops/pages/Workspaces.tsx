import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, shortDate } from '../api';
import type { WorkspaceListResponse } from '../types';
import { Badge, Button, Card, Empty, ErrorBox, Spinner, Table, Td, inputClass } from '../ui';
import { statusTone } from '../tone';

const STATUSES = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'trial_expired',
  'suspended',
] as const;

/**
 * The customer list.
 *
 * The filters are the ones that correspond to a question someone actually has
 * ("who is past due?", "who is on business?"), not one control per column. The free
 * text box searches member emails and website domains as well as the workspace's own
 * name, because the ticket almost never names the company the way we recorded it.
 */
export function Workspaces() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [sort, setSort] = useState<'created' | 'name' | 'activity'>('created');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), per_page: '25', sort });
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  if (includeDeleted) params.set('include_deleted', 'true');

  const { data, error, isPending } = useQuery({
    queryKey: ['workspaces', params.toString()],
    queryFn: () => api<WorkspaceListResponse>(`/platform/workspaces?${params.toString()}`),
    // Keeps the table on screen while a filter change is in flight, instead of
    // flashing a spinner on every keystroke.
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <Card
        title="Workspaces"
        action={<span className="text-xs text-gray-500">{data ? `${data.total} total` : ''}</span>}
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Name, slug, member email or domain"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <select
            className={`${inputClass} max-w-[12rem]`}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <select
            className={`${inputClass} max-w-[12rem]`}
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="created">Newest first</option>
            <option value="activity">Recently active</option>
            <option value="name">By name</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => {
                setIncludeDeleted(e.target.checked);
                setPage(1);
              }}
            />
            Include deleted
          </label>
        </div>

        {error && <ErrorBox error={error} />}
        {isPending && <Spinner />}

        {data && data.workspaces.length === 0 && <Empty>No workspace matches those filters.</Empty>}

        {data && data.workspaces.length > 0 && (
          <Table head={['Workspace', 'Plan', 'Status', 'Members', 'Sites', 'Chats', 'Created']}>
            {data.workspaces.map((ws) => (
              <tr key={ws.id} className="hover:bg-gray-700/20">
                <Td>
                  <Link to={`/ops/workspaces/${ws.id}`} className="font-medium text-blue-300 hover:underline">
                    {ws.name}
                  </Link>
                  <span className="block text-xs text-gray-500">/w/{ws.slug}</span>
                </Td>
                <Td>{ws.plan.name}</Td>
                <Td>
                  <Badge tone={ws.deleted_at ? 'fail' : statusTone(ws.subscription_status)}>
                    {ws.deleted_at ? 'deleted' : ws.subscription_status.replace('_', ' ')}
                  </Badge>
                </Td>
                <Td>{ws._count.members}</Td>
                <Td>{ws._count.websites}</Td>
                <Td>{ws._count.conversations}</Td>
                <Td className="text-gray-400">{shortDate(ws.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}

        {data && data.total_pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm text-gray-400">
            <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Previous
            </Button>
            <span>
              Page {data.page} of {data.total_pages}
            </span>
            <Button onClick={() => setPage((p) => p + 1)} disabled={page >= data.total_pages}>
              Next
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
