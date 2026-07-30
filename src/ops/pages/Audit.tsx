import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../api';
import { useSession } from '../session';
import type { AuditPage, PlatformAuditEntry } from '../types';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, Spinner, Table, Td, inputClass } from '../ui';

/**
 * What we did, across every customer — and the way back from the parts that removed
 * something.
 *
 * A workspace's own history is already on its detail page. This is the same table read
 * the other way round, which is the read support actually needs: "somebody deleted a
 * website last week and I cannot remember whose it was" has no answer on a per-customer
 * page, because finding it requires knowing the answer first.
 *
 * The Undo button appears only where the server says the deletion is still reversible.
 * That decision is not made here on purpose: matching action names in the UI would keep
 * offering to undo deletions that were purged months ago, and a restore button that
 * fails is worse than no button — it teaches people the log is lying to them.
 */
export function Audit() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [restoring, setRestoring] = useState<PlatformAuditEntry | null>(null);

  const query = new URLSearchParams({ page: String(page), per_page: '50' });
  if (action) query.set('action', action);
  if (actor) query.set('actor_email', actor);

  const { data, error, isPending } = useQuery({
    queryKey: ['audit', action, actor, page],
    queryFn: () => api<AuditPage>(`/platform/audit?${query.toString()}`),
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;

  return (
    <div className="space-y-3">
      <Card
        title="Audit log"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              A prefix match, so `platform.` narrows to staff actions and
              `platform.deleted` to deletions alone. Presented as the filters people
              actually ask for rather than as a free-text box nobody guesses the
              vocabulary for.
            */}
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              className={inputClass}
            >
              <option value="">Everything</option>
              <option value="platform.">Staff actions</option>
              <option value="platform.deleted">Deletions</option>
              <option value="platform.deletion_restored">Restores</option>
              <option value="platform.deletion_purged">Purges</option>
              <option value="platform.workspace_plan_set">Plan changes</option>
              <option value="platform.user_email_confirmed">Email confirmations</option>
              <option value="impersonation">Impersonation</option>
            </select>
            <input
              value={actor}
              onChange={(e) => {
                setActor(e.target.value);
                setPage(1);
              }}
              placeholder="Actor email"
              className={inputClass}
            />
          </div>
        }
      >
        <p className="mb-3 text-xs text-gray-500">
          Append-only. Nothing here can be edited or removed, and each customer sees their own
          portion of it on their audit page.
        </p>

        {error && <ErrorBox error={error} />}
        {isPending && <Spinner />}
        {data && data.entries.length === 0 && <Empty>Nothing recorded for this filter.</Empty>}

        {data && data.entries.length > 0 && (
          <Table head={['When', 'Who', 'Action', 'Target', 'Customer', 'Reason', '']}>
            {data.entries.map((entry) => (
              <tr key={entry.id}>
                <Td className="whitespace-nowrap text-gray-400">{dateTime(entry.created_at)}</Td>
                <Td>
                  {entry.actor_email ?? <span className="text-gray-500">{entry.actor_type}</span>}
                  {entry.impersonation_session_id && (
                    <Badge tone="warn">via impersonation</Badge>
                  )}
                </Td>
                <Td className="font-mono text-xs text-gray-300">{entry.action}</Td>
                <Td className="text-gray-300">
                  {entry.target_type}
                  {/*
                    The label captured at deletion time, when there is one. After a
                    purge the row it pointed at is gone, so an id here would be
                    unreadable and a join would return nothing.
                  */}
                  {typeof entry.details?.label === 'string' && (
                    <span className="block text-xs text-gray-500">{entry.details.label}</span>
                  )}
                </Td>
                <Td>
                  {entry.workspace ? (
                    <Link
                      to={`/ops/workspaces/${entry.workspace_id}`}
                      className="text-blue-300 hover:underline"
                    >
                      {entry.workspace.name}
                    </Link>
                  ) : (
                    <span className="text-gray-500">—</span>
                  )}
                </Td>
                <Td className="max-w-sm text-gray-300">
                  {typeof entry.details?.reason === 'string' ? entry.details.reason : '—'}
                </Td>
                <Td>
                  {entry.restore && (
                    <Button
                      disabled={!session?.user.can_write}
                      onClick={() => setRestoring(entry)}
                    >
                      Undo · {entry.restore.days_left}d left
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {data && pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
            <span>
              {data.total} entries · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button  disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button  disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {restoring?.restore && (
        <RestoreDialog
          entry={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            void queryClient.invalidateQueries({ queryKey: ['audit'] });
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Undoing a deletion.
 *
 * The reason is required here too, and for the same purpose as everywhere else on this
 * surface — but the sentence that matters is the one about websites: a restored website
 * comes back switched OFF. Bringing a widget back up on a customer's live site is their
 * decision, not a side effect of us correcting our own mistake, and support needs to
 * know that before they tell a customer it is all sorted.
 */
function RestoreDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: PlatformAuditEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [restored, setRestored] = useState<Record<string, number> | null>(null);

  const restore = useMutation({
    mutationFn: () =>
      api<{ restored: Record<string, number> }>(
        `/platform/deletions/${entry.restore!.deletion_event_id}/restore`,
        { method: 'POST', body: { reason: reason.trim() } },
      ),
    onSuccess: (result) => setRestored(result.restored),
  });

  if (restored) {
    const rows = Object.entries(restored).filter(([, count]) => count > 0);
    return (
      <Modal title="Restored" onClose={onDone}>
        {rows.length === 0 ? (
          /*
            The server reports what actually moved. Zero means the rows are no longer
            there to restore — most often because a parent was purged — and saying so is
            the difference between support telling a customer it is fixed and support
            finding out from the customer that it is not.
          */
          <p className="text-sm text-amber-300">
            Nothing came back. The rows are no longer in the database, which usually means their
            workspace has already been purged.
          </p>
        ) : (
          <ul className="space-y-1 text-sm text-gray-300">
            {rows.map(([table, count]) => (
              <li key={table}>
                {count} {table.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-gray-500">
          A restored website is switched off until the customer turns it back on, so their widget
          does not reappear on a live site without them knowing.
        </p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Undo this deletion" onClose={onClose}>
      <p className="text-sm text-gray-300">
        {entry.target_type}
        {typeof entry.details?.label === 'string' ? ` · ${entry.details.label}` : ''}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        {entry.restore!.days_left} days left to undo this. Only the rows this deletion touched come
        back — anything deleted separately stays deleted.
      </p>

      {restore.error && <ErrorBox error={restore.error} />}

      <div className="mt-3">
        <Field label="Reason" hint="Recorded permanently, and visible to the customer.">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className={inputClass}
            placeholder="Deleted the wrong website while merging their two accounts."
          />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button  onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={restore.isPending || reason.trim().length < 3} onClick={() => restore.mutate()}>
          Restore
        </Button>
      </div>
    </Modal>
  );
}
