import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Trash2, Plus, Camera } from 'lucide-react';
import { listAgents, createAgent, deleteAgent, uploadAgentAvatar, apiBase, type AgentRow } from '../../lib/adminApi';

export function AgentsManager({ meId, onBack }: { meId: string; onBack: () => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' as 'agent' | 'admin' });
  const [error, setError] = useState('');
  const [ver, setVer] = useState(0); // cache-buster for re-uploaded avatars
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingId = useRef<string | null>(null);

  const load = () => listAgents().then(setAgents).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const pickAvatar = (id: string) => {
    pendingId.current = id;
    fileRef.current?.click();
  };
  const onAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pendingId.current) return;
    try {
      await uploadAgentAvatar(pendingId.current, file);
      await load();
      setVer((v) => v + 1);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await createAgent(form);
      setForm({ name: '', email: '', password: '', role: 'agent' });
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this agent?')) return;
    try {
      await deleteAgent(id);
      await load();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100 sticky top-0 bg-white">
        <button onClick={onBack} className="p-1 -ml-1 text-gray-600"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-semibold text-gray-800">Agents</h2>
        <button onClick={() => setShowForm((s) => !s)} className="ml-auto p-1.5 text-blue-600" aria-label="Add agent">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="p-4 space-y-2 border-b border-gray-100 bg-gray-50">
          <input required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <input required type="password" minLength={8} placeholder="Password (min 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'agent' | 'admin' })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="agent">Agent (conversations only)</option>
            <option value="admin">Admin (full access)</option>
          </select>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">Create agent</button>
        </form>
      )}

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onAvatarFile} />
      <div className="divide-y divide-gray-50">
        {agents.map((a) => (
          <div key={a.id} className="px-4 py-3 flex items-center gap-3">
            <button
              onClick={() => pickAvatar(a.id)}
              className="relative shrink-0 group"
              title="Change avatar"
            >
              {a.avatar_url ? (
                <img src={`${apiBase()}${a.avatar_url}?v=${ver}`} alt="" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <span className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center font-semibold">
                  {a.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="absolute -bottom-0.5 -right-0.5 bg-white rounded-full p-0.5 shadow border border-gray-100">
                <Camera className="w-3 h-3 text-gray-500" />
              </span>
              <span
                className={`absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${a.is_online ? 'bg-green-500' : 'bg-gray-300'}`}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-800 truncate">{a.name} {a.id === meId && <span className="text-xs text-gray-400">(you)</span>}</p>
              <p className="text-sm text-gray-500 truncate">{a.email} · {a.role}</p>
            </div>
            {a.id !== meId && (
              <button onClick={() => remove(a.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" aria-label="Delete">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
