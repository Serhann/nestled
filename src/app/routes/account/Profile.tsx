import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../providers/SessionProvider';
import { updateProfile } from '../../../lib/api/auth';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Page } from '../../../ui/Page';

export default function Profile() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.user.name);
  // Never blank. An account created before the field existed, or one the browser could
  // not resolve at signup, has no timezone — and an empty picker looks broken rather
  // than unset. The browser's own zone is the best available guess.
  const [timezone, setTimezone] = useState(
    me.user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );

  const save = useMutation({
    mutationFn: () => updateProfile({ name, timezone }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.me() }),
  });

  const landing = useMutation({
    mutationFn: (id: string | null) => updateProfile({ default_workspace_id: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.me() }),
  });

  const dirty = name !== me.user.name || timezone !== me.user.timezone;

  return (
    <Page>
      {/*
        An identity block rather than a bare title. This page is about a person, and
        the avatar is the same one their customers see on a reply — showing it here is
        the only place they ever get to check it.
      */}
      <div className="flex items-center gap-4">
        <span className="w-14 h-14 shrink-0 rounded-2xl bg-blue-600 text-white font-display text-2xl flex items-center justify-center">
          {(me.user.name || me.user.email).slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-2xl text-gray-900 truncate">
            {me.user.name || 'Your account'}
          </h1>
          <p className="text-sm text-gray-500 truncate">{me.user.email}</p>
        </div>
      </div>
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

      <Section
        title="Your workspaces"
        description={
          me.workspaces.length > 1
            ? 'Which one opens when you sign in.'
            : 'The workspaces this account belongs to.'
        }
      >
        <ul className="divide-y divide-gray-100">
          {me.workspaces.map((workspace) => (
            <li key={workspace.id} className="flex items-center gap-3 py-2.5">
              <span className="w-8 h-8 shrink-0 rounded-xl bg-gray-100 text-gray-600 text-sm font-semibold flex items-center justify-center">
                {workspace.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate">{workspace.name}</p>
                <p className="text-xs text-gray-500 capitalize">{workspace.role}</p>
              </div>
              <Link
                to={`/w/${workspace.slug}/inbox`}
                className="text-xs font-semibold text-blue-700 hover:underline shrink-0"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>

        {me.workspaces.length > 1 && (
          <div className="mt-4 max-w-sm">
            <Field label="Open this one when I sign in">
              {(a) => (
                <Select
                  {...a}
                  value={me.user.default_workspace_id ?? ''}
                  // Through the mutation, so it invalidates /me and the change sticks
                  // on screen. Calling the API directly left the control showing the
                  // old value until a reload.
                  onChange={(e) => landing.mutate(e.target.value || null)}
                >
                  <option value="">The first one</option>
                  {me.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </Section>
    </Page>
  );
}

function timezones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  const all = supported ? supported('timeZone') : [current];
  return all.includes(current) ? all : [current, ...all];
}
