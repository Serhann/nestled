import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { useSession } from '../session';
import { Button, ErrorBox, Field, Modal, inputClass } from '../ui';

/**
 * The delete button, everywhere it appears.
 *
 * One component rather than four, because the parts that must not vary between a
 * workspace and a conversation are exactly the parts a second copy would get wrong: the
 * reason is required, what the deletion takes with it is spelled out BEFORE the button
 * is pressed, and the ninety-day window is stated as a fact rather than implied by an
 * "are you sure?".
 *
 * Deleting is `superadmin` only on the server. The button is shown to everyone and
 * refused with a reason, rather than hidden: a support agent who cannot find the delete
 * button concludes it does not exist and asks in chat, which is slower than reading a
 * sentence that says who can do it.
 */

type DeletableType = 'workspace' | 'website' | 'user' | 'conversation';

/** What each type takes with it. Shown in the dialog, and true — see lib/deletions.ts. */
const CASCADE: Record<DeletableType, string> = {
  workspace:
    'The workspace, every website in it, and every conversation. Their users keep their accounts — someone who also works for another customer must not lose that login.',
  website:
    'The website and its conversations. The widget stops serving immediately, and the website stays switched off if it is later restored.',
  user: 'This person’s account and their sessions. Their memberships stay, so a restore puts them back on the same teams.',
  conversation: 'This conversation, with its messages, attachments and notes.',
};

export function DeleteAction({
  type,
  id,
  label,
  onDone,
  compact,
}: {
  type: DeletableType;
  id: string;
  /** What to call the thing in the dialog — a name, slug or email. */
  label: string;
  onDone: () => void;
  compact?: boolean;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  // Shown but refused when the scope is missing, with the scope named. Hiding it makes
  // people ask in chat whether deletion exists; naming it makes them ask for the one
  // permission they need.
  const canDelete = session?.user.capabilities?.includes('deletion:create') ?? false;
  return (
    <>
      <Button
        variant="danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'Needs the deletion:create permission'}
        onClick={() => setOpen(true)}
      >
        {compact ? 'Delete' : `Delete ${type}`}
      </Button>
      {open && (
        <DeleteDialog
          type={type}
          id={id}
          label={label}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      )}
    </>
  );
}

function DeleteDialog({
  type,
  id,
  label,
  onClose,
  onDone,
}: {
  type: DeletableType;
  id: string;
  label: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<{ affected: Record<string, number>; window: number } | null>(null);

  const remove = useMutation({
    mutationFn: () =>
      api<{ deletion: { id: string; restore_window_days: number }; affected: Record<string, number> }>(
        '/platform/deletions',
        { method: 'POST', body: { type, id, reason: reason.trim() } },
      ),
    onSuccess: (data) => setResult({ affected: data.affected, window: data.deletion.restore_window_days }),
  });

  if (result) {
    return (
      <Modal title="Deleted" onClose={onDone}>
        <ul className="space-y-1 text-sm text-gray-300">
          {Object.entries(result.affected).map(([table, count]) => (
            <li key={table}>
              {count} {table.replace(/_/g, ' ')}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Reversible from the Audit page for {result.window} days. After that it is deleted for good,
          including the files.
        </p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Modal>
    );
  }

  // Typing the name is reserved for the workspace: it is the one deletion whose blast
  // radius is somebody's whole account, and a mis-click there is not recoverable by
  // reading a sentence more carefully next time. Asking for it on every conversation
  // would train people to copy-paste past the warning.
  const needsName = type === 'workspace';
  const ready = reason.trim().length >= 3 && (!needsName || confirm.trim() === label);

  return (
    <Modal title={`Delete this ${type}`} onClose={onClose}>
      <p className="text-sm text-gray-200">{label}</p>
      <p className="mt-2 text-sm text-gray-400">{CASCADE[type]}</p>
      <p className="mt-2 text-xs text-gray-500">
        Anything already deleted separately stays deleted — undoing this brings back only what this
        action removes.
      </p>

      {remove.error && (
        <div className="mt-3">
          <ErrorBox error={remove.error} />
        </div>
      )}

      <div className="mt-3 space-y-3">
        <Field label="Reason" hint="Recorded permanently, visible to the customer, and read by whoever finds this in ninety days.">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className={inputClass}
            placeholder="Customer asked us to close the account — ticket 4821."
          />
        </Field>

        {needsName && (
          <Field label={`Type the name to confirm`} hint={label}>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
          </Field>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500">
          {session?.user.can_write
            ? 'Needs the deletion:create permission.'
            : 'Enroll an authenticator first — this session is read-only.'}
        </span>
        <div className="flex gap-2">
          <Button onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending || !ready || !session?.user.can_write}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
