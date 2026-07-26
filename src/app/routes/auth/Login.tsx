import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { login } from '../../../lib/api/auth';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout, FormError } from './AuthLayout';

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      // `next` preserves the deep link someone followed before being asked to
      // sign in — landing them on a generic inbox instead loses their place.
      const next = params.get('next');
      navigate(next && next.startsWith('/') ? next : '/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="font-semibold text-blue-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
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
      </form>
    </AuthLayout>
  );
}
