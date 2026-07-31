import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getIntegrations, updateIntegrations, type Integrations } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { SettingsLayout } from './SettingsLayout';

/**
 * Notifications that leave the app: Discord, and email/SMS when nobody is online.
 *
 * The Discord webhook URL is write-only from here: it contains a shared secret in its
 * path, so the server reports only whether one is configured. Showing it back
 * would put a credential on screen for anyone who can open this page.
 *
 * The offline alert recipients are the opposite — they are the team's own addresses and
 * numbers, and have to be shown to be editable at all.
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

      {config && <OfflineAlerts config={config} saving={save.isPending} onSave={save.mutate} />}
    </SettingsLayout>
  );
}

/**
 * "Nobody was online and somebody left their details."
 *
 * Both lists are edited as one comma- or newline-separated box rather than as a repeater of
 * rows. Adding four numbers is then four keystrokes of punctuation instead of four clicks,
 * and pasting a list from wherever the on-call rota already lives works.
 *
 * The lists are LOCAL state until Save, unlike every toggle on this page, which writes
 * immediately. A half-typed email address must not be sent to the server on each keystroke —
 * it would fail validation on almost every one of them and put a red error under a field
 * somebody is still typing into.
 */
function OfflineAlerts({
  config,
  saving,
  onSave,
}: {
  config: Integrations;
  saving: boolean;
  onSave(patch: Partial<Integrations>): void;
}) {
  const [emails, setEmails] = useState(config.offline_alert_emails.join(', '));
  const [phones, setPhones] = useState(config.offline_alert_phones.join(', '));

  const parse = (value: string): string[] =>
    value
      .split(/[,\n;]+/)
      .map((part) => part.trim())
      .filter(Boolean);

  const dirty =
    parse(emails).join(',') !== config.offline_alert_emails.join(',') ||
    parse(phones).join(',') !== config.offline_alert_phones.join(',');

  return (
    <Section
      title="When nobody is online"
      description="A visitor who leaves their name, email or answers to your bot's questions out of hours is only useful if somebody hears about it. This sends those details by email and text."
    >
      <div className="space-y-4">
        <Toggle
          checked={config.offline_alert_enabled}
          onChange={(v) => onSave({ offline_alert_enabled: v })}
          label="Send alerts when details are left out of hours"
          description="Sent once per conversation, as soon as the first detail is captured — either when no agent is connected or when you are outside your business hours."
        />

        {config.offline_alert_enabled && (
          <>
            <Toggle
              checked={config.offline_alert_notify_agents}
              onChange={(v) => onSave({ offline_alert_notify_agents: v })}
              label="Email everyone who can see the website"
              description="The same people a browser notification would reach. Off, and only the addresses below are used."
            />

            <Field
              label="Also email"
              hint="Comma-separated. Useful for a shared inbox or somebody who has no Nestled account."
            >
              {(a) => (
                <TextInput
                  {...a}
                  value={emails}
                  placeholder="oncall@yourcompany.com, sales@yourcompany.com"
                  onChange={(e) => setEmails(e.target.value)}
                />
              )}
            </Field>

            <Field
              label="Text these numbers"
              hint="International format, comma-separated — e.g. +905551234567. Leave empty for email only. Texts are sent from your own SMS number, so they need an SMS channel set up on the website."
            >
              {(a) => (
                <TextInput
                  {...a}
                  value={phones}
                  placeholder="+905551234567, +447700900123"
                  onChange={(e) => setPhones(e.target.value)}
                />
              )}
            </Field>

            <div>
              <Button
                disabled={!dirty}
                busy={saving}
                onClick={() =>
                  onSave({
                    offline_alert_emails: parse(emails),
                    offline_alert_phones: parse(phones),
                  })
                }
              >
                Save recipients
              </Button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
