import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime, patchStoredUser } from '../api';
import { refreshSession, setSession, useSession } from '../session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Spinner, Table, Td, inputClass } from '../ui';
import { QrCode } from '../../ui/QrCode';

interface MeResponse {
  user: { id: string; email: string; name: string; role: string; totp_enabled: boolean; created_at: string };
  sessions: { id: string; ip: string | null; user_agent: string | null; created_at: string; expires_at: string; current: boolean }[];
}

/**
 * The staff member's own account: second factor and live sessions.
 *
 * Enrollment is the one write this panel allows without a factor, for the obvious
 * reason. Everything else on every other page is gated on it.
 */
export function Account() {
  const session = useSession();
  const queryClient = useQueryClient();

  const { data, error, isPending } = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/platform/me'),
  });

  return (
    <div className="space-y-4">
      <Card title="Two-factor authentication">
        {session?.user.can_write ? <FactorEnrolled /> : <FactorEnrollment />}
      </Card>

      <Card
        title="Sessions"
        action={
          <Button
            onClick={async () => {
              // Rotates into a brand new session so the person clicking this is not
              // logged out by their own panic button.
              const result = await api<{ token: string; expires_at: string }>(
                '/platform/me/sessions/revoke-others',
                { method: 'POST' },
              );
              if (session) {
                setSession({ ...session, token: result.token, expires_at: result.expires_at });
              }
              void queryClient.invalidateQueries({ queryKey: ['me'] });
            }}
          >
            Sign out everywhere else
          </Button>
        }
      >
        {error && <ErrorBox error={error} />}
        {isPending && <Spinner />}
        {data && data.sessions.length === 0 && <Empty>No live sessions.</Empty>}
        {data && data.sessions.length > 0 && (
          <Table head={['Started', 'Expires', 'IP', 'Device', '']}>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <Td className="text-gray-400">{dateTime(s.created_at)}</Td>
                <Td className="text-gray-400">{dateTime(s.expires_at)}</Td>
                <Td>{s.ip ?? '—'}</Td>
                <Td className="max-w-xs truncate text-gray-500">{s.user_agent ?? '—'}</Td>
                <Td>{s.current && <Badge tone="ok">this device</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function FactorEnrolled() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-300">
        <Badge tone="ok">enrolled</Badge> This session can make changes.
      </p>
      <p className="text-xs text-gray-500">
        Removing the factor makes every future session read-only until you enroll again. It needs a current code —
        knowing the password is not enough to strip the control that limits what the password can do.
      </p>
      <div className="flex items-end gap-2">
        <Field label="Current code">
          <input
            className={`${inputClass} w-32`}
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Button
          variant="danger"
          disabled={code.length !== 6}
          onClick={async () => {
            setError(null);
            try {
              await api('/platform/me/totp', { method: 'DELETE', body: { code } });
              patchStoredUser({ totp_enabled: false, can_write: false });
              refreshSession();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not remove the factor');
            }
          }}
        >
          Remove factor
        </Button>
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function FactorEnrollment() {
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await api<{ secret: string; otpauth_uri: string }>('/platform/me/totp', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start enrollment');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>('/platform/me/totp/verify', { method: 'POST', body: { code } });
      patchStoredUser({ totp_enabled: true, can_write: true });
      refreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-300">
        <Badge tone="warn">not enrolled</Badge> This session is read-only.
      </p>
      <p className="text-xs text-gray-500">
        A staff password is the single credential that reaches every customer at once, so possession of it alone buys
        looking and nothing else — including changing your own role.
      </p>

      {!enrollment && (
        <Button variant="primary" onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Set up an authenticator'}
        </Button>
      )}

      {enrollment && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
            {/*
              Generated in this process, never fetched. A QR from a public chart URL
              would hand the otpauth:// URI — which contains the TOTP secret — to a
              third party on every enrolment, which defeats the point of the factor.
            */}
            <QrCode value={enrollment.otpauth_uri} size={168} className="shrink-0 p-2" />
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-sm text-gray-300">
                Scan this with your authenticator app. If you cannot scan it, type the
                secret below instead.
              </p>
              <Field label="Or type this secret">
                <code className="block rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 font-mono text-sm tracking-widest break-all">
                  {enrollment.secret.match(/.{1,4}/g)?.join(' ')}
                </code>
              </Field>
              <details className="text-xs text-gray-400">
                <summary className="cursor-pointer select-none hover:text-gray-300">
                  Show the setup URI
                </summary>
                <textarea
                  readOnly
                  className={`${inputClass} mt-2 h-16 font-mono text-[11px]`}
                  value={enrollment.otpauth_uri}
                />
              </details>
            </div>
          </div>
          <Field label="Confirm with a code">
            <input
              className={`${inputClass} w-32`}
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </Field>
          <Button variant="primary" onClick={verify} disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Confirm'}
          </Button>
        </div>
      )}

      {error && <ErrorBox error={error} />}
    </div>
  );
}
