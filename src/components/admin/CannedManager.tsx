import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, Plus } from 'lucide-react';
import { listCanned, createCanned, deleteCanned, type CannedResponse } from '../../lib/adminApi';

export function CannedManager({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ shortcut: '', title: '', content: '' });
  const [error, setError] = useState('');

  const load = () => listCanned().then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await createCanned(form);
      setForm({ shortcut: '', title: '', content: '' });
      setShowForm(false);
      await load();
    } catch {
      setError('Could not save (shortcut may already exist).');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white">
        <button onClick={onBack} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-semibold text-gray-800">Canned responses</h2>
        <button onClick={() => setShowForm((s) => !s)} className="ml-auto p-1.5 text-blue-600" aria-label="Add">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="p-4 space-y-2 border-b border-gray-100 bg-gray-50">
          <input
            required
            placeholder="shortcut (e.g. hours)"
            value={form.shortcut}
            onChange={(e) => setForm({ ...form, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input required placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <textarea required rows={3} placeholder="Response text" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Save</button>
        </form>
      )}

      <div className="divide-y divide-gray-50">
        {items.length === 0 && <p className="p-6 text-center text-gray-400 text-sm">No canned responses yet. Agents insert these by typing <code>/shortcut</code>.</p>}
        {items.map((c) => (
          <div key={c.id} className="px-4 py-3 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm"><span className="font-medium text-blue-600">/{c.shortcut}</span> <span className="text-gray-500">{c.title}</span></p>
              <p className="text-sm text-gray-500 truncate">{c.content}</p>
            </div>
            <button onClick={() => deleteCanned(c.id).then(load)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" aria-label="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
