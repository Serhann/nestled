import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../providers/SessionProvider';
import { updateProfile } from '../../../lib/api/auth';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Page, PageHeader } from '../../../ui/Page';

export default function Profile() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const [timezone, setTimezone] = useState(me.user.timezone);

  const save = useMutation({
    mutationFn: () => updateProfile({ name, timezone }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.me() }),
  });

  const dirty = name !== me.user.name || timezone !== me.user.timezone;

  return (
    <Page>
      <PageHeader
        title="Your account"
        subtitle={me.user.email}
        action={
          <Link to="/account/security" className="text-sm font-semibold text-blue-700 hover:underline">
            Security
          </Link>
        }
      />
      <Section
        title="Profile"
        description="Your name is what visitors see when you reply."
        action={
          <Button busy={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            {(a) => <TextInput {...a} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Email" hint="Changing your email is not self-service yet — contact support.">
            {(a) => <TextInput {...a} value={me.user.email} disabled />}
          </Field>
          <Field label="Time zone" hint="How timestamps are shown to you.">
            {(a) => (
              <Select {...a} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones(timezone).map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      {me.workspaces.length > 1 && (
        <Section title="Where you land" description="Which workspace opens when you sign in.">
          <Select
            value={me.user.default_workspace_id ?? ''}
            onChange={(e) => updateProfile({ default_workspace_id: e.target.value || null })}
          >
            <option value="">The first one</option>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Section>
      )}
    </Page>
  );
}

function timezones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  const all = supported ? supported('timeZone') : [current];
  return all.includes(current) ? all : [current, ...all];
}
