import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { SearchResponse } from '../types';
import { Badge, Card, Empty, ErrorBox, Spinner, Table, Td } from '../ui';

/**
 * The full-page form of the search, for the case the dropdown does not serve: a
 * result set worth reading rather than jumping through, and a URL worth pasting
 * into a ticket.
 */
export function SearchResults() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';

  const { data, error, isPending } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchResponse>(`/platform/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });

  if (q.length < 2) return <Empty>Type at least two characters into the box above.</Empty>;
  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  return (
    <Card
      title={`Results for “${q}”`}
      action={<span className="text-xs text-gray-500">read as {data.interpretedAs.replace('_', ' ')}</span>}
    >
      {data.results.length === 0 ? (
        <Empty>Nothing matched.</Empty>
      ) : (
        <Table head={['Type', 'Result', 'Workspace', 'Matched on']}>
          {data.results.map((r) => (
            <tr key={`${r.kind}:${r.id}:${r.matched}`}>
              <Td>
                <Badge tone="accent">{r.kind}</Badge>
              </Td>
              <Td>
                {r.workspaceId ? (
                  <Link
                    to={`/ops/workspaces/${r.kind === 'workspace' ? r.id : r.workspaceId}`}
                    className="text-blue-300 hover:underline"
                  >
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
                <span className="block text-xs text-gray-500">{r.sublabel}</span>
              </Td>
              <Td className="text-gray-400">{r.workspaceName ?? '—'}</Td>
              <Td className="text-gray-500">{r.matched}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
