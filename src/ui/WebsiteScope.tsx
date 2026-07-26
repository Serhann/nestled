import type { Website } from '../lib/api/types';

/**
 * "Which websites does this apply to?" — an empty array means every website in
 * the workspace.
 *
 * The old version fetched its own options and kept a module-level map of site
 * names, which meant labels resolved differently depending on what had loaded
 * first. Options are a prop now: the page that already has the website list
 * passes it down, and there is one source of truth for the names.
 */
export function WebsiteScope({
  websites,
  value,
  onChange,
  label = 'Apply to websites',
}: {
  websites: Pick<Website, 'id' | 'name'>[];
  /** Website ids; empty means all. */
  value: string[];
  onChange: (value: string[]) => void;
  label?: string;
}) {
  const all = value.length === 0;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div>
      <span className="block text-sm font-semibold text-gray-700 mb-1.5">{label}</span>
      <div className="flex flex-wrap gap-2">
        <Chip active={all} onClick={() => onChange([])}>
          All websites
        </Chip>
        {websites.map((site) => (
          <Chip key={site.id} active={value.includes(site.id)} onClick={() => toggle(site.id)}>
            {site.name}
          </Chip>
        ))}
      </div>
      <span className="block text-xs text-gray-400 mt-1">
        {all ? 'Shown on every website.' : `Only on: ${scopeLabel(websites, value)}.`}
      </span>
    </div>
  );
}

export function scopeLabel(websites: Pick<Website, 'id' | 'name'>[], ids: string[] | null): string {
  if (!ids || ids.length === 0) return 'All websites';
  return ids.map((id) => websites.find((w) => w.id === id)?.name ?? 'Unknown').join(', ');
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border-[1.5px] px-3.5 py-1.5 text-sm font-semibold transition ${
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700'
          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}
