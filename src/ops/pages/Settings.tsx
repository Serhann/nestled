import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, loadSession } from '../api';
import { Badge, Button, Card, ErrorBox, Field, Spinner, inputClass } from '../ui';

/**
 * Install-wide settings.
 *
 * This page is why the deployment needs a dozen environment variables instead of
 * forty. An API key, an SMTP host, a MaxMind licence — these are things you
 * change on a Tuesday afternoon, and in the environment each change costs a
 * container restart and usually a redeploy.
 *
 * Two behaviours the form must get right, both about not destroying things:
 *
 *   - **A secret is write-only.** The server reports only whether one is set and
 *     its last four characters. Leaving a secret field blank means "leave it
 *     alone"; there is a separate, explicit Clear button, because those are
 *     different intentions and conflating them is how a Stripe key disappears.
 *   - **Only edited fields are sent.** A PATCH carrying every field would rewrite
 *     values the operator never looked at.
 */

interface Masked {
  set: boolean;
  hint: string | null;
}

interface SettingsResponse {
  settings: {
    encryption_enabled: boolean;
    ai: {
      provider: string;
      model: string;
      anthropic_api_key: Masked;
      openai_api_key: Masked;
      ollama_url: string | null;
    };
    mail: {
      smtp_host: string | null;
      smtp_port: number;
      smtp_secure: boolean;
      smtp_user: string | null;
      smtp_password: Masked;
      mail_from: string;
    };
    push: { vapid_public_key: string | null; vapid_private_key: Masked; vapid_subject: string };
    geo: {
      geolite2_db_path: string | null;
      maxmind_account_id: string | null;
      maxmind_license_key: Masked;
      maxmind_endpoint: string;
    };
    billing: {
      stripe_secret_key: Masked;
      stripe_webhook_secret: Masked;
      stripe_return_url: string | null;
    };
    urls: { app_url: string; marketing_url: string };
    support: { support_website_key: string | null };
    ops: {
      discord_webhook_url: Masked;
      sentry_dsn: string | null;
      retention_days: number;
      platform_session_ttl_hours: number;
    };
  };
}

type Draft = Record<string, string | number | boolean>;

export function Settings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');

  const { data, error, isPending } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/platform/settings'),
  });

  const save = useMutation({
    mutationFn: (patch: Draft) => api('/platform/settings', { method: 'PATCH', body: patch }),
    onSuccess: async () => {
      setDraft({});
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const testEmail = useMutation({
    mutationFn: () =>
      api<{ ok: true; via: string }>('/platform/settings/test-email', {
        method: 'POST',
        body: { to: testTo },
      }),
  });

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  const s = data.settings;
  const canWrite = loadSession()?.user.can_write ?? false;
  const dirty = Object.keys(draft).length > 0;

  const set = (field: string, value: string | number | boolean) =>
    setDraft((d) => ({ ...d, [field]: value }));

  /** A plain field: the stored value, editable. */
  const text = (field: string, current: string | number | null, placeholder = '') => (
    <input
      className={inputClass}
      disabled={!canWrite}
      placeholder={placeholder}
      value={String(draft[field] ?? current ?? '')}
      onChange={(e) => set(field, e.target.value)}
    />
  );

  /** A secret: never shown, blank means "leave it", with an explicit Clear. */
  const secret = (field: string, masked: Masked) => (
    <div className="flex items-center gap-2">
      <input
        type="password"
        autoComplete="new-password"
        className={inputClass}
        disabled={!canWrite}
        placeholder={masked.set ? `configured ${masked.hint ?? ''} — leave blank to keep` : 'not set'}
        value={String(draft[field] ?? '')}
        onChange={(e) => set(field, e.target.value)}
      />
      {masked.set && canWrite && (
        <Button
          variant="default"
          onClick={() => {
            if (confirm('Clear this value? Anything depending on it stops working immediately.')) {
              save.mutate({ [field]: '' });
            }
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <Card
        title="Install settings"
        action={
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-green-700">Saved</span>}
            <Button disabled={!canWrite || !dirty || save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : dirty ? `Save ${Object.keys(draft).length} change(s)` : 'Save'}
            </Button>
          </div>
        }
      >
        {!canWrite && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">
            This session is read-only. Only a superadmin with a verified TOTP factor can change
            install settings.
          </p>
        )}
        <p className="text-xs text-gray-500">
          These take effect immediately — no restart. A value left blank falls back to the matching
          environment variable, and then to a built-in default.
        </p>
        <p className="mt-2">
          {s.encryption_enabled ? (
            <Badge tone="ok">Secrets encrypted at rest</Badge>
          ) : (
            <Badge tone="warn">
              Secrets stored in plain text — set SETTINGS_KEY to encrypt them
            </Badge>
          )}
        </p>
        {save.error ? <div className="mt-3"><ErrorBox error={save.error} /></div> : null}
      </Card>

      <Card title="AI">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider" hint="Used for every workspace; usage is metered per workspace.">
            <select
              className={inputClass}
              disabled={!canWrite}
              value={String(draft.ai_provider ?? s.ai.provider)}
              onChange={(e) => set('ai_provider', e.target.value)}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (self-hosted)</option>
              <option value="knowledge_base">Knowledge base only (no model)</option>
            </select>
          </Field>
          <Field label="Model">{text('ai_model', s.ai.model)}</Field>
          <Field label="Anthropic API key">{secret('anthropic_api_key', s.ai.anthropic_api_key)}</Field>
          <Field label="OpenAI API key">{secret('openai_api_key', s.ai.openai_api_key)}</Field>
          <Field label="Ollama URL">{text('ollama_url', s.ai.ollama_url, 'http://ollama:11434')}</Field>
        </div>
      </Card>

      <Card
        title="Email"
        action={
          canWrite && (
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} w-56`}
                placeholder="send a test to…"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
              <Button
                variant="default"
                disabled={!testTo || testEmail.isPending}
                onClick={() => testEmail.mutate()}
              >
                {testEmail.isPending ? 'Sending…' : 'Test'}
              </Button>
            </div>
          )
        }
      >
        {testEmail.isSuccess && (
          <p className="text-xs text-green-700 mb-2">Sent via {testEmail.data.via}.</p>
        )}
        {testEmail.error ? <div className="mb-2"><ErrorBox error={testEmail.error} /></div> : null}
        <p className="text-xs text-gray-500 mb-3">
          Without an SMTP host, mail is queued to <code>outbound_emails</code> and logged rather than
          sent. Nothing is lost, but nobody receives a verification link.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SMTP host">{text('smtp_host', s.mail.smtp_host, 'smtp.postmarkapp.com')}</Field>
          <Field label="Port">{text('smtp_port', s.mail.smtp_port)}</Field>
          <Field label="Username">{text('smtp_user', s.mail.smtp_user)}</Field>
          <Field label="Password">{secret('smtp_password', s.mail.smtp_password)}</Field>
          <Field label="From address">{text('mail_from', s.mail.mail_from)}</Field>
          <Field label="TLS" hint="On for port 465; off for 587 with STARTTLS.">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!canWrite}
                checked={Boolean(draft.smtp_secure ?? s.mail.smtp_secure)}
                onChange={(e) => set('smtp_secure', e.target.checked)}
              />
              Use TLS directly
            </label>
          </Field>
        </div>
      </Card>

      <Card title="Billing">
        <p className="text-xs text-gray-500 mb-3">
          Without a Stripe key, plans and limits still apply — they are database facts. Only checkout
          and the billing portal are disabled.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stripe secret key">{secret('stripe_secret_key', s.billing.stripe_secret_key)}</Field>
          <Field label="Webhook signing secret">
            {secret('stripe_webhook_secret', s.billing.stripe_webhook_secret)}
          </Field>
          <Field label="Checkout return URL" hint="Defaults to the app URL below.">
            {text('stripe_return_url', s.billing.stripe_return_url)}
          </Field>
        </div>
      </Card>

      <Card title="Web Push">
        <p className="text-xs text-gray-500 mb-3">
          Generate a keypair with <code>cd server &amp;&amp; npm run vapid</code>. Changing it
          invalidates every existing push subscription.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Public key" hint="Public by definition — the app ships it to every browser.">
            {text('vapid_public_key', s.push.vapid_public_key)}
          </Field>
          <Field label="Private key">{secret('vapid_private_key', s.push.vapid_private_key)}</Field>
          <Field label="Contact URI">{text('vapid_subject', s.push.vapid_subject)}</Field>
        </div>
      </Card>

      <Card title="IP geolocation">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Local GeoLite2 path" hint="Offline. Leave blank to use the web service.">
            {text('geolite2_db_path', s.geo.geolite2_db_path, '/data/geoip/GeoLite2-City.mmdb')}
          </Field>
          <Field label="MaxMind account id">{text('maxmind_account_id', s.geo.maxmind_account_id)}</Field>
          <Field label="MaxMind licence key">{secret('maxmind_license_key', s.geo.maxmind_license_key)}</Field>
          <Field label="Endpoint">{text('maxmind_endpoint', s.geo.maxmind_endpoint)}</Field>
        </div>
      </Card>

      <Card title="Our own support chat">
        <p className="text-xs text-gray-500 mb-3">
          Nestled runs Nestled. Paste the embed key of a website in one of your own
          workspaces and it appears on the marketing site and inside the customer panel —
          in the panel it carries a signed workspace, plan and role, so an agent is not
          spending three messages working out which account is asking.
        </p>
        <p className="text-xs text-gray-500 mb-3">
          Leave it blank to serve no support chat anywhere. That is the right setting for a
          self-hosted install: those operators are not your customers.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Support website key"
            hint="Its allowed_domains must include your own app, ops and marketing hosts, or the widget stays hidden on them."
          >
            {text('support_website_key', s.support.support_website_key, 'nst_…')}
          </Field>
        </div>
      </Card>

      <Card title="URLs and operations">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="App URL" hint="Every link in outbound email is built from this.">
            {text('app_url', s.urls.app_url)}
          </Field>
          <Field label="Marketing URL">{text('marketing_url', s.urls.marketing_url)}</Field>
          <Field label="Discord webhook" hint="An install-wide fallback; workspaces set their own.">
            {secret('discord_webhook_url', s.ops.discord_webhook_url)}
          </Field>
          <Field label="Sentry DSN">{text('sentry_dsn', s.ops.sentry_dsn)}</Field>
          <Field label="Retention override (days)" hint="0 = use each workspace's plan.">
            {text('retention_days', s.ops.retention_days)}
          </Field>
          <Field label="Staff session length (hours)">
            {text('platform_session_ttl_hours', s.ops.platform_session_ttl_hours)}
          </Field>
        </div>
      </Card>
    </div>
  );
}
