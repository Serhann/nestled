import { useEffect, useState } from 'react';
import { Plus, Trash2, Zap, Pencil, GripVertical } from 'lucide-react';
import {
  listQuickActions,
  createQuickAction,
  updateQuickAction,
  deleteQuickAction,
  type QuickActionDef,
  type QuickActionInput,
  type QuickActionField,
} from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, GhostButton, EmptyState, Field, TextInput, TextArea, Select, Toggle, Badge } from './ui';

function empty(): QuickActionInput {
  return {
    key: '',
    label: '',
    kind: 'human',
    visitor_template: '',
    reply_template: '',
    suggestion: null,
    fields: [],
    priority: 0,
    is_active: true,
  };
}
function toInput(a: QuickActionDef): QuickActionInput {
  const { id: _id, ...rest } = a;
  return { ...rest, fields: [...(a.fields ?? [])] };
}

const PLACEHOLDERS = '{order} {status} {eta} {restaurant} {restaurant_clause} {eta_clause} {eta_paren} {order_about}';

export function QuickActionsManager({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<QuickActionDef[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: QuickActionInput } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => listQuickActions().then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    const { key, label } = editing.input;
    if (!key.trim() || !label.trim()) {
      setError('A key and a label are required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (editing.id) await updateQuickAction(editing.id, editing.input);
      else await createQuickAction(editing.input);
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
    const set = (p: Partial<QuickActionInput>) => setEditing({ ...editing, input: { ...inp, ...p } });
    const setField = (i: number, p: Partial<QuickActionField>) =>
      set({ fields: inp.fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
    const addField = () => set({ fields: [...inp.fields, { name: '', label: '', required: true }] });
    const removeField = (i: number) => set({ fields: inp.fields.filter((_, idx) => idx !== i) });

    return (
      <ManagePage>
        <PageHeader
          icon={Zap}
          title={editing.id ? `Edit ${inp.label || 'quick action'}` : 'New quick action'}
          subtitle="Define the button, its behaviour, and the messages it sends."
          onBack={() => setEditing(null)}
          action={
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save action'}
            </PrimaryButton>
          }
        />
        {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>}

        <Card className="p-5 sm:p-6 space-y-5">
          <h3 className="font-semibold text-gray-800">Basics</h3>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Button label">
              <TextInput placeholder="Where's my order?" value={inp.label} onChange={(e) => set({ label: e.target.value })} />
            </Field>
            <Field label="Key" hint="Unique id. Lowercase, numbers, underscore.">
              <TextInput
                placeholder="where"
                value={inp.key}
                onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
              />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Behaviour">
              <Select value={inp.kind} onChange={(e) => set({ kind: e.target.value as 'auto' | 'human' })}>
                <option value="auto">Auto-reply (bot answers, no human)</option>
                <option value="human">Connect to an agent (escalate)</option>
              </Select>
            </Field>
            <Field label="Priority" hint="Lower shows first.">
              <TextInput type="number" value={inp.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
            </Field>
          </div>
          <Toggle checked={inp.is_active} onChange={(v) => set({ is_active: v })} label="Active" description="Inactive actions are never shown." />
        </Card>

        <Card className="p-5 sm:p-6 space-y-5">
          <h3 className="font-semibold text-gray-800">Messages</h3>
          <p className="text-xs text-gray-400 -mt-2">
            Placeholders you can use: <code className="font-mono text-blue-700">{PLACEHOLDERS}</code> and any field name (e.g.{' '}
            <code className="font-mono text-blue-700">{'{store}'}</code>).
          </p>
          <p className="text-xs text-gray-400 -mt-3">
            A reply using any order placeholder counts as order-only: the button is hidden while the
            visitor has no order, and if it runs anyway the bot asks for the order number instead of
            describing a status.
          </p>
          <Field label="Visitor message" hint="Sent as the visitor's message when they tap the button.">
            <TextArea rows={2} placeholder="Where is my order {order}?" value={inp.visitor_template} onChange={(e) => set({ visitor_template: e.target.value })} />
          </Field>
          <Field label="Bot reply" hint={inp.kind === 'auto' ? 'The answer shown instantly.' : 'The holding message before an agent joins.'}>
            <TextArea rows={3} placeholder="Your order {order} is {status}…" value={inp.reply_template} onChange={(e) => set({ reply_template: e.target.value })} />
          </Field>
          {inp.kind === 'human' && (
            <Field label="Handoff suggestion" hint="Shown to the agent in the bot-summary card.">
              <TextInput placeholder="Confirm the missing item and refund or re-send it." value={inp.suggestion ?? ''} onChange={(e) => set({ suggestion: e.target.value || null })} />
            </Field>
          )}
        </Card>

        <Card className="p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-800">Intake form</h3>
            <GhostButton type="button" onClick={addField} className="!px-3 !py-1.5">
              <Plus className="w-4 h-4" /> Add field
            </GhostButton>
          </div>
          <p className="text-xs text-gray-500 -mt-2">
            Fields the visitor fills in before this action runs (e.g. store &amp; state). Reference them in the
            messages by name, like <code className="font-mono text-blue-700">{'{store}'}</code>.
          </p>
          {inp.fields.length === 0 ? (
            <p className="text-sm text-gray-400">No fields — the action runs immediately.</p>
          ) : (
            <div className="space-y-2">
              {inp.fields.map((f, i) => (
                <div key={i} className="flex items-center gap-2 rounded-2xl border border-gray-200 p-2.5">
                  <GripVertical className="w-4 h-4 text-gray-300 shrink-0" />
                  <TextInput
                    placeholder="name (store)"
                    className="!py-2 font-mono max-w-[150px]"
                    value={f.name}
                    onChange={(e) => setField(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                  />
                  <TextInput placeholder="Label (Store name)" className="!py-2 flex-1" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <button
                    type="button"
                    onClick={() => setField(i, { required: !f.required })}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${f.required ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}
                  >
                    {f.required ? 'required' : 'optional'}
                  </button>
                  <button type="button" onClick={() => removeField(i)} className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg" aria-label="Remove field">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </ManagePage>
    );
  }

  // ── List ──
  return (
    <ManagePage>
      <PageHeader
        icon={Zap}
        title="Quick actions"
        subtitle={`${items.length} action${items.length === 1 ? '' : 's'} — assign them to sites under Sites`}
        onBack={onBack}
        action={
          <PrimaryButton onClick={() => setEditing({ id: null, input: empty() })}>
            <Plus className="w-4 h-4" /> New action
          </PrimaryButton>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No quick actions yet"
          hint="Create reusable buttons the widget shows — instant answers or escalations to an agent."
          action={
            <PrimaryButton onClick={() => setEditing({ id: null, input: empty() })}>
              <Plus className="w-4 h-4" /> New action
            </PrimaryButton>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <Card key={a.id} className="p-4 flex items-center gap-3 group hover:shadow-md transition">
              <button onClick={() => setEditing({ id: a.id, input: toInput(a) })} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-800">{a.label}</p>
                  <span className="text-[11px] font-mono text-gray-400">{a.key}</span>
                  {!a.is_active && <Badge tone="gray">Off</Badge>}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  <Badge tone={a.kind === 'auto' ? 'green' : 'amber'}>{a.kind === 'auto' ? 'auto-reply' : 'to agent'}</Badge>
                  {a.fields.length > 0 && <Badge tone="violet">{a.fields.length}-field form</Badge>}
                  <span className="text-xs text-gray-400 truncate max-w-md">{a.reply_template}</span>
                </div>
              </button>
              <div className="shrink-0 flex items-center gap-1">
                <button onClick={() => setEditing({ id: a.id, input: toInput(a) })} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition" aria-label="Edit">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => confirm(`Delete "${a.label}"?`) && deleteQuickAction(a.id).then(load)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" aria-label="Delete">
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
