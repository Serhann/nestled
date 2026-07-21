import { useEffect, useState } from 'react';
import { Plus, Trash2, Globe2, Pencil, Palette, Check } from 'lucide-react';
import {
  listSites,
  createSite,
  updateSite,
  deleteSite,
  listQuickActions,
  type Site,
  type SiteInput,
  type QuickActionDef,
} from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, EmptyState, Field, TextInput, Select, Toggle, Badge } from './ui';

function emptySite(): SiteInput {
  return {
    key: '',
    name: '',
    is_active: true,
    primary_color: null,
    widget_title: null,
    welcome_message: null,
    widget_position: null,
    quick_actions: [],
  };
}
function toInput(s: Site): SiteInput {
  const { id: _id, ...rest } = s;
  return { ...rest, quick_actions: [...(s.quick_actions ?? [])] };
}

export function SitesManager({ onBack }: { onBack: () => void }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [catalog, setCatalog] = useState<QuickActionDef[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: SiteInput } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const catalogOrder = catalog.map((c) => c.key);

  const load = () => listSites().then(setSites).catch(() => undefined);
  useEffect(() => {
    void load();
    listQuickActions().then(setCatalog).catch(() => undefined);
  }, []);

  const save = async () => {
    if (!editing) return;
    if (!editing.input.key.trim() || !editing.input.name.trim()) {
      setError('A site key and name are required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (editing.id) await updateSite(editing.id, editing.input);
      else await createSite(editing.input);
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
    const set = (p: Partial<SiteInput>) => setEditing({ ...editing, input: { ...inp, ...p } });
    const color = inp.primary_color || '#c67139';

    const isSel = (intent: string) => inp.quick_actions.some((a) => a.intent === intent);
    const labelOf = (intent: string) => inp.quick_actions.find((a) => a.intent === intent)?.label ?? '';
    const toggle = (intent: string) => {
      const next = isSel(intent)
        ? inp.quick_actions.filter((a) => a.intent !== intent)
        : [...inp.quick_actions, { intent }];
      next.sort((a, b) => catalogOrder.indexOf(a.intent) - catalogOrder.indexOf(b.intent));
      set({ quick_actions: next });
    };
    const setLabel = (intent: string, label: string) =>
      set({ quick_actions: inp.quick_actions.map((a) => (a.intent === intent ? { ...a, label: label || undefined } : a)) });

    return (
      <ManagePage>
        <PageHeader
          icon={Globe2}
          title={editing.id ? `Edit ${inp.name || 'site'}` : 'New site'}
          subtitle="Give this site its own widget look and quick actions."
          onBack={() => setEditing(null)}
          action={
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save site'}
            </PrimaryButton>
          }
        />
        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>}

        {/* Basics */}
        <Card className="p-5 sm:p-6 space-y-5">
          <h3 className="font-semibold text-gray-800">Basics</h3>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Name">
              <TextInput placeholder="TryJet" value={inp.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Site key" hint="Used in the embed as data-mode. Lowercase, dashes.">
              <TextInput
                placeholder="tryjet"
                value={inp.key}
                onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              />
            </Field>
          </div>
          <Toggle checked={inp.is_active} onChange={(v) => set({ is_active: v })} label="Active" description="Inactive sites fall back to the global widget config." />
        </Card>

        {/* Appearance */}
        <Card className="p-5 sm:p-6 space-y-5">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
              <Palette className="w-4 h-4" />
            </span>
            <h3 className="font-semibold text-gray-800">Chat bubble &amp; appearance</h3>
          </div>
          <p className="text-xs text-gray-400 -mt-2">Leave a field blank to inherit the global setting.</p>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Primary color">
              <div className="flex items-center gap-3">
                <label className="relative w-11 h-11 rounded-xl border border-gray-200 overflow-hidden shrink-0 cursor-pointer" style={{ backgroundColor: color }}>
                  <input type="color" value={color} onChange={(e) => set({ primary_color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                </label>
                <TextInput
                  className="font-mono"
                  placeholder="inherit"
                  value={inp.primary_color ?? ''}
                  onChange={(e) => set({ primary_color: e.target.value || null })}
                />
              </div>
            </Field>
            <Field label="Launcher position">
              <Select value={inp.widget_position ?? ''} onChange={(e) => set({ widget_position: (e.target.value || null) as 'left' | 'right' | null })}>
                <option value="">Inherit</option>
                <option value="right">Right</option>
                <option value="left">Left</option>
              </Select>
            </Field>
          </div>
          <Field label="Widget title">
            <TextInput placeholder="Inherit global title" value={inp.widget_title ?? ''} onChange={(e) => set({ widget_title: e.target.value || null })} />
          </Field>
          <Field label="Welcome message">
            <TextInput placeholder="Inherit global welcome" value={inp.welcome_message ?? ''} onChange={(e) => set({ welcome_message: e.target.value || null })} />
          </Field>
        </Card>

        {/* Quick actions */}
        <Card className="p-5 sm:p-6 space-y-4">
          <h3 className="font-semibold text-gray-800">Quick actions</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Pick which quick actions this site's widget shows, and optionally rename them. Manage the
            actions themselves (behaviour, reply text, intake fields) in <b>Quick actions</b>. Leave all
            unchecked to use the built-in set for the key ("food" = order tracking, "saas" = support).
          </p>
          <div className="space-y-2">
            {catalog.length === 0 && <p className="text-sm text-gray-400">No quick actions defined yet.</p>}
            {catalog.map((c) => {
              const on = isSel(c.key);
              return (
                <div key={c.key} className={`rounded-2xl border p-3 transition ${on ? 'border-blue-300 bg-blue-50/50' : 'border-gray-200'}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className={`w-5 h-5 rounded-md border-[1.5px] flex items-center justify-center shrink-0 transition ${on ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300'}`}
                      aria-label={on ? 'Remove' : 'Add'}
                    >
                      {on && <Check className="w-3.5 h-3.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-gray-800">{c.label}</span>
                      <span className="ml-2 text-[11px] text-gray-400 font-mono">{c.key}</span>
                    </div>
                    <Badge tone={c.kind === 'auto' ? 'green' : 'amber'}>{c.kind === 'auto' ? 'auto-reply' : 'to agent'}</Badge>
                    {c.fields.length > 0 && <Badge tone="violet">form</Badge>}
                  </div>
                  {on && (
                    <div className="mt-2 pl-8">
                      <TextInput
                        placeholder={`Button label (default: ${c.label})`}
                        value={labelOf(c.key)}
                        onChange={(e) => setLabel(c.key, e.target.value)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </ManagePage>
    );
  }

  // ── List ──
  return (
    <ManagePage>
      <PageHeader
        icon={Globe2}
        title="Sites"
        subtitle={`${sites.length} site${sites.length === 1 ? '' : 's'} — each with its own widget & quick actions`}
        onBack={onBack}
        action={
          <PrimaryButton onClick={() => setEditing({ id: null, input: emptySite() })}>
            <Plus className="w-4 h-4" /> New site
          </PrimaryButton>
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          icon={Globe2}
          title="No sites yet"
          hint="Add a site for each place you embed the widget, then give it its own look and quick actions."
          action={
            <PrimaryButton onClick={() => setEditing({ id: null, input: emptySite() })}>
              <Plus className="w-4 h-4" /> New site
            </PrimaryButton>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sites.map((s) => (
            <Card key={s.id} className="p-4 flex items-start gap-3 group hover:shadow-md transition">
              <span
                className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 text-white"
                style={{ backgroundColor: s.primary_color || '#c67139' }}
              >
                <Globe2 className="w-5 h-5" />
              </span>
              <button onClick={() => setEditing({ id: s.id, input: toInput(s) })} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-800 truncate">{s.name}</p>
                  {!s.is_active && <Badge tone="gray">Off</Badge>}
                </div>
                <p className="text-xs text-gray-500 font-mono mt-0.5">data-mode="{s.key}"</p>
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  <Badge tone="blue">
                    {s.quick_actions.length > 0 ? `${s.quick_actions.length} quick actions` : 'built-in actions'}
                  </Badge>
                  {(s.widget_title || s.welcome_message || s.primary_color) && <Badge tone="violet">custom look</Badge>}
                </div>
              </button>
              <div className="shrink-0 flex items-center gap-1">
                <button onClick={() => setEditing({ id: s.id, input: toInput(s) })} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition" aria-label="Edit">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => confirm(`Delete site "${s.name}"?`) && deleteSite(s.id).then(load)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" aria-label="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </ManagePage>
  );
}
