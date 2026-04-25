import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Save, Plus, Trash2 } from 'lucide-react';
import type { ChatSettings, PreChatField } from '../../types/chat';

export function SettingsPanel() {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const { data } = await supabase
      .from('chat_settings')
      .select('*')
      .maybeSingle();

    if (data) {
      setSettings(data);
    }
  };

  const handleSave = async () => {
    if (!settings) return;

    setIsSaving(true);
    setMessage('');

    try {
      const { error } = await supabase
        .from('chat_settings')
        .update({
          widget_title: settings.widget_title,
          welcome_message: settings.welcome_message,
          ai_enabled: settings.ai_enabled,
          primary_color: settings.primary_color,
          ai_provider: settings.ai_provider,
          openai_api_key: settings.openai_api_key,
          openai_model: settings.openai_model,
          ollama_url: settings.ollama_url,
          ollama_model: settings.ollama_model,
          system_prompt: settings.system_prompt,
          pre_chat_enabled: settings.pre_chat_enabled,
          pre_chat_fields: settings.pre_chat_fields,
          widget_position: settings.widget_position,
          widget_avatar_url: settings.widget_avatar_url,
          ai_response_mode: settings.ai_response_mode,
          notification_sound_enabled: settings.notification_sound_enabled,
          auto_welcome_enabled: settings.auto_welcome_enabled,
          auto_welcome_message: settings.auto_welcome_message,
          auto_welcome_delay: settings.auto_welcome_delay,
          discord_webhook_url: settings.discord_webhook_url,
          discord_webhook_enabled: settings.discord_webhook_enabled,
          discord_notify_new_chat: settings.discord_notify_new_chat,
          discord_notify_new_message: settings.discord_notify_new_message,
          updated_at: new Date().toISOString()
        })
        .eq('id', settings.id);

      if (error) throw error;

      setMessage('Settings saved successfully!');
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error saving settings:', error);
      setMessage('Error saving settings');
    } finally {
      setIsSaving(false);
    }
  };

  const addPreChatField = () => {
    if (!settings) return;

    const newField: PreChatField = {
      name: `field_${Date.now()}`,
      label: 'New Field',
      type: 'text',
      required: false,
      placeholder: ''
    };

    setSettings({
      ...settings,
      pre_chat_fields: [...(settings.pre_chat_fields || []), newField]
    });
  };

  const updatePreChatField = (index: number, field: PreChatField) => {
    if (!settings) return;

    const newFields = [...settings.pre_chat_fields];
    newFields[index] = field;
    setSettings({ ...settings, pre_chat_fields: newFields });
  };

  const removePreChatField = (index: number) => {
    if (!settings) return;

    const newFields = settings.pre_chat_fields.filter((_, i) => i !== index);
    setSettings({ ...settings, pre_chat_fields: newFields });
  };

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gray-50 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-8">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">Chat Widget Settings</h2>

        <div className="bg-white rounded-lg shadow-sm p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Widget Title
            </label>
            <input
              type="text"
              value={settings.widget_title}
              onChange={(e) => setSettings({ ...settings, widget_title: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Chat with us"
            />
            <p className="text-xs text-gray-500 mt-1">
              This appears at the top of the chat widget
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Welcome Message
            </label>
            <textarea
              value={settings.welcome_message}
              onChange={(e) => setSettings({ ...settings, welcome_message: e.target.value })}
              rows={3}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Hi! How can we help you today?"
            />
            <p className="text-xs text-gray-500 mt-1">
              First message visitors see when opening the chat
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Primary Color
            </label>
            <div className="flex gap-3 items-center">
              <input
                type="color"
                value={settings.primary_color}
                onChange={(e) => setSettings({ ...settings, primary_color: e.target.value })}
                className="h-10 w-20 rounded cursor-pointer"
              />
              <input
                type="text"
                value={settings.primary_color}
                onChange={(e) => setSettings({ ...settings, primary_color: e.target.value })}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="#3B82F6"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Main color for the chat widget
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Widget Position
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value="left"
                  checked={settings.widget_position === 'left'}
                  onChange={(e) => setSettings({ ...settings, widget_position: e.target.value as 'left' | 'right' })}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="text-sm text-gray-700">Left</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value="right"
                  checked={settings.widget_position === 'right'}
                  onChange={(e) => setSettings({ ...settings, widget_position: e.target.value as 'left' | 'right' })}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="text-sm text-gray-700">Right</span>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Choose which side of the screen the widget appears
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Widget Avatar URL
            </label>
            <input
              type="url"
              value={settings.widget_avatar_url || ''}
              onChange={(e) => setSettings({ ...settings, widget_avatar_url: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://example.com/avatar.jpg"
            />
            <p className="text-xs text-gray-500 mt-1">
              Custom avatar image for the chatbot (leave empty to use default icon)
            </p>
            {settings.widget_avatar_url && (
              <div className="mt-2">
                <img
                  src={settings.widget_avatar_url}
                  alt="Widget Avatar Preview"
                  className="w-16 h-16 rounded-full object-cover border-2 border-gray-300"
                  onError={(e) => {
                    e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64"%3E%3Crect width="64" height="64" fill="%23ddd"/%3E%3Ctext x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="%23999"%3EError%3C/text%3E%3C/svg%3E';
                  }}
                />
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.ai_enabled}
                onChange={(e) => setSettings({ ...settings, ai_enabled: e.target.checked })}
                className="w-5 h-5 text-blue-600 rounded"
              />
              <div>
                <span className="text-sm font-medium text-gray-700">
                  Enable AI Responses
                </span>
                <p className="text-xs text-gray-500">
                  Automatically respond to visitors using AI and knowledge base
                </p>
              </div>
            </label>
          </div>

          {settings.ai_enabled && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  AI Response Mode
                </label>
                <select
                  value={settings.ai_response_mode}
                  onChange={(e) => setSettings({ ...settings, ai_response_mode: e.target.value as any })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="first_message">First Message Only (Recommended)</option>
                  <option value="always">Always Respond</option>
                  <option value="off">Never Respond (Manual Only)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Control when the AI assistant responds to messages
                </p>
              </div>
            </>
          )}

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.notification_sound_enabled}
                onChange={(e) => setSettings({ ...settings, notification_sound_enabled: e.target.checked })}
                className="w-5 h-5 text-blue-600 rounded"
              />
              <div>
                <span className="text-sm font-medium text-gray-700">
                  Enable Notification Sounds
                </span>
                <p className="text-xs text-gray-500">
                  Play sound when new messages arrive
                </p>
              </div>
            </label>
          </div>

          {settings.ai_enabled && (
            <>
              <div className="border-t pt-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">AI Configuration</h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      AI Provider
                    </label>
                    <select
                      value={settings.ai_provider}
                      onChange={(e) => setSettings({ ...settings, ai_provider: e.target.value as any })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="knowledge_base">Knowledge Base Only (Free)</option>
                      <option value="openai">OpenAI (GPT-4o-mini, GPT-4, etc.)</option>
                      <option value="ollama">Ollama (Self-hosted)</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Choose how your chatbot generates responses
                    </p>
                  </div>

                  {settings.ai_provider === 'openai' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          OpenAI API Key
                        </label>
                        <input
                          type="password"
                          value={settings.openai_api_key || ''}
                          onChange={(e) => setSettings({ ...settings, openai_api_key: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="sk-..."
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">OpenAI Platform</a>
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          OpenAI Model
                        </label>
                        <select
                          value={settings.openai_model}
                          onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="gpt-4o-mini">GPT-4o-mini (Recommended)</option>
                          <option value="gpt-4o">GPT-4o</option>
                          <option value="gpt-4-turbo">GPT-4 Turbo</option>
                          <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                        </select>
                      </div>
                    </>
                  )}

                  {settings.ai_provider === 'ollama' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Ollama Server URL
                        </label>
                        <input
                          type="text"
                          value={settings.ollama_url || ''}
                          onChange={(e) => setSettings({ ...settings, ollama_url: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="http://localhost:11434"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          URL of your Ollama server
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Ollama Model
                        </label>
                        <input
                          type="text"
                          value={settings.ollama_model}
                          onChange={(e) => setSettings({ ...settings, ollama_model: e.target.value })}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="llama2"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Model name (e.g., llama2, mistral, codellama)
                        </p>
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      System Prompt
                    </label>
                    <textarea
                      value={settings.system_prompt}
                      onChange={(e) => setSettings({ ...settings, system_prompt: e.target.value })}
                      rows={4}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="You are a helpful customer support assistant..."
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Instructions for the AI on how to behave (applies to OpenAI and Ollama)
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="border-t pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Auto-Welcome Message</h3>
                <p className="text-sm text-gray-600">Automatically greet visitors after a delay</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.auto_welcome_enabled}
                  onChange={(e) => setSettings({ ...settings, auto_welcome_enabled: e.target.checked })}
                  className="w-5 h-5 text-blue-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Enable</span>
              </label>
            </div>

            {settings.auto_welcome_enabled && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Welcome Message
                  </label>
                  <textarea
                    value={settings.auto_welcome_message || ''}
                    onChange={(e) => setSettings({ ...settings, auto_welcome_message: e.target.value })}
                    rows={3}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Hi! Need any help? I'm here to assist you."
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    This message will be shown automatically after the specified delay
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Delay (seconds)
                  </label>
                  <input
                    type="number"
                    value={settings.auto_welcome_delay}
                    onChange={(e) => setSettings({ ...settings, auto_welcome_delay: parseInt(e.target.value) || 5 })}
                    min="1"
                    max="60"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    How many seconds to wait before showing the message (1-60 seconds)
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="border-t pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Discord Notifications</h3>
                <p className="text-sm text-gray-600">Get notified in Discord when new chats arrive</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.discord_webhook_enabled}
                  onChange={(e) => setSettings({ ...settings, discord_webhook_enabled: e.target.checked })}
                  className="w-5 h-5 text-blue-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Enable</span>
              </label>
            </div>

            {settings.discord_webhook_enabled && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Discord Webhook URL
                  </label>
                  <input
                    type="url"
                    value={settings.discord_webhook_url || ''}
                    onChange={(e) => setSettings({ ...settings, discord_webhook_url: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="https://discord.com/api/webhooks/..."
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Create a webhook in your Discord server settings → Integrations → Webhooks
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.discord_notify_new_chat}
                      onChange={(e) => setSettings({ ...settings, discord_notify_new_chat: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm text-gray-700">Notify when new chat starts</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.discord_notify_new_message}
                      onChange={(e) => setSettings({ ...settings, discord_notify_new_message: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm text-gray-700">Notify on each new message (can be noisy)</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="border-t pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Pre-Chat Form</h3>
                <p className="text-sm text-gray-600">Collect information before starting the chat</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.pre_chat_enabled}
                  onChange={(e) => setSettings({ ...settings, pre_chat_enabled: e.target.checked })}
                  className="w-5 h-5 text-blue-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Enable</span>
              </label>
            </div>

            {settings.pre_chat_enabled && (
              <div className="space-y-4">
                {settings.pre_chat_fields?.map((field, index) => (
                  <div key={index} className="bg-gray-50 p-4 rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700">Field {index + 1}</span>
                      <button
                        onClick={() => removePreChatField(index)}
                        className="text-red-600 hover:text-red-700 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Field Name (internal)
                        </label>
                        <input
                          type="text"
                          value={field.name}
                          onChange={(e) => updatePreChatField(index, { ...field, name: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="visitor_name"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Label (shown to user)
                        </label>
                        <input
                          type="text"
                          value={field.label}
                          onChange={(e) => updatePreChatField(index, { ...field, label: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="İsim"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Type
                        </label>
                        <select
                          value={field.type}
                          onChange={(e) => updatePreChatField(index, { ...field, type: e.target.value as any })}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="text">Text</option>
                          <option value="email">Email</option>
                          <option value="tel">Phone</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Placeholder
                        </label>
                        <input
                          type="text"
                          value={field.placeholder}
                          onChange={(e) => updatePreChatField(index, { ...field, placeholder: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="Adınız"
                        />
                      </div>
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) => updatePreChatField(index, { ...field, required: e.target.checked })}
                        className="w-4 h-4 text-blue-600 rounded"
                      />
                      <span className="text-sm text-gray-700">Required field</span>
                    </label>
                  </div>
                ))}

                <button
                  onClick={addPreChatField}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-sm font-medium">Add Field</span>
                </button>
              </div>
            )}
          </div>

          {message && (
            <div className={`p-4 rounded-lg ${
              message.includes('Error')
                ? 'bg-red-50 text-red-700'
                : 'bg-green-50 text-green-700'
            }`}>
              {message}
            </div>
          )}

          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-5 h-5" />
            <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>

        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-2">About SUPABASE_ANON_KEY</h3>
          <p className="text-sm text-blue-800">
            The <code className="bg-blue-100 px-2 py-1 rounded">SUPABASE_ANON_KEY</code> is safe to expose publicly.
            It's designed for client-side use and your data is protected by Row Level Security (RLS) policies in the database.
            Real security comes from RLS, not hiding this key.
          </p>
        </div>

        <div className="mt-8 bg-white rounded-lg shadow-sm p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Widget Installation</h3>
          <p className="text-sm text-gray-600 mb-4">
            Add this code to your website to embed the chat widget:
          </p>
          <div className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto">
            <code className="text-sm">
              {`<!-- Chat Widget -->
<script>
  window.CHATBOT_CONFIG = {
    supabaseUrl: "${import.meta.env.VITE_SUPABASE_URL}",
    supabaseKey: "${import.meta.env.VITE_SUPABASE_ANON_KEY}"
  };
</script>
<script src="${window.location.origin}/widget.js"></script>`}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}
