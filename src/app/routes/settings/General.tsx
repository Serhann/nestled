import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { updateWorkspace } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { SettingsLayout } from './SettingsLayout';

export default function General() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [timezone, setTimezone] = useState(workspace.timezone);

  const save = useMutation({
    mutationFn: () => updateWorkspace(workspace.id, { name, slug, timezone }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: qk.me() });
      // The slug is in the URL, so changing it has to move the browser with it or
      // the next navigation 404s against a workspace that no longer answers to
      // that address.
      if (result.workspace.slug !== workspace.slug) {
        navigate(`/w/${result.workspace.slug}/settings/general`, { replace: true });
      }
    },
  });

  const readOnly = !can('workspace:update');
  const dirty = name !== workspace.name || slug !== workspace.slug || timezone !== workspace.timezone;

  return (
    <SettingsLayout title="Settings" subtitle={workspace.name}>
      <Section
        title="Workspace"
        action={
          !readOnly && (
            <Button busy={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
              Save
            </Button>
          )
        }
      >
        <div className="space-y-4">
          {save.error && (
            <p role="alert" className="text-sm text-red-600">
              {(save.error as Error).message}
            </p>
          )}
          <Field label="Name">
            {(a) => (
              <TextInput {...a} disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="Address" hint={`app.nestled.chat/w/${slug}`}>
            {(a) => (
              <TextInput
                {...a}
                disabled={readOnly}
                value={slug}
                onChange={(e) =>
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40))
                }
              />
            )}
          </Field>
          <Field label="Time zone" hint="The default for new websites and for reports.">
            {(a) => (
              <Select {...a} disabled={readOnly} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
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

      {can('workspace:delete') && (
        <Section
          title="Delete this workspace"
          description="Everything in it — conversations, websites, knowledge base — goes with it. We keep it recoverable for 30 days, then it is gone for good."
        >
          <Button
            variant="danger"
            onClick={() =>
              alert(
                'Deleting a workspace is not wired up yet. Contact support and we will do it for you.',
              )
            }
          >
            Delete {workspace.name}
          </Button>
        </Section>
      )}
    </SettingsLayout>
  );
}

function timezones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  const all = supported ? supported('timeZone') : [current];
  return all.includes(current) ? all : [current, ...all];
}
