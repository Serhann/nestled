import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { resetPassword } from '../../../lib/api/auth';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout, FormError } from './AuthLayout';

export default function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      // A reset revokes every other session on the server, which is the point:
      // whoever the user was locking out is now signed out too.
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout title="That link is incomplete">
        <p className="text-sm text-gray-600">
          Request a new one from the{' '}
          <Link to="/forgot" className="font-semibold text-blue-700 hover:underline">
            reset page
          </Link>
          .
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <p className="text-sm text-gray-600">
          Done. Every other session has been signed out. Taking you to sign in…
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError error={error} />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={10}
            hint="At least 10 characters."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" busy={busy} className="w-full">
            Set the password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
