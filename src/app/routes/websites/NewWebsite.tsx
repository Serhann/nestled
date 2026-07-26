import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { createWebsite } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { ApiError } from '../../../lib/http';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { Page, PageHeader } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';

export default function NewWebsite() {
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createWebsite(workspace.id, {
        name: name || suggest(domain) || 'New website',
        primary_domain: normalize(domain) || undefined,
        allowed_domains: normalize(domain) ? [normalize(domain)] : [],
      }),
    onSuccess: async ({ website }) => {
      await queryClient.invalidateQueries({ queryKey: qk.websites(workspace.id) });
      navigate(`/w/${workspace.slug}/websites/${website.id}/install`);
    },
  });

  if (!can('website:create')) return <NoAccess what="creating websites" />;

  const limit = create.error instanceof ApiError ? create.error.planLimit : null;

  return (
    <Page>
      <PageHeader title="Add a website" subtitle="Each one gets its own widget and snippet." />
      <Card className="p-6 space-y-4 max-w-lg">
        {limit ? (
          <p role="alert" className="text-sm text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
            Your plan includes {limit.limit} website{limit.limit === 1 ? '' : 's'} and you are using{' '}
            {limit.used}.{' '}
            <a href={`/w/${workspace.slug}/settings/billing`} className="font-semibold underline">
              See plans
            </a>
          </p>
        ) : (
          create.error && (
            <p role="alert" className="text-sm text-red-600">
              {(create.error as Error).message}
            </p>
          )
        )}
        <Field label="Domain" hint="We add this to the allowlist so the widget can load there.">
          {(a) => (
            <TextInput
              {...a}
              autoFocus
              placeholder="acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          )}
        </Field>
        <Field label="Name" hint="Only your team sees this.">
          {(a) => (
            <TextInput
              {...a}
              placeholder={suggest(domain) || 'New website'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Button busy={create.isPending} onClick={() => create.mutate()}>
          Create
        </Button>
      </Card>
    </Page>
  );
}

function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

function suggest(domain: string): string {
  const label = normalize(domain).split('.')[0] ?? '';
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}
