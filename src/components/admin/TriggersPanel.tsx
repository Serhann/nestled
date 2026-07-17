import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2, Zap } from 'lucide-react';
import {
  listTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  type TriggerFull,
  type TriggerInput,
} from '../../lib/adminApi';

function emptyTrigger(): TriggerInput {
  return {
    name: '',
    identifier: '',
    is_active: true,
    priority: 0,
    actions: { show_message: true, message_content: '', localized_messages: {}, open_chatbox: false, play_sound: false },
    events: {
      on_leave_intent: false,
      on_click_link: false,
      click_selectors: [],
      on_pages: false,
      page_urls: [],
      on_url_parameters: false,
      url_parameters: {},
      after_delay: true,
      delay_seconds: 10,
    },
    behaviors: {
      show_as_website: false,
      execute_if_online: false,
      execute_on_first_visit: false,
      execute_if_no_other_trigger: false,
      country_restriction: [],
    },
    platforms: { desktop_enabled: true, mobile_enabled: true },
  };
}

function toInput(t: TriggerFull): TriggerInput {
  const e = emptyTrigger();
  return {
    name: t.name,
    identifier: t.identifier,
    is_active: t.is_active,
    priority: t.priority,
    actions: { ...e.actions, ...(t.actions as object) },
    events: { ...e.events, ...(t.events as object) },
    behaviors: { ...e.behaviors, ...(t.behaviors as object) },
    platforms: { ...e.platforms, ...(t.platforms as object) },
  };
}

export function TriggersPanel({ onBack }: { onBack: () => void }) {
  const [triggers, setTriggers] = useState<TriggerFull[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: TriggerInput } | null>(null);
  const [error, setError] = useState('');

  const load = () => listTriggers().then(setTriggers).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    setError('');
    try {
      if (editing.id) await updateTrigger(editing.id, editing.input);
      else await createTrigger(editing.input);
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const field = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500';
  const check = (v: boolean, on: () => void, label: string) => (
    <label className="flex items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" checked={v} onChange={on} /> {label}
    </label>
  );

  // ── Editor ──
  if (editing) {
    const inp = editing.input;
    const set = (patch: Partial<TriggerInput>) => setEditing({ ...editing, input: { ...inp, ...patch } });
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white z-10">
          <button onClick={() => setEditing(null)} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
          <h2 className="font-semibold text-gray-800">{editing.id ? 'Edit trigger' : 'New trigger'}</h2>
          <button onClick={save} className="ml-auto bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm">Save</button>
        </div>
        <div className="p-4 space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <input className={field} placeholder="Name" value={inp.name} onChange={(e) => set({ name: e.target.value })} />
          <input className={field} placeholder="identifier (a-z0-9-)" value={inp.identifier}
            onChange={(e) => set({ identifier: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
          <div className="flex items-center gap-4">
            {check(inp.is_active, () => set({ is_active: !inp.is_active }), 'Active')}
            <label className="text-sm text-gray-700 flex items-center gap-2">
              Priority
              <input type="number" className="w-20 px-2 py-1 border border-gray-300 rounded" value={inp.priority}
                onChange={(e) => set({ priority: Number(e.target.value) })} />
            </label>
          </div>

          <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
            <legend className="text-xs font-semibold text-gray-500 px-1">WHEN (events)</legend>
            {check(inp.events.after_delay, () => set({ events: { ...inp.events, after_delay: !inp.events.after_delay } }), 'After a delay')}
            {inp.events.after_delay && (
              <input type="number" className={field} placeholder="Delay (seconds)" value={inp.events.delay_seconds}
                onChange={(e) => set({ events: { ...inp.events, delay_seconds: Number(e.target.value) } })} />
            )}
            {check(inp.events.on_leave_intent, () => set({ events: { ...inp.events, on_leave_intent: !inp.events.on_leave_intent } }), 'On exit intent')}
            {check(inp.events.on_pages, () => set({ events: { ...inp.events, on_pages: !inp.events.on_pages } }), 'On specific pages')}
            {inp.events.on_pages && (
              <input className={field} placeholder="URL patterns, comma-separated (supports *)"
                value={inp.events.page_urls.join(', ')}
                onChange={(e) => set({ events: { ...inp.events, page_urls: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
            )}
          </fieldset>

          <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
            <legend className="text-xs font-semibold text-gray-500 px-1">DO (actions)</legend>
            {check(inp.actions.open_chatbox, () => set({ actions: { ...inp.actions, open_chatbox: !inp.actions.open_chatbox } }), 'Open the chat')}
            {check(inp.actions.play_sound, () => set({ actions: { ...inp.actions, play_sound: !inp.actions.play_sound } }), 'Play a sound')}
            {check(inp.actions.show_message, () => set({ actions: { ...inp.actions, show_message: !inp.actions.show_message } }), 'Show a message')}
            {inp.actions.show_message && (
              <textarea className={field} rows={2} placeholder="Message" value={inp.actions.message_content ?? ''}
                onChange={(e) => set({ actions: { ...inp.actions, message_content: e.target.value } })} />
            )}
          </fieldset>

          <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
            <legend className="text-xs font-semibold text-gray-500 px-1">RULES</legend>
            {check(inp.behaviors.execute_if_online, () => set({ behaviors: { ...inp.behaviors, execute_if_online: !inp.behaviors.execute_if_online } }), 'Only when an agent is online')}
            {check(inp.behaviors.execute_on_first_visit, () => set({ behaviors: { ...inp.behaviors, execute_on_first_visit: !inp.behaviors.execute_on_first_visit } }), 'First-time visitors only')}
            <input className={field} placeholder="Country codes, comma-separated (e.g. US, CA) — blank = all"
              value={inp.behaviors.country_restriction.join(', ')}
              onChange={(e) => set({ behaviors: { ...inp.behaviors, country_restriction: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) } })} />
            <div className="flex gap-4">
              {check(inp.platforms.desktop_enabled, () => set({ platforms: { ...inp.platforms, desktop_enabled: !inp.platforms.desktop_enabled } }), 'Desktop')}
              {check(inp.platforms.mobile_enabled, () => set({ platforms: { ...inp.platforms, mobile_enabled: !inp.platforms.mobile_enabled } }), 'Mobile')}
            </div>
          </fieldset>
        </div>
      </div>
    );
  }

  // ── List ──
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white z-10">
        <button onClick={onBack} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-semibold text-gray-800">Triggers</h2>
        <button onClick={() => setEditing({ id: null, input: emptyTrigger() })} className="ml-auto p-1.5 text-blue-600" aria-label="Add">
          <Plus className="w-5 h-5" />
        </button>
      </div>
      {triggers.length === 0 && <p className="p-6 text-center text-gray-400 text-sm">No triggers yet.</p>}
      <div className="divide-y divide-gray-50">
        {triggers.map((t) => (
          <div key={t.id} className="px-4 py-3 flex items-center gap-3">
            <Zap className={`w-4 h-4 ${t.is_active ? 'text-amber-500' : 'text-gray-300'}`} />
            <button onClick={() => setEditing({ id: t.id, input: toInput(t) })} className="min-w-0 flex-1 text-left">
              <p className="font-medium text-gray-800 truncate">{t.name || t.identifier}</p>
              <p className="text-xs text-gray-500">
                fired {t.fire_count} · {t.conversation_count} chats
                {t.fire_count > 0 && ` · ${Math.round((t.conversation_count / t.fire_count) * 100)}% conv.`}
              </p>
            </button>
            <button onClick={() => deleteTrigger(t.id).then(load)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" aria-label="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
