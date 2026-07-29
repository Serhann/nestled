import { useMemo, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { useWebsiteSettings } from './WebsiteLayout';
import { Section } from '../../../ui/Card';
import { TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';

/**
 * Every visitor-facing string, editable.
 *
 * Only overrides are stored. That is what lets us keep improving the default
 * wording and have it reach every customer who never touched that particular
 * line — the alternative, copying the whole set into each website row on
 * creation, freezes today's phrasing forever.
 *
 * The reset button therefore does not write a "default value"; it deletes the
 * override.
 */

const GROUPS: { title: string; prefix: string[] }[] = [
  { title: 'Launcher and header', prefix: ['launcher', 'header'] },
  { title: 'Greeting and starters', prefix: ['greeting', 'welcome', 'starter'] },
  { title: 'Composer', prefix: ['composer', 'send', 'attach'] },
  { title: 'Pre-chat form', prefix: ['preChat'] },
  { title: 'When you are offline', prefix: ['offline'] },
  { title: 'Rating', prefix: ['rating'] },
  { title: 'Closing a chat', prefix: ['closeConfirm', 'resolved'] },
  { title: 'Everything else', prefix: [] },
];

export default function CopyEditor() {
  const { data, save } = useWebsiteSettings();
  const defaults = data.copy_defaults;
  const overrides = data.settings.copy ?? {};
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);

  const grouped = useMemo(() => {
    const keys = Object.keys(defaults).filter((key) => {
      if (onlyChanged && overrides[key] === undefined) return false;
      if (!search) return true;
      const needle = search.toLowerCase();
      return key.toLowerCase().includes(needle) || defaults[key]!.toLowerCase().includes(needle);
    });

    const used = new Set<string>();
    return GROUPS.map((group) => {
      const matched = keys.filter((key) => {
        if (used.has(key)) return false;
        const hit = group.prefix.length === 0 || group.prefix.some((p) => key.startsWith(p));
        if (hit) used.add(key);
        return hit;
      });
      return { ...group, keys: matched };
    }).filter((g) => g.keys.length > 0);
  }, [defaults, overrides, search, onlyChanged]);

  const setOverride = (key: string, value: string) => {
    const next = { ...overrides };
    // An empty box means "use the default", which is a deletion, not an empty
    // string — otherwise the widget renders nothing at all in that slot.
    if (value.trim() === '') delete next[key];
    else next[key] = value;
    save({ copy: next });
  };

  const changedCount = Object.keys(overrides).length;

  return (
    <div className="space-y-4">
      <Section
        title="Wording"
        description="Blank means we use our default. Changes are live as soon as you type."
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden />
            <TextInput
              className="pl-9"
              placeholder="Search wording"
              aria-label="Search wording"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Toggle checked={onlyChanged} onChange={setOnlyChanged} />
          <span className="text-xs text-gray-500">
            Only what I changed{changedCount > 0 ? ` (${changedCount})` : ''}
          </span>
        </div>
      </Section>

      {grouped.map((group) => (
        <Section key={group.title} title={group.title}>
          <div className="space-y-2">
            {group.keys.map((key) => {
              const overridden = overrides[key] !== undefined;
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-xs text-gray-500 truncate" title={key}>
                    {humanise(key)}
                  </span>
                  <TextInput
                    aria-label={humanise(key)}
                    value={overrides[key] ?? ''}
                    placeholder={defaults[key]}
                    onChange={(e) => setOverride(key, e.target.value)}
                    className={overridden ? 'border-blue-300' : ''}
                  />
                  <button
                    onClick={() => setOverride(key, '')}
                    disabled={!overridden}
                    aria-label={`Reset ${humanise(key)}`}
                    className="p-2 text-gray-300 hover:text-gray-600 disabled:opacity-30 disabled:hover:text-gray-300"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
