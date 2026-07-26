import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getIntegrations, updateIntegrations } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { SettingsLayout } from './SettingsLayout';

/**
 * Discord notifications.
 *
 * The webhook URL is write-only from here: it contains a shared secret in its
 * path, so the server reports only whether one is configured. Showing it back
 * would put a credential on screen for anyone who can open this page.
 */
export default function Integrations() {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');

  const query = useQuery({
    queryKey: qk.integrations(workspace.id),
    queryFn: () => getIntegrations(workspace.id),
    enabled: can('integration:manage'),
  });

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateIntegrations>[1]) =>
      updateIntegrations(workspace.id, patch),
    onSuccess: async () => {
      setUrl('');
      await queryClient.invalidateQueries({ queryKey: qk.integrations(workspace.id) });
    },
  });

  if (!can('integration:manage')) return <NoAccess what="integrations" />;

  const config = query.data?.integrations;

  return (
    <SettingsLayout title="Integrations">
      {query.isLoading && <Spinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {config && (
        <Section
          title="Discord"
          description="Post new chats into a channel so nothing waits unseen while everyone is elsewhere."
        >
          <div className="space-y-4">
            <Field
              label="Webhook URL"
              hint={
                config.has_discord_webhook
                  ? 'A webhook is configured. Paste a new one to replace it — we do not show the current value back.'
                  : 'Discord → Channel settings → Integrations → Webhooks.'
              }
            >
              {(a) => (
                <div className="flex gap-2">
                  <TextInput
                    {...a}
                    type="url"
                    placeholder="https://discord.com/api/webhooks/…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    disabled={!url}
                    busy={save.isPending}
                    onClick={() => save.mutate({ discord_webhook_url: url })}
                  >
                    Save
                  </Button>
                </div>
              )}
            </Field>

            {config.has_discord_webhook && (
              <>
                <Toggle
                  checked={config.discord_webhook_enabled}
                  onChange={(v) => save.mutate({ discord_webhook_enabled: v })}
                  label="Send notifications"
                />
                <Toggle
                  checked={config.discord_notify_new_chat}
                  onChange={(v) => save.mutate({ discord_notify_new_chat: v })}
                  label="A new conversation starts"
                />
                <Toggle
                  checked={config.discord_notify_new_message}
                  onChange={(v) => save.mutate({ discord_notify_new_message: v })}
                  label="Every message"
                  description="Noisy on a busy account. Most teams leave this off."
                />
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => save.mutate({ discord_webhook_url: null, discord_webhook_enabled: false })}
                >
                  Disconnect Discord
                </Button>
              </>
            )}
          </div>
        </Section>
      )}
    </SettingsLayout>
  );
}
