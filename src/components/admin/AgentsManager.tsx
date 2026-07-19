import { useEffect, useRef, useState } from 'react';
import { Trash2, Plus, Camera, Users2, ShieldCheck, Mail } from 'lucide-react';
import { listAgents, createAgent, deleteAgent, uploadAgentAvatar, apiBase, type AgentRow } from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, GhostButton, EmptyState, Field, TextInput, Select, Badge, Modal } from './ui';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AgentsManager({ meId, onBack }: { meId: string; onBack: () => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' as 'agent' | 'admin' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
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

  const openForm = () => {
    setForm({ name: '', email: '', password: '', role: 'agent' });
    setError('');
    setShowForm(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await createAgent(form);
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this agent? They will lose access immediately.')) return;
    try {
      await deleteAgent(id);
      await load();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const online = agents.filter((a) => a.is_online).length;

  return (
    <ManagePage>
      <PageHeader
        icon={Users2}
        title="Agents & users"
        subtitle={`${agents.length} ${agents.length === 1 ? 'member' : 'members'} · ${online} online`}
        onBack={onBack}
        action={
          <PrimaryButton onClick={openForm}>
            <Plus className="w-4 h-4" /> Add member
          </PrimaryButton>
        }
      />

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onAvatarFile} />

      {agents.length === 0 ? (
        <EmptyState
          icon={Users2}
          title="No team members yet"
          hint="Add agents to handle conversations, or admins with full access to settings."
          action={
            <PrimaryButton onClick={openForm}>
              <Plus className="w-4 h-4" /> Add member
            </PrimaryButton>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => (
            <Card key={a.id} className="p-4 flex items-center gap-3.5 hover:shadow-md transition">
              <button onClick={() => pickAvatar(a.id)} className="relative shrink-0 group" title="Change avatar">
                {a.avatar_url ? (
                  <img src={`${apiBase()}${a.avatar_url}?v=${ver}`} alt="" className="w-12 h-12 rounded-full object-cover" />
                ) : (
                  <span className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center text-lg font-bold">
                    {a.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                  <Camera className="w-4 h-4 text-white" />
                </span>
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${a.is_online ? 'bg-green-500' : 'bg-gray-300'}`}
                  title={a.is_online ? 'Online' : `Last seen ${timeAgo(a.last_seen)}`}
                />
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="font-semibold text-gray-800 truncate">{a.name}</p>
                  {a.id === meId && <span className="text-xs text-gray-400">(you)</span>}
                </div>
                <p className="text-sm text-gray-500 truncate flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5 shrink-0" /> {a.email}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {a.role === 'admin' ? (
                    <Badge tone="blue">
                      <ShieldCheck className="w-3 h-3" /> Admin
                    </Badge>
                  ) : (
                    <Badge tone="gray">Agent</Badge>
                  )}
                  <span className="text-[11px] text-gray-400">{a.is_online ? 'Online now' : timeAgo(a.last_seen)}</span>
                </div>
              </div>

              {a.id !== meId && (
                <button
                  onClick={() => remove(a.id)}
                  className="shrink-0 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition"
                  aria-label="Delete member"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <Modal
          title="Add a team member"
          onClose={() => setShowForm(false)}
          footer={
            <>
              <GhostButton type="button" onClick={() => setShowForm(false)}>
                Cancel
              </GhostButton>
              <PrimaryButton type="submit" form="agent-form" disabled={saving}>
                {saving ? 'Creating…' : 'Create member'}
              </PrimaryButton>
            </>
          }
        >
          <form id="agent-form" onSubmit={submit} className="space-y-4 pb-2">
            <Field label="Full name">
              <TextInput required placeholder="Jane Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <TextInput required type="email" placeholder="jane@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <TextInput required type="password" minLength={8} placeholder="••••••••" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'agent' | 'admin' })}>
                <option value="agent">Agent — conversations only</option>
                <option value="admin">Admin — full access</option>
              </Select>
            </Field>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </form>
        </Modal>
      )}
    </ManagePage>
  );
}
