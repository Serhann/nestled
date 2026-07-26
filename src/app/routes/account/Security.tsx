import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { changePassword, logout } from '../../../lib/api/auth';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { Page, PageHeader } from '../../../ui/Page';

export default function Security() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const change = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });

  return (
    <Page>
      <PageHeader
        title="Security"
        action={
          <Link to="/account/profile" className="text-sm font-semibold text-blue-700 hover:underline">
            Profile
          </Link>
        }
      />
      <Section
        title="Change your password"
        description="Every other session is signed out when you do — that is the point of changing it."
      >
        <div className="space-y-4 max-w-sm">
          {change.error && (
            <p role="alert" className="text-sm text-red-600">
              {(change.error as Error).message}
            </p>
          )}
          {change.isSuccess && <p className="text-sm text-green-700">Password updated.</p>}
          <Field label="Current password">
            {(a) => (
              <TextInput
                {...a}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            {(a) => (
              <TextInput
                {...a}
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            )}
          </Field>
          <Button
            busy={change.isPending}
            disabled={!current || next.length < 10}
            onClick={() => change.mutate()}
          >
            Change password
          </Button>
        </div>
      </Section>

      <Section
        title="Signed-in devices"
        description="Signing out everywhere ends every session, including this one."
      >
        <Button
          variant="ghost"
          onClick={() => {
            void logout(true).finally(() => {
              window.location.href = '/login';
            });
          }}
        >
          Sign out everywhere
        </Button>
      </Section>
    </Page>
  );
}
