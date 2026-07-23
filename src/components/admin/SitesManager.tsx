import { useEffect, useState } from 'react';
import { Plus, Trash2, Globe2, Pencil, Palette, Check } from 'lucide-react';
import {
  listSites,
  createSite,
  updateSite,
  deleteSite,
  listQuickActions,
  listSiteDomains,
  type Site,
  type SiteInput,
  type QuickActionDef,
  type SiteDomain,
  type SitePreChatField,
} from '../../lib/adminApi';
import { ManagePage, PageHeader, Card, PrimaryButton, EmptyState, Field, TextInput, TextArea, Select, Toggle, Badge } from './ui';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function emptySite(): SiteInput {
  return {
    key: '',
    name: '',
    is_active: true,
    primary_color: null,
    widget_title: null,
    welcome_message: null,
    widget_position: null,
    system_prompt: null,
    pre_chat_enabled: null,
    pre_chat_fields: [],
    quick_actions: [],
    allowed_domains: [],
    enforce_domains: false,
    context_secret: null,
  };
}
function toInput(s: Site): SiteInput {
  const { id: _id, ...rest } = s;
  return { ...rest, quick_actions: [...(s.quick_actions ?? [])] };
}

export function SitesManager({ onBack }: { onBack: () => void }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [catalog, setCatalog] = useState<QuickActionDef[]>([]);
  const [domains, setDomains] = useState<SiteDomain[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: SiteInput } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const catalogOrder = catalog.map((c) => c.key);

  const load = () => listSites().then(setSites).catch(() => undefined);
  useEffect(() => {
    void load();
    listQuickActions().then(setCatalog).catch(() => undefined);
    listSiteDomains().then(setDomains).catch(() => undefined);
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

        {/* Pre-chat form */}
        <Card className="p-5 sm:p-6 space-y-4">
          <h3 className="font-semibold text-gray-800">Pre-chat form</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Ask the visitor for details (name, email, phone…) before the chat starts. Answers are attached
            to the conversation so agents see them.
          </p>
          <Field label="Behaviour">
            <Select
              value={inp.pre_chat_enabled === null ? 'inherit' : inp.pre_chat_enabled ? 'custom' : 'off'}
              onChange={(e) => {
                const v = e.target.value;
                set({ pre_chat_enabled: v === 'inherit' ? null : v === 'custom' });
              }}
            >
              <option value="inherit">Inherit global setting</option>
              <option value="off">Don't ask</option>
              <option value="custom">Ask these fields</option>
            </Select>
          </Field>
          {inp.pre_chat_enabled === true && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Fields</span>
                <button
                  type="button"
                  onClick={() => set({ pre_chat_fields: [...inp.pre_chat_fields, { name: '', label: '', type: 'text', required: true, placeholder: '' }] })}
                  className="inline-flex items-center gap-1 rounded-full bg-white border border-gray-200 px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-50"
                >
                  <Plus className="w-4 h-4" /> Add field
                </button>
              </div>
              {inp.pre_chat_fields.length === 0 && <p className="text-sm text-gray-400">No fields yet.</p>}
              {inp.pre_chat_fields.map((f, i) => {
                const setF = (p: Partial<SitePreChatField>) =>
                  set({ pre_chat_fields: inp.pre_chat_fields.map((x, idx) => (idx === i ? { ...x, ...p } : x)) });
                return (
                  <div key={i} className="rounded-2xl border border-gray-200 p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <TextInput placeholder="name (email)" className="!py-2 font-mono max-w-[150px]" value={f.name}
                        onChange={(e) => setF({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
                      <TextInput placeholder="Label (Email address)" className="!py-2 flex-1" value={f.label} onChange={(e) => setF({ label: e.target.value })} />
                      <button type="button" onClick={() => set({ pre_chat_fields: inp.pre_chat_fields.filter((_, idx) => idx !== i) })}
                        className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg" aria-label="Remove field">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select className="!py-2 max-w-[120px]" value={f.type} onChange={(e) => setF({ type: e.target.value as SitePreChatField['type'] })}>
                        <option value="text">Text</option>
                        <option value="email">Email</option>
                        <option value="tel">Phone</option>
                      </Select>
                      <TextInput placeholder="Placeholder" className="!py-2 flex-1" value={f.placeholder} onChange={(e) => setF({ placeholder: e.target.value })} />
                      <button type="button" onClick={() => setF({ required: !f.required })}
                        className={`shrink-0 rounded-full px-2.5 py-1.5 text-[11px] font-semibold ${f.required ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                        {f.required ? 'required' : 'optional'}
                      </button>
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-gray-400">
                Tip: name a field <code className="font-mono">visitor_name</code> or <code className="font-mono">visitor_email</code> to
                fill the conversation's name/email; others are saved as visitor details.
              </p>
            </div>
          )}
        </Card>

        {/* AI */}
        <Card className="p-5 sm:p-6 space-y-5">
          <h3 className="font-semibold text-gray-800">AI system prompt</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Overrides the global system prompt for conversations on this site — set the assistant's tone,
            role and boundaries per site. Leave blank to use the global one (Settings &amp; AI).
          </p>
          <Field label="System prompt">
            <TextArea
              rows={5}
              placeholder="e.g. You are TryJet's support assistant. Be concise and technical…"
              value={inp.system_prompt ?? ''}
              onChange={(e) => set({ system_prompt: e.target.value || null })}
            />
          </Field>
        </Card>

        {/* Allowed domains */}
        <Card className="p-5 sm:p-6 space-y-5">
          <h3 className="font-semibold text-gray-800">Allowed domains</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Which domains may embed this site's widget — one per line (e.g. <code className="font-mono">tryjet.io</code>,{' '}
            <code className="font-mono">*.tryjet.io</code>). A bare domain also covers its subdomains. Leave blank to
            allow anywhere. Either way, every domain the widget loads on is recorded below.
          </p>
          <Field label="Domains">
            <TextArea
              rows={3}
              placeholder={'tryjet.io\napp.tryjet.io'}
              value={inp.allowed_domains.join('\n')}
              onChange={(e) => set({ allowed_domains: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Toggle
            checked={inp.enforce_domains}
            onChange={(v) => set({ enforce_domains: v })}
            label="Block unlisted domains"
            description="Hide the widget entirely on domains that aren't in the list."
          />
          {editing.id && (
            (() => {
              const seen = domains.filter((d) => d.site_key === inp.key);
              return (
                <div className="rounded-2xl bg-canvas/60 border border-gray-100 p-4">
                  <p className="text-[11px] font-bold tracking-wider text-gray-500 mb-2">SEEN ON THESE DOMAINS</p>
                  {seen.length === 0 ? (
                    <p className="text-sm text-gray-400">No loads recorded yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {seen.map((d) => (
                        <li key={d.id} className="flex items-center gap-2 text-sm">
                          <span className="font-mono text-gray-700 truncate flex-1">{d.host}</span>
                          <span className="text-[11px] text-gray-400 shrink-0">{d.hits}× · {timeAgo(d.last_seen)}</span>
                          <Badge tone={d.authorized ? 'green' : 'red'}>{d.authorized ? 'allowed' : 'unlisted'}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()
          )}
        </Card>

        {/* Signed visitor context */}
        <Card className="p-5 sm:p-6 space-y-4">
          <h3 className="font-semibold text-gray-800">Signed visitor context</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Let this site pass <b>trusted</b> customer &amp; order data into the chat. The host server signs
            a JWT with this shared secret; we verify it, so the data can't be spoofed from the browser.
            Paste the same secret into your site's integration. Leave blank to disable.
          </p>
          <Field label="Shared secret (HMAC)">
            <div className="flex gap-2">
              <TextInput
                type="text"
                placeholder="e.g. a long random string"
                value={inp.context_secret ?? ''}
                onChange={(e) => set({ context_secret: e.target.value || null })}
              />
              <button
                type="button"
                onClick={() => {
                  const bytes = new Uint8Array(24);
                  crypto.getRandomValues(bytes);
                  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
                  set({ context_secret: secret });
                }}
                className="shrink-0 px-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Generate
              </button>
            </div>
          </Field>
          <p className="text-[11px] text-gray-400">
            Keep it secret — anyone with it can assert customer identity to your chat.
          </p>
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
                  {s.system_prompt && <Badge tone="green">custom AI</Badge>}
                  {(() => {
                    const unlisted = domains.filter((d) => d.site_key === s.key && !d.authorized).length;
                    return unlisted > 0 ? <Badge tone="red">⚠ {unlisted} unlisted domain{unlisted === 1 ? '' : 's'}</Badge> : null;
                  })()}
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
