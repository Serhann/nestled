import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { login } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/http';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout, FormError } from './AuthLayout';

/**
 * Sign in, in one step for most people and two for anyone with a second factor.
 *
 * The password is not re-asked on the second step — it is kept in state and resent
 * with the code. Making someone retype it after they got it right reads as "that
 * failed", which is the wrong signal at exactly the moment they are being asked for
 * something extra.
 */
export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  /** Set once the server has said the password was right but a factor is required. */
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = code.trim();
      await login(
        email,
        password,
        needsCode
          ? useRecovery
            ? { recovery_code: trimmed }
            : { totp: trimmed }
          : undefined,
      );
      // `next` preserves the deep link someone followed before being asked to
      // sign in — landing them on a generic inbox instead loses their place.
      const next = params.get('next');
      navigate(next && next.startsWith('/') ? next : '/', { replace: true });
    } catch (err) {
      /*
        `totp_required` is not a failure to show as one. The password was correct;
        the form simply has another field now. Showing the generic error text here
        would tell someone their password was wrong when it was not.
      */
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsCode(true);
        setError(null);
      } else {
        setError(err);
      }
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={needsCode ? 'One more step' : 'Welcome back'}
      footer={
        needsCode ? (
          <button
            type="button"
            onClick={() => {
              setNeedsCode(false);
              setUseRecovery(false);
              setCode('');
              setError(null);
            }}
            className="font-semibold text-blue-700 hover:underline"
          >
            Use a different account
          </button>
        ) : (
          <>
            New here?{' '}
            <Link to="/signup" className="font-semibold text-blue-700 hover:underline">
              Create an account
            </Link>
          </>
        )
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />

        {needsCode ? (
          <>
            <p className="text-sm text-gray-600">
              {useRecovery
                ? 'Enter one of the recovery codes you saved when you turned this on. Each works once.'
                : `Enter the six-digit code your authenticator app shows for ${email}.`}
            </p>
            <TextField
              label={useRecovery ? 'Recovery code' : 'Authentication code'}
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              required
              autoFocus
              className="font-mono tracking-widest"
              maxLength={useRecovery ? 20 : 6}
              value={code}
              onChange={(e) =>
                setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ''))
              }
            />
            <Button type="submit" busy={busy} className="w-full">
              Sign in
            </Button>
            <p className="text-center">
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError(null);
                }}
                className="text-xs text-gray-500 hover:underline"
              >
                {useRecovery ? 'Use your authenticator app instead' : 'Lost your phone? Use a recovery code'}
              </button>
            </p>
          </>
        ) : (
          <>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" busy={busy} className="w-full">
              Sign in
            </Button>
            <p className="text-center">
              <Link to="/forgot" className="text-xs text-gray-500 hover:underline">
                Forgot your password?
              </Link>
            </p>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
