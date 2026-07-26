import { useEffect, useState } from 'react';
import { Plus, Trash2, BookOpen, Pencil, Tag } from 'lucide-react';
import { listKB, createKB, updateKB, deleteKB, type KBItem, type KBInput } from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, EmptyState, Field, TextInput, TextArea, Toggle, Badge, SiteScope, siteScopeLabel } from './ui';

function empty(): KBInput {
  return { question: '', answer: '', category: 'general', keywords: [], priority: 0, is_active: true, sites: [] };
}

/**
 * Knowledge base admin. Entries feed AI retrieval (top 3–5 by keyword score)
 * and the knowledge_base-only provider.
 */
export function KnowledgeBasePanel({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<KBItem[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: KBInput } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => listKB().then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    if (!editing.input.question.trim() || !editing.input.answer.trim()) {
      setError('A question and an answer are both required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (editing.id) await updateKB(editing.id, editing.input);
      else await createKB(editing.input);
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
    const set = (p: Partial<KBInput>) => setEditing({ ...editing, input: { ...inp, ...p } });
    return (
      <ManagePage>
        <PageHeader
          icon={BookOpen}
          title={editing.id ? 'Edit entry' : 'New entry'}
          subtitle="Teach the AI how to answer a common question."
          onBack={() => setEditing(null)}
          action={
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save entry'}
            </PrimaryButton>
          }
        />
        <Card className="p-5 sm:p-6 space-y-5">
          {error && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>}
          <Field label="Question / title" hint="What the visitor might ask.">
            <TextInput placeholder="What are your opening hours?" value={inp.question} onChange={(e) => set({ question: e.target.value })} />
          </Field>
          <Field label="Answer" hint="Written the way the assistant should reply.">
            <TextArea rows={5} placeholder="We're open every day from 10am to 11pm." value={inp.answer} onChange={(e) => set({ answer: e.target.value })} />
          </Field>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Category">
              <TextInput placeholder="general" value={inp.category} onChange={(e) => set({ category: e.target.value })} />
            </Field>
            <Field label="Priority" hint="Higher wins ties in retrieval.">
              <TextInput type="number" value={inp.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Keywords" hint="Comma-separated — boosts matching for these terms.">
            <TextInput
              placeholder="hours, open, closing time"
              value={inp.keywords.join(', ')}
              onChange={(e) => set({ keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <SiteScope value={inp.sites} onChange={(v) => set({ sites: v })} />
          <div className="pt-1 border-t border-gray-100">
            <div className="pt-4">
              <Toggle checked={inp.is_active} onChange={(v) => set({ is_active: v })} label="Active" description="Inactive entries are ignored by the assistant." />
            </div>
          </div>
        </Card>
      </ManagePage>
    );
  }

  // ── List ──
  return (
    <ManagePage>
      <PageHeader
        icon={BookOpen}
        title="Knowledge base"
        subtitle={`${items.length} ${items.length === 1 ? 'entry' : 'entries'} feeding the AI assistant`}
        onBack={onBack}
        action={
          <PrimaryButton onClick={() => setEditing({ id: null, input: empty() })}>
            <Plus className="w-4 h-4" /> New entry
          </PrimaryButton>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No knowledge yet"
          hint="Add entries so the AI can answer common questions instantly — opening hours, pricing, refund policy, and more."
          action={
            <PrimaryButton onClick={() => setEditing({ id: null, input: empty() })}>
              <Plus className="w-4 h-4" /> New entry
            </PrimaryButton>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((k) => (
            <Card key={k.id} className="p-4 flex items-start gap-3 group hover:shadow-md transition">
              <button
                onClick={() => setEditing({ id: k.id, input: { question: k.question, answer: k.answer, category: k.category, keywords: k.keywords, priority: k.priority, is_active: k.is_active, sites: k.sites } })}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-800">{k.question}</p>
                  {!k.is_active && <Badge tone="gray">Inactive</Badge>}
                  {k.priority > 0 && <Badge tone="amber">Priority {k.priority}</Badge>}
                </div>
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{k.answer}</p>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Badge tone="blue">{k.category}</Badge>
                  <Badge tone={k.sites.length ? 'violet' : 'gray'}>{siteScopeLabel(k.sites)}</Badge>
                  {k.keywords.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                      <Tag className="w-3 h-3" /> {k.keywords.join(', ')}
                    </span>
                  )}
                </div>
              </button>
              <div className="shrink-0 flex items-center gap-1">
                <button
                  onClick={() => setEditing({ id: k.id, input: { question: k.question, answer: k.answer, category: k.category, keywords: k.keywords, priority: k.priority, is_active: k.is_active, sites: k.sites } })}
                  className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition"
                  aria-label="Edit"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => confirm('Delete this entry?') && deleteKB(k.id).then(load)}
                  className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition"
                  aria-label="Delete"
                >
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
