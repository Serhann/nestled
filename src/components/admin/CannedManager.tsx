import { useEffect, useState } from 'react';
import { Trash2, Plus, MessageSquareText, Zap } from 'lucide-react';
import { listCanned, createCanned, deleteCanned, type CannedResponse } from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, GhostButton, EmptyState, Field, TextInput, TextArea, Modal, SiteScope, siteScopeLabel, Badge } from './ui';

export function CannedManager({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ shortcut: string; title: string; content: string; sites: string[] }>({ shortcut: '', title: '', content: '', sites: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => listCanned().then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const openForm = () => {
    setForm({ shortcut: '', title: '', content: '', sites: [] });
    setError('');
    setShowForm(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await createCanned(form);
      setShowForm(false);
      await load();
    } catch {
      setError('Could not save — that shortcut may already exist.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ManagePage>
      <PageHeader
        icon={MessageSquareText}
        title="Canned responses"
        subtitle="Reusable replies agents insert by typing / in the composer."
        onBack={onBack}
        action={
          <PrimaryButton onClick={openForm}>
            <Plus className="w-4 h-4" /> New response
          </PrimaryButton>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No canned responses yet"
          hint={
            <>
              Save replies you send often. Agents insert them mid-chat by typing{' '}
              <code className="px-1 py-0.5 bg-gray-100 rounded text-blue-700 font-mono text-xs">/shortcut</code>.
            </>
          }
          action={
            <PrimaryButton onClick={openForm}>
              <Plus className="w-4 h-4" /> New response
            </PrimaryButton>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((c) => (
            <Card key={c.id} className="p-4 flex flex-col group hover:shadow-md transition">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-700 px-2.5 py-1 text-xs font-mono font-semibold">
                  <Zap className="w-3 h-3" />/{c.shortcut}
                </span>
                <span className="font-semibold text-gray-800 truncate">{c.title}</span>
                <button
                  onClick={() => confirm('Delete this response?') && deleteCanned(c.id).then(load)}
                  className="ml-auto shrink-0 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition opacity-0 group-hover:opacity-100"
                  aria-label="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-2 line-clamp-3 whitespace-pre-wrap">{c.content}</p>
              <div className="mt-2">
                <Badge tone={c.sites.length ? 'violet' : 'gray'}>{siteScopeLabel(c.sites)}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showForm && (
        <Modal
          title="New canned response"
          onClose={() => setShowForm(false)}
          footer={
            <>
              <GhostButton type="button" onClick={() => setShowForm(false)}>
                Cancel
              </GhostButton>
              <PrimaryButton type="submit" form="canned-form" disabled={saving}>
                {saving ? 'Saving…' : 'Save response'}
              </PrimaryButton>
            </>
          }
        >
          <form id="canned-form" onSubmit={submit} className="space-y-4 pb-2">
            <Field label="Shortcut" hint="Agents type / followed by this to insert the reply.">
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 font-mono">/</span>
                <TextInput
                  required
                  placeholder="hours"
                  className="pl-7"
                  value={form.shortcut}
                  onChange={(e) => setForm({ ...form, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                />
              </div>
            </Field>
            <Field label="Title" hint="Shown in the agent's shortcut menu.">
              <TextInput required placeholder="Opening hours" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Response text">
              <TextArea required rows={4} placeholder="We're open every day from 10am to 11pm 🍽️" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </Field>
            <SiteScope value={form.sites} onChange={(v) => setForm({ ...form, sites: v })} />
            {error && <p className="text-sm text-red-500">{error}</p>}
          </form>
        </Modal>
      )}
    </ManagePage>
  );
}
