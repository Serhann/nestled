import { useEffect, useState } from 'react';
import { Save, Check, Settings, Palette, Bot, Sparkles, KeyRound, Eye } from 'lucide-react';
import {
  getSettings,
  updatePublicSettings,
  updatePrivateSettings,
  getAiUsage,
} from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, Field, TextInput, TextArea, Select, Toggle } from './ui';

type Dict = Record<string, unknown>;

/**
 * Admin settings. Focuses on widget basics + AI config. Secret fields (API
 * keys, webhook) are write-only: the server returns a masked preview and a
 * `*_set` flag; leaving a secret input blank keeps the stored value unchanged.
 */
export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const [pub, setPub] = useState<Dict>({});
  const [priv, setPriv] = useState<Dict>({});
  const [secrets, setSecrets] = useState<Dict>({}); // only what the admin retypes
  const [usage, setUsage] = useState<{ replies: number; input_tokens: number; output_tokens: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setPub(s.public);
        setPriv(s.private);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    getAiUsage().then(setUsage).catch(() => undefined);
  }, []);

  const str = (o: Dict, k: string) => (o[k] as string) ?? '';
  const bool = (o: Dict, k: string) => Boolean(o[k]);

  const save = async () => {
    setSaving(true);
    try {
      await updatePublicSettings({
        widget_title: str(pub, 'widget_title'),
        welcome_message: str(pub, 'welcome_message'),
        primary_color: str(pub, 'primary_color'),
        ai_enabled: bool(pub, 'ai_enabled'),
        magic_browse_enabled: bool(pub, 'magic_browse_enabled'),
      });
      await updatePrivateSettings({
        ai_provider: str(priv, 'ai_provider'),
        ai_model: str(priv, 'ai_model'),
        ai_response_mode: str(priv, 'ai_response_mode'),
        system_prompt: str(priv, 'system_prompt'),
        openai_model: str(priv, 'openai_model'),
        ollama_url: str(priv, 'ollama_url'),
        discord_webhook_enabled: bool(priv, 'discord_webhook_enabled'),
        // Secrets: only send what was retyped; blank = unchanged.
        ...(secrets.anthropic_api_key ? { anthropic_api_key: secrets.anthropic_api_key } : {}),
        ...(secrets.openai_api_key ? { openai_api_key: secrets.openai_api_key } : {}),
        ...(secrets.discord_webhook_url ? { discord_webhook_url: secrets.discord_webhook_url } : {}),
      });
      setSaved(true);
      setSecrets({});
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex-1 grid place-items-center bg-canvas text-gray-400">Loading…</div>;

  const color = str(pub, 'primary_color') || '#c67139';

  return (
    <ManagePage>
      <PageHeader
        icon={Settings}
        title="Settings & AI"
        subtitle="Widget appearance, AI assistant, and usage."
        onBack={onBack}
        action={
          <PrimaryButton onClick={save} disabled={saving}>
            {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? 'Saved' : saving ? 'Saving…' : 'Save changes'}
          </PrimaryButton>
        }
      />

      {/* Widget */}
      <Card className="p-5 sm:p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
            <Palette className="w-4 h-4" />
          </span>
          <h3 className="font-semibold text-gray-800">Widget</h3>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="Widget title">
            <TextInput value={str(pub, 'widget_title')} onChange={(e) => setPub({ ...pub, widget_title: e.target.value })} />
          </Field>
          <Field label="Primary color">
            <div className="flex items-center gap-3">
              <label className="relative w-11 h-11 rounded-xl border border-gray-200 overflow-hidden shrink-0 cursor-pointer" style={{ backgroundColor: color }}>
                <input type="color" value={color} onChange={(e) => setPub({ ...pub, primary_color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
              </label>
              <TextInput value={color} onChange={(e) => setPub({ ...pub, primary_color: e.target.value })} className="font-mono" />
            </div>
          </Field>
        </div>
        <Field label="Welcome message">
          <TextInput value={str(pub, 'welcome_message')} onChange={(e) => setPub({ ...pub, welcome_message: e.target.value })} />
        </Field>
        <div className="rounded-2xl bg-canvas/60 border border-gray-100 divide-y divide-gray-100">
          <div className="p-4">
            <Toggle checked={bool(pub, 'ai_enabled')} onChange={(v) => setPub({ ...pub, ai_enabled: v })} label="Enable AI replies" description="Let the assistant answer when appropriate." />
          </div>
          <div className="p-4">
            <Toggle
              checked={bool(pub, 'magic_browse_enabled')}
              onChange={(v) => setPub({ ...pub, magic_browse_enabled: v })}
              label="Live session replay (MagicBrowse)"
              description="Records visitors' screens with inputs masked. Off by default."
            />
          </div>
        </div>
      </Card>

      {/* AI */}
      <Card className="p-5 sm:p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center">
            <Bot className="w-4 h-4" />
          </span>
          <h3 className="font-semibold text-gray-800">AI assistant</h3>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="Provider">
            <Select value={str(priv, 'ai_provider')} onChange={(e) => setPriv({ ...priv, ai_provider: e.target.value })}>
              <option value="anthropic">Anthropic Claude (recommended)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (self-hosted)</option>
              <option value="knowledge_base">Knowledge base only (no LLM)</option>
            </Select>
          </Field>
          <Field label="Model">
            <TextInput value={str(priv, 'ai_model')} onChange={(e) => setPriv({ ...priv, ai_model: e.target.value })} placeholder="claude-opus-4-8" />
          </Field>
        </div>
        <Field label="Reply mode" hint="When the assistant is allowed to answer.">
          <Select value={str(priv, 'ai_response_mode')} onChange={(e) => setPriv({ ...priv, ai_response_mode: e.target.value })}>
            <option value="off">Off</option>
            <option value="first_message">Greeting only</option>
            <option value="when_no_agent_online">When no agent is online</option>
            <option value="always">Always</option>
          </Select>
        </Field>
        <Field label="System prompt" hint="Sets the assistant's tone and boundaries.">
          <TextArea rows={4} value={str(priv, 'system_prompt')} onChange={(e) => setPriv({ ...priv, system_prompt: e.target.value })} />
        </Field>
        <Field
          label={`Anthropic API key${bool(priv, 'anthropic_api_key_set') ? ' · set' : ''}`}
          hint="Leave blank to keep the stored key."
        >
          <div className="relative">
            <KeyRound className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <TextInput
              type="password"
              className="pl-10"
              placeholder={str(priv, 'anthropic_api_key') || 'sk-ant-…'}
              value={(secrets.anthropic_api_key as string) ?? ''}
              onChange={(e) => setSecrets({ ...secrets, anthropic_api_key: e.target.value })}
            />
          </div>
        </Field>
      </Card>

      {/* Usage */}
      <Card className="p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-green-100 text-green-700 flex items-center justify-center">
            <Sparkles className="w-4 h-4" />
          </span>
          <h3 className="font-semibold text-gray-800">AI usage this month</h3>
        </div>
        {usage ? (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Replies" value={usage.replies} />
            <Stat label="Input tokens" value={usage.input_tokens} />
            <Stat label="Output tokens" value={usage.output_tokens} />
          </div>
        ) : (
          <p className="text-sm text-gray-400 flex items-center gap-1.5">
            <Eye className="w-4 h-4" /> No usage data yet.
          </p>
        )}
      </Card>
    </ManagePage>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-canvas/60 border border-gray-100 p-4 text-center">
      <p className="font-display text-2xl sm:text-3xl text-gray-800 leading-none tabular-nums">{value.toLocaleString()}</p>
      <p className="text-xs text-gray-500 mt-1.5">{label}</p>
    </div>
  );
}
