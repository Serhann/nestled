import { useState } from 'react';
import { api, ApiError, type StoredSession } from '../api';
import { setSession } from '../session';
import { Button, Field, inputClass } from '../ui';

/**
 * Staff sign-in.
 *
 * Two-step by necessity rather than by design: the server does not reveal whether
 * an account has a second factor until the password is correct, so the TOTP field
 * appears only after a `totp_required` response. Showing it up front would leak
 * which addresses are staff with factors, to anyone who can load this page.
 */
export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<StoredSession>('/platform/auth/login', {
        method: 'POST',
        anonymous: true,
        body: { email, password, ...(totp ? { totp } : {}) },
      });
      setSession(session);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the six-digit code from your authenticator.');
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
        // A wrong code must not persist into the next attempt, or the user retypes
        // their password and gets the same failure for a reason they cannot see.
        setTotp('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gray-900 p-6 text-gray-100">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <header>
          <div className="text-xs font-semibold uppercase tracking-widest text-gray-500">Nestled</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Platform panel</h1>
          <p className="mt-1 text-sm text-gray-400">Staff access. Every action here is recorded.</p>
        </header>

        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>

        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        {needsTotp && (
          <Field label="Authenticator code">
            <input
              className={inputClass}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
          </Field>
        )}

        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>
        )}

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
