import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { SearchResponse, SearchResult } from './types';
import { Badge, Spinner } from './ui';

/**
 * The one input.
 *
 * It sits in the shell rather than on a page because that is the difference between
 * a feature and a habit: a support agent with a ticket open should be able to paste
 * whatever fact they have and hit Enter without navigating anywhere first. `/`
 * focuses it from any page, for the same reason.
 *
 * The server decides what the input IS (services/platform/search.ts). The client's
 * only job is to show that decision back — "read as: domain" — so a wrong guess is
 * visible and correctable rather than mysterious.
 */

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  workspace: 'Workspace',
  user: 'User',
  website: 'Website',
  conversation: 'Conversation',
  person: 'Person',
  invoice: 'Invoice',
};

const INTERPRETATION_LABEL: Record<SearchResponse['interpretedAs'], string> = {
  email: 'email address',
  website_key: 'widget key',
  domain: 'domain',
  uuid: 'id',
  text: 'free text',
};

/** Where a result leads. Everything ultimately lands on a workspace. */
function hrefFor(result: SearchResult): string {
  if (result.kind === 'workspace') return `/ops/workspaces/${result.id}`;
  if (result.workspaceId) {
    const tab =
      result.kind === 'website'
        ? 'websites'
        : result.kind === 'conversation'
          ? 'conversations'
          : result.kind === 'invoice'
            ? 'plan'
            : 'overview';
    return `/ops/workspaces/${result.workspaceId}?tab=${tab}&highlight=${result.id}`;
  }
  // A user with no membership has nowhere better to go than the search itself.
  return `/ops/search?q=${encodeURIComponent(result.label)}`;
}

export function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 180);
    return () => clearTimeout(timer);
  }, [term]);

  // `/` focuses the box from anywhere, unless the user is already typing into a
  // field — a shortcut that eats a slash mid-sentence is a shortcut people disable.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<SearchResponse>(`/platform/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 15_000,
  });

  const results = data?.results ?? [];

  function go(result: SearchResult) {
    setOpen(false);
    setTerm('');
    navigate(hrefFor(result));
  }

  return (
    <div className="relative w-full max-w-xl">
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length > 0) go(results[0]!);
        }}
        placeholder="Email, domain, nst_ key, or any id  —  press /"
        className="w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
      />

      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-700 px-3 py-1.5 text-xs text-gray-500">
            <span>
              read as <span className="text-gray-300">{INTERPRETATION_LABEL[data?.interpretedAs ?? 'text']}</span>
            </span>
            {isFetching && <span>searching…</span>}
          </div>

          {isFetching && !data && <Spinner />}

          {data && results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-gray-500">
              Nothing matched. A {INTERPRETATION_LABEL[data.interpretedAs]} that returns nothing usually means the
              customer is on a different install.
            </p>
          )}

          {results.map((result) => (
            <button
              key={`${result.kind}:${result.id}:${result.matched}`}
              type="button"
              onClick={() => go(result)}
              className="flex w-full items-start justify-between gap-3 border-b border-gray-800 px-3 py-2 text-left last:border-b-0 hover:bg-gray-700/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-gray-100">{result.label}</span>
                <span className="block truncate text-xs text-gray-500">
                  {result.sublabel}
                  {result.workspaceName && result.kind !== 'workspace' && ` · ${result.workspaceName}`}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone="accent">{KIND_LABEL[result.kind]}</Badge>
                {/* Why this row matched. Two results with the same name are common;
                    "configured domain" vs "observed loading" is the whole answer. */}
                <span className="text-[11px] text-gray-500">{result.matched}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
