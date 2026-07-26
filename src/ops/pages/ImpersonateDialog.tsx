import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Button, Field, Modal, inputClass } from '../ui';

interface Minted {
  session: { id: string; scope: string; expires_at: string; target: { name: string; email: string } };
  access_token: string;
  refresh_token: null;
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
  const [minted, setMinted] = useState<Minted | null>(null);

  const canWrite = session?.user.can_write ?? false;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setMinted(
        await api<Minted>(`/platform/workspaces/${workspaceId}/impersonate`, {
          method: 'POST',
          body: { reason: reason.trim(), scope, ttl_minutes: ttl },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session');
    } finally {
      setBusy(false);
    }
  }

  if (minted) {
    return (
      <Modal title="Session started" onClose={onClose}>
        <div className="space-y-3 text-sm text-gray-300">
          <p>
            Acting as <strong className="text-gray-100">{minted.session.target.name}</strong> (
            {minted.session.target.email}) in <strong className="text-gray-100">{workspaceName}</strong>, scope{' '}
            <strong className="text-gray-100">{minted.session.scope.replace('_', ' ')}</strong>, until{' '}
            {new Date(minted.session.expires_at).toLocaleTimeString()}.
          </p>
          {/* The token is handed over rather than auto-applied. The customer app is
              a different origin with its own token store, and silently writing a
              staff-minted credential into it is exactly the kind of convenience
              that makes an audit trail arguable. */}
          <Field label="Access token" hint="Paste into the customer app. It cannot be refreshed and expires with the session.">
            <textarea readOnly className={`${inputClass} h-24 font-mono text-xs`} value={minted.access_token} />
          </Field>
          <p className="text-xs text-gray-500">
            The customer sees a banner naming this session, and every change you make appears in their own audit log.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => void navigator.clipboard?.writeText(minted.access_token)}>Copy token</Button>
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
