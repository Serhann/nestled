import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { requestPasswordReset } from '../../../lib/api/auth';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout } from './AuthLayout';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // The response is the same whether or not the address exists, and so is what
    // we show — this screen must not become a way to find out who has an account.
    await requestPasswordReset(email).catch(() => undefined);
    setSent(true);
    setBusy(false);
  };

  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <Link to="/login" className="font-semibold text-blue-700 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm text-gray-600">
          If there’s an account for <strong>{email}</strong>, a reset link is on its way. It expires
          in an hour.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" busy={busy} className="w-full">
            Send the link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
