import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { listKB, createKB, updateKB, deleteKB, type KBItem, type KBInput } from '../../lib/adminApi';

function empty(): KBInput {
  return { question: '', answer: '', category: 'general', keywords: [], priority: 0, is_active: true };
}

/**
 * Knowledge base admin (new backend). Entries feed AI retrieval (top 3–5 by
 * keyword score) and the knowledge_base-only provider.
 */
export function KnowledgeBasePanel({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<KBItem[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: KBInput } | null>(null);
  const [error, setError] = useState('');

  const load = () => listKB().then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    setError('');
    try {
      if (editing.id) await updateKB(editing.id, editing.input);
      else await createKB(editing.input);
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const field = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500';

  if (editing) {
    const inp = editing.input;
    const set = (p: Partial<KBInput>) => setEditing({ ...editing, input: { ...inp, ...p } });
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white z-10">
          <button onClick={() => setEditing(null)} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
          <h2 className="font-semibold text-gray-800">{editing.id ? 'Edit entry' : 'New entry'}</h2>
          <button onClick={save} className="ml-auto bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm">Save</button>
        </div>
        <div className="p-4 space-y-3 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <input className={field} placeholder="Question / title" value={inp.question} onChange={(e) => set({ question: e.target.value })} />
          <textarea className={field} rows={4} placeholder="Answer" value={inp.answer} onChange={(e) => set({ answer: e.target.value })} />
          <input className={field} placeholder="Category" value={inp.category} onChange={(e) => set({ category: e.target.value })} />
          <input className={field} placeholder="Keywords (comma-separated)" value={inp.keywords.join(', ')}
            onChange={(e) => set({ keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-700 flex items-center gap-2">
              Priority
              <input type="number" className="w-20 px-2 py-1 border border-gray-300 rounded" value={inp.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={inp.is_active} onChange={(e) => set({ is_active: e.target.checked })} /> Active
            </label>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white z-10">
        <button onClick={onBack} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-semibold text-gray-800">Knowledge base</h2>
        <button onClick={() => setEditing({ id: null, input: empty() })} className="ml-auto p-1.5 text-blue-600" aria-label="Add"><Plus className="w-5 h-5" /></button>
      </div>
      {items.length === 0 && <p className="p-6 text-center text-gray-400 text-sm">No entries yet.</p>}
      <div className="divide-y divide-gray-50">
        {items.map((k) => (
          <div key={k.id} className="px-4 py-3 flex items-start gap-3">
            <button
              onClick={() =>
                setEditing({
                  id: k.id,
                  input: { question: k.question, answer: k.answer, category: k.category, keywords: k.keywords, priority: k.priority, is_active: k.is_active },
                })
              }
              className="min-w-0 flex-1 text-left"
            >
              <p className="font-medium text-gray-800 truncate">
                {k.question} {!k.is_active && <span className="text-[10px] text-gray-400">(inactive)</span>}
              </p>
              <p className="text-sm text-gray-500 truncate">{k.answer}</p>
              <p className="text-[11px] text-gray-400">{k.category}{k.keywords.length ? ` · ${k.keywords.join(', ')}` : ''}</p>
            </button>
            <button onClick={() => deleteKB(k.id).then(load)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
