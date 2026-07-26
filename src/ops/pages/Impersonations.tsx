import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../api';
import { useSession } from '../session';
import type { ImpersonationSession } from '../types';
import { Badge, Button, Card, Empty, ErrorBox, Spinner, Table, Td } from '../ui';

/**
 * The register.
 *
 * Read-only for every role including superadmin, because there is no route in the
 * codebase that deletes one of these rows. The only action is ENDING a live session
 * — and anyone can end anyone's, since the ability to stop a colleague who is
 * somewhere they should not be is worth more than tidy ownership.
 *
 * `mutations` is the column to read: a `full` session that changed nothing is the
 * normal case, and a large number is what a reviewer wants to notice.
 */
export function Impersonations() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [activeOnly, setActiveOnly] = useState(false);

  const { data, error, isPending } = useQuery({
    queryKey: ['impersonations', activeOnly],
    queryFn: () =>
      api<{ sessions: ImpersonationSession[] }>(
        `/platform/impersonations${activeOnly ? '?active_only=true' : ''}`,
      ),
    refetchInterval: 30_000,
  });

  const end = useMutation({
    mutationFn: (id: string) => api(`/platform/impersonations/${id}/end`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['impersonations'] }),
  });

  return (
    <Card
      title="Impersonation register"
      action={
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Live only
        </label>
      }
    >
      <p className="mb-3 text-xs text-gray-500">
        Permanent. Nothing on this page can be deleted or edited, and every customer sees their own portion of it on
        their audit page.
      </p>

      {error && <ErrorBox error={error} />}
      {end.error && <ErrorBox error={end.error} />}
      {isPending && <Spinner />}
      {data && data.sessions.length === 0 && <Empty>No sessions recorded.</Empty>}

      {data && data.sessions.length > 0 && (
        <Table head={['Staff', 'Customer', 'Reason', 'Scope', 'Changes', 'Started', 'State', '']}>
          {data.sessions.map((s) => (
            <tr key={s.id} className={s.active ? 'bg-amber-500/5' : ''}>
              <Td>
                {s.platform_user.name}
                <span className="block text-xs text-gray-500">{s.platform_user.email}</span>
              </Td>
              <Td>
                <Link to={`/ops/workspaces/${s.workspace.id}`} className="text-blue-300 hover:underline">
                  {s.workspace.name}
                </Link>
              </Td>
              <Td className="max-w-sm text-gray-300">{s.reason}</Td>
              <Td>
                <Badge tone={s.scope === 'full' ? 'warn' : 'neutral'}>{s.scope.replace('_', ' ')}</Badge>
              </Td>
              <Td>
                {s.mutations > 0 ? (
                  <Link
                    to={`/ops/workspaces/${s.workspace.id}?tab=activity`}
                    className="text-blue-300 hover:underline"
                  >
                    {s.mutations}
                  </Link>
                ) : (
                  <span className="text-gray-500">none</span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-gray-400">{dateTime(s.created_at)}</Td>
              <Td>
                {s.active ? (
                  <Badge tone="warn">live</Badge>
                ) : s.ended_at ? (
                  <span className="text-xs text-gray-500">ended {dateTime(s.ended_at)}</span>
                ) : (
                  <span className="text-xs text-gray-500">expired</span>
                )}
              </Td>
              <Td>
                {s.active && (
                  <Button
                    variant="danger"
                    onClick={() => end.mutate(s.id)}
                    disabled={end.isPending || !session?.user.can_write}
                  >
                    End now
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
