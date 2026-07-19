import { useEffect, useState } from 'react';
import { Plus, Trash2, Zap, Clock, MousePointerClick, MapPin, Play, MessageCircle, Volume2, Pencil } from 'lucide-react';
import {
  listTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  type TriggerFull,
  type TriggerInput,
} from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, EmptyState, Field, TextInput, TextArea, Toggle, Badge } from './ui';

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

/** Section block inside the editor — a titled sub-card. */
function EditSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-800">{title}</h3>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

export function TriggersPanel({ onBack }: { onBack: () => void }) {
  const [triggers, setTriggers] = useState<TriggerFull[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: TriggerInput } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => listTriggers().then(setTriggers).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    if (!editing.input.name.trim()) {
      setError('Give your trigger a name.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (editing.id) await updateTrigger(editing.id, editing.input);
      else await createTrigger(editing.input);
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ── Editor ──
  if (editing) {
    const inp = editing.input;
    const set = (patch: Partial<TriggerInput>) => setEditing({ ...editing, input: { ...inp, ...patch } });
    return (
      <ManagePage>
        <PageHeader
          icon={Zap}
          title={editing.id ? 'Edit trigger' : 'New trigger'}
          subtitle="Reach out proactively based on what a visitor does."
          onBack={() => setEditing(null)}
          action={
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save trigger'}
            </PrimaryButton>
          }
        />

        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>}

        <EditSection title="Basics">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Name">
              <TextInput placeholder="Exit-intent offer" value={inp.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Identifier" hint="a-z, 0-9, dashes.">
              <TextInput
                placeholder="exit-offer"
                value={inp.identifier}
                onChange={(e) => set({ identifier: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-4 pt-1">
            <Toggle checked={inp.is_active} onChange={(v) => set({ is_active: v })} label="Active" description="Turn the trigger on or off." />
            <Field label="Priority">
              <TextInput type="number" className="w-24" value={inp.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
            </Field>
          </div>
        </EditSection>

        <EditSection title="When it fires" hint="Any enabled condition can start the trigger.">
          <Toggle
            checked={inp.events.after_delay}
            onChange={(v) => set({ events: { ...inp.events, after_delay: v } })}
            label="After a delay"
            description="Fire once the visitor has stayed a while."
          />
          {inp.events.after_delay && (
            <Field label="Delay (seconds)">
              <TextInput type="number" className="w-28" value={inp.events.delay_seconds} onChange={(e) => set({ events: { ...inp.events, delay_seconds: Number(e.target.value) } })} />
            </Field>
          )}
          <div className="border-t border-gray-100 pt-4">
            <Toggle checked={inp.events.on_leave_intent} onChange={(v) => set({ events: { ...inp.events, on_leave_intent: v } })} label="On exit intent" description="When the cursor leaves toward the tab bar." />
          </div>
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <Toggle checked={inp.events.on_pages} onChange={(v) => set({ events: { ...inp.events, on_pages: v } })} label="On specific pages" description="Only on matching URLs." />
            {inp.events.on_pages && (
              <Field label="URL patterns" hint="Comma-separated, supports * wildcards.">
                <TextInput placeholder="/pricing, /checkout*" value={inp.events.page_urls.join(', ')} onChange={(e) => set({ events: { ...inp.events, page_urls: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
              </Field>
            )}
          </div>
        </EditSection>

        <EditSection title="What it does">
          <Toggle checked={inp.actions.open_chatbox} onChange={(v) => set({ actions: { ...inp.actions, open_chatbox: v } })} label="Open the chat" description="Pop the widget open automatically." />
          <div className="border-t border-gray-100 pt-4">
            <Toggle checked={inp.actions.play_sound} onChange={(v) => set({ actions: { ...inp.actions, play_sound: v } })} label="Play a sound" description="Chime to draw attention." />
          </div>
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <Toggle checked={inp.actions.show_message} onChange={(v) => set({ actions: { ...inp.actions, show_message: v } })} label="Show a message" description="Display a proactive bubble." />
            {inp.actions.show_message && (
              <Field label="Message">
                <TextArea rows={2} placeholder="Need a hand finding something? 👋" value={inp.actions.message_content ?? ''} onChange={(e) => set({ actions: { ...inp.actions, message_content: e.target.value } })} />
              </Field>
            )}
          </div>
        </EditSection>

        <EditSection title="Rules & targeting">
          <Toggle checked={inp.behaviors.execute_if_online} onChange={(v) => set({ behaviors: { ...inp.behaviors, execute_if_online: v } })} label="Only when an agent is online" />
          <div className="border-t border-gray-100 pt-4">
            <Toggle checked={inp.behaviors.execute_on_first_visit} onChange={(v) => set({ behaviors: { ...inp.behaviors, execute_on_first_visit: v } })} label="First-time visitors only" />
          </div>
          <div className="border-t border-gray-100 pt-4">
            <Field label="Countries" hint="Comma-separated ISO codes (e.g. US, CA). Blank = everywhere.">
              <TextInput placeholder="US, CA, TR" value={inp.behaviors.country_restriction.join(', ')} onChange={(e) => set({ behaviors: { ...inp.behaviors, country_restriction: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) } })} />
            </Field>
          </div>
          <div className="border-t border-gray-100 pt-4 flex gap-8">
            <Toggle checked={inp.platforms.desktop_enabled} onChange={(v) => set({ platforms: { ...inp.platforms, desktop_enabled: v } })} label="Desktop" />
            <Toggle checked={inp.platforms.mobile_enabled} onChange={(v) => set({ platforms: { ...inp.platforms, mobile_enabled: v } })} label="Mobile" />
          </div>
        </EditSection>
      </ManagePage>
    );
  }

  // ── List ──
  const activeCount = triggers.filter((t) => t.is_active).length;
  return (
    <ManagePage>
      <PageHeader
        icon={Zap}
        title="Triggers"
        subtitle={`${triggers.length} total · ${activeCount} active`}
        onBack={onBack}
        action={
          <PrimaryButton onClick={() => setEditing({ id: null, input: emptyTrigger() })}>
            <Plus className="w-4 h-4" /> New trigger
          </PrimaryButton>
        }
      />

      {triggers.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No triggers yet"
          hint="Automatically greet visitors, offer help on exit intent, or open the chat on key pages."
          action={
            <PrimaryButton onClick={() => setEditing({ id: null, input: emptyTrigger() })}>
              <Plus className="w-4 h-4" /> New trigger
            </PrimaryButton>
          }
        />
      ) : (
        <div className="space-y-3">
          {triggers.map((t) => {
            const ev = (t.events ?? {}) as TriggerInput['events'];
            const ac = (t.actions ?? {}) as TriggerInput['actions'];
            const conv = t.fire_count > 0 ? Math.round((t.conversation_count / t.fire_count) * 100) : 0;
            return (
              <Card key={t.id} className="p-4 flex items-center gap-4 group hover:shadow-md transition">
                <span
                  className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${t.is_active ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'}`}
                >
                  <Zap className="w-5 h-5" />
                </span>
                <button onClick={() => setEditing({ id: t.id, input: toInput(t) })} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-gray-800 truncate">{t.name || t.identifier}</p>
                    {t.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Off</Badge>}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
                    {ev.after_delay && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {ev.delay_seconds}s
                      </span>
                    )}
                    {ev.on_leave_intent && (
                      <span className="inline-flex items-center gap-1">
                        <MousePointerClick className="w-3 h-3" /> Exit intent
                      </span>
                    )}
                    {ev.on_pages && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> Pages
                      </span>
                    )}
                    {ac.open_chatbox && (
                      <span className="inline-flex items-center gap-1">
                        <Play className="w-3 h-3" /> Opens chat
                      </span>
                    )}
                    {ac.show_message && (
                      <span className="inline-flex items-center gap-1">
                        <MessageCircle className="w-3 h-3" /> Message
                      </span>
                    )}
                    {ac.play_sound && (
                      <span className="inline-flex items-center gap-1">
                        <Volume2 className="w-3 h-3" /> Sound
                      </span>
                    )}
                  </div>
                </button>
                <div className="hidden sm:flex flex-col items-end shrink-0 pr-1">
                  <p className="font-display text-2xl text-gray-800 leading-none tabular-nums">{t.fire_count}</p>
                  <p className="text-[11px] text-gray-400">fired · {conv}% conv.</p>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <button onClick={() => setEditing({ id: t.id, input: toInput(t) })} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition" aria-label="Edit">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => confirm('Delete this trigger?') && deleteTrigger(t.id).then(load)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" aria-label="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </ManagePage>
  );
}
