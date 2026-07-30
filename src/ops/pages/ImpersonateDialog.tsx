import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Button, Field, Modal, inputClass } from '../ui';

interface Started {
  session: { id: string; scope: string; expires_at: string; target: { name: string; email: string } };
  /** Where to send the operator. Carries a single-use code, not a token. */
  handover_url: string;
  claim_expires_in_seconds: number;
}

/**
 * Starting an impersonation session.
 *
 * The dialog is deliberately unpleasant to rush. The reason field is long, required
 * and explicitly labelled as permanent and customer-visible, because the control
 * that makes impersonation defensible is not the audit row — it is the staff member
 * knowing, while they type, that the customer will read it.
 *
 * `read_only` is the default. `full` has to be chosen.
 *
 * ── The handover ───────────────────────────────────────────────────────────────
 *
 * This used to display the signed access token in a textarea with a Copy button, on the
 * theory that writing a staff-minted credential into another origin's token store silently
 * is what makes an audit trail arguable. The risk was real; the remedy was not. What it
 * produced in practice was a bearer token for a customer's account living in a clipboard,
 * a form field, and wherever it was pasted next.
 *
 * Now the server returns a URL carrying a single-use, sixty-second code and this opens it
 * in a new tab. The token exists only inside that tab, in per-tab storage, and the
 * operator's own session is never touched — see server/src/routes/v1/impersonation.ts and
 * src/lib/tokens.ts.
 */
export function ImpersonateDialog({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const session = useSession();
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'read_only' | 'full'>('read_only');
  const [ttl, setTtl] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [blocked, setBlocked] = useState(false);

  const canWrite = session?.user.can_write ?? false;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Started>(`/platform/workspaces/${workspaceId}/impersonate`, {
        method: 'POST',
        body: { reason: reason.trim(), scope, ttl_minutes: ttl },
      });
      setStarted(result);

      /*
        Opened straight away, in the same click that started the session — a popup blocker
        allows a window opened from a user gesture, and this still counts as one. If it is
        blocked anyway (some configurations block everything), the link below is the
        fallback rather than a dead end. The code expires in a minute either way.
      */
      const tab = window.open(result.handover_url, '_blank', 'noopener');
      setBlocked(tab === null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session');
    } finally {
      setBusy(false);
    }
  }

  if (started) {
    return (
      <Modal title="Session started" onClose={onClose}>
        <div className="space-y-3 text-sm text-gray-300">
          <p>
            Acting as <strong className="text-gray-100">{started.session.target.name}</strong> (
            {started.session.target.email}) in <strong className="text-gray-100">{workspaceName}</strong>, scope{' '}
            <strong className="text-gray-100">{started.session.scope.replace('_', ' ')}</strong>, until{' '}
            {new Date(started.session.expires_at).toLocaleTimeString()}.
          </p>

          {blocked ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Your browser blocked the new tab.{' '}
              <a href={started.handover_url} target="_blank" rel="noopener noreferrer" className="underline">
                Open it now
              </a>{' '}
              — the link works once and expires in {started.claim_expires_in_seconds} seconds.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Opened in a new tab. That tab holds the session and nothing else does — closing it ends
              your side of it, and your own account is untouched in this one.
            </p>
          )}

          <p className="text-xs text-gray-500">
            The customer sees a banner naming this session with a countdown, and every change you make
            appears in their own audit log.
          </p>

          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Impersonate ${workspaceName}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          This is recorded permanently and shown to the customer. There is no way to delete the record.
        </p>

        <Field
          label="Reason"
          hint="At least 10 characters. Written to the customer's audit log verbatim."
        >
          <textarea
            className={`${inputClass} h-20`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ticket #4821 — owner reports the inbox is empty after their plan change"
            autoFocus
          />
        </Field>

        <Field label="Scope">
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-1"
                checked={scope === 'read_only'}
                onChange={() => setScope('read_only')}
              />
              <span>
                <span className="text-gray-100">Read only</span>
                <span className="block text-xs text-gray-500">
                  Every write throws at the database layer, not just in the UI.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" className="mt-1" checked={scope === 'full'} onChange={() => setScope('full')} />
              <span>
                <span className="text-gray-100">Full</span>
                <span className="block text-xs text-gray-500">
                  Can act as the customer. Billing, integrations, membership and export stay blocked regardless.
                </span>
              </span>
            </label>
          </div>
        </Field>

        <Field label="Duration" hint="Capped at 30 minutes. The token expires with the session and cannot be renewed.">
          <select className={inputClass} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            {[5, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </Field>

        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={start}
            disabled={busy || reason.trim().length < 10 || !canWrite}
            title={canWrite ? undefined : 'Enroll an authenticator first'}
          >
            {busy ? 'Starting…' : 'Start session'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
