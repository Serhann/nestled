import { useEffect, useState } from 'react';
import { ArrowLeft, Save } from 'lucide-react';
import {
  getSettings,
  updatePublicSettings,
  updatePrivateSettings,
  getAiUsage,
} from '../../lib/adminApi';

type Dict = Record<string, unknown>;

/**
 * Admin settings on the new backend (Phase 7). Focuses on widget basics + AI
 * config. Secret fields (API keys, webhook) are write-only: the server returns
 * a masked preview and a `*_set` flag; leaving a secret input blank keeps the
 * stored value unchanged.
 */
export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const [pub, setPub] = useState<Dict>({});
  const [priv, setPriv] = useState<Dict>({});
  const [secrets, setSecrets] = useState<Dict>({}); // only what the admin retypes
  const [usage, setUsage] = useState<{ replies: number; input_tokens: number; output_tokens: number } | null>(null);
  const [saved, setSaved] = useState(false);
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
  };

  if (loading) return <div className="flex-1 p-6 text-center text-gray-400">Loading…</div>;

  const label = 'block text-sm font-medium text-gray-700 mb-1';
  const field = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white z-10">
        <button onClick={onBack} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-semibold text-gray-800">Settings</h2>
        <button onClick={save} className="ml-auto flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm">
          <Save className="w-4 h-4" /> {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      <div className="p-4 space-y-6 max-w-lg">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Widget</h3>
          <div>
            <label className={label}>Widget title</label>
            <input className={field} value={str(pub, 'widget_title')} onChange={(e) => setPub({ ...pub, widget_title: e.target.value })} />
          </div>
          <div>
            <label className={label}>Welcome message</label>
            <input className={field} value={str(pub, 'welcome_message')} onChange={(e) => setPub({ ...pub, welcome_message: e.target.value })} />
          </div>
          <div>
            <label className={label}>Primary color</label>
            <input type="color" value={str(pub, 'primary_color') || '#3B82F6'} onChange={(e) => setPub({ ...pub, primary_color: e.target.value })} className="h-10 w-16 rounded border border-gray-300" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={bool(pub, 'ai_enabled')} onChange={(e) => setPub({ ...pub, ai_enabled: e.target.checked })} />
            Enable AI replies
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={bool(pub, 'magic_browse_enabled')} onChange={(e) => setPub({ ...pub, magic_browse_enabled: e.target.checked })} />
            Live session replay (MagicBrowse)
          </label>
          <p className="text-xs text-gray-400 -mt-1">Records visitors' screens (inputs masked). Off by default.</p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">AI</h3>
          <div>
            <label className={label}>Provider</label>
            <select className={field} value={str(priv, 'ai_provider')} onChange={(e) => setPriv({ ...priv, ai_provider: e.target.value })}>
              <option value="anthropic">Anthropic Claude (recommended)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (self-hosted)</option>
              <option value="knowledge_base">Knowledge base only (no LLM)</option>
            </select>
          </div>
          <div>
            <label className={label}>Model</label>
            <input className={field} value={str(priv, 'ai_model')} onChange={(e) => setPriv({ ...priv, ai_model: e.target.value })} placeholder="claude-opus-4-8" />
          </div>
          <div>
            <label className={label}>Reply mode</label>
            <select className={field} value={str(priv, 'ai_response_mode')} onChange={(e) => setPriv({ ...priv, ai_response_mode: e.target.value })}>
              <option value="off">Off</option>
              <option value="first_message">Greeting only</option>
              <option value="when_no_agent_online">When no agent is online</option>
              <option value="always">Always</option>
            </select>
          </div>
          <div>
            <label className={label}>System prompt</label>
            <textarea rows={4} className={field} value={str(priv, 'system_prompt')} onChange={(e) => setPriv({ ...priv, system_prompt: e.target.value })} />
          </div>
          <div>
            <label className={label}>
              Anthropic API key {bool(priv, 'anthropic_api_key_set') && <span className="text-green-600 text-xs">· set</span>}
            </label>
            <input
              type="password"
              className={field}
              placeholder={str(priv, 'anthropic_api_key') || 'sk-ant-…'}
              value={(secrets.anthropic_api_key as string) ?? ''}
              onChange={(e) => setSecrets({ ...secrets, anthropic_api_key: e.target.value })}
            />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">AI usage this month</h3>
          {usage ? (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Replies" value={usage.replies} />
              <Stat label="Input tokens" value={usage.input_tokens} />
              <Stat label="Output tokens" value={usage.output_tokens} />
            </div>
          ) : (
            <p className="text-sm text-gray-400">No usage data.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm">
      <p className="text-lg font-semibold text-gray-800">{value.toLocaleString()}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}
