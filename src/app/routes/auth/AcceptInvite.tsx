import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { acceptInvite, login, readInvite } from '../../../lib/api/auth';
import { getSession } from '../../../lib/tokens';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Form';
import { AuthLayout, FormError } from './AuthLayout';

/**
 * Accepting an invitation.
 *
 * Two paths converge here and both have to feel like one step: someone who
 * already has a Nestled account joining a second workspace, and someone who has
 * never heard of us clicking a link from a colleague. The preview call tells us
 * which, so the form asks for a password only when there is no account yet.
 */
export default function AcceptInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => readInvite(token),
    retry: false,
  });

  const signedIn = Boolean(getSession());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvite(token, signedIn ? {} : { name, password });
      // Signing the new member straight in is the difference between joining a
      // team and being handed a second form to fill in.
      if (!signedIn && preview.data) {
        await login(preview.data.invite.email, password).catch(() => undefined);
      }
      void result;
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (preview.isLoading) {
    return <AuthLayout title="Checking your invitation…">{null}</AuthLayout>;
  }

  if (preview.isError || !preview.data) {
    return (
      <AuthLayout title="That invitation is no longer valid">
        <p className="text-sm text-gray-600">
          It may have been revoked or already used. Ask whoever invited you to send another.
        </p>
      </AuthLayout>
    );
  }

  const { invite } = preview.data;

  return (
    <AuthLayout
      title={`Join ${invite.workspace_name}`}
      subtitle={
        <>
          {invite.inviter_name ? `${invite.inviter_name} invited ` : 'You were invited as '}
          <strong>{invite.email}</strong>
          {invite.inviter_name ? ` as ${invite.role}` : ''}.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        {!signedIn && (
          <>
            <TextField
              label="Your name"
              autoComplete="name"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label="Choose a password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}
        <Button type="submit" busy={busy} className="w-full">
          Join the workspace
        </Button>
      </form>
    </AuthLayout>
  );
}
