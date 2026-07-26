import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { signup } from '../../../lib/api/auth';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout, FormError } from './AuthLayout';

/**
 * One field-set, no card, no workspace name.
 *
 * Everything else the product needs is asked for later, inside the wizard, where
 * the customer can already see what they are configuring. Every field added to
 * this screen costs completions, and the workspace name in particular is a
 * question people stall on before they know what the product does.
 */
export default function Signup() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup({ name, email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Start free"
      subtitle="14 days of everything. No card."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-blue-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <TextField
          label="Your name"
          autoComplete="name"
          required
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint="At least 10 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" busy={busy} className="w-full">
          Create my account
        </Button>
      </form>
    </AuthLayout>
  );
}
