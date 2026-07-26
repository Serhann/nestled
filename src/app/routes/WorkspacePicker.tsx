import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { useSession } from '../providers/SessionProvider';
import { Card } from '../../ui/Card';
import { Page, PageHeader } from '../../ui/Page';

/**
 * For the agency case: one login, several customers. Listing the open-conversation
 * count here is what makes it a useful screen rather than a menu — it answers
 * "which of my clients needs me right now" before anything is clicked.
 */
export default function WorkspacePicker() {
  const { me } = useSession();

  return (
    <Page>
      <PageHeader title="Your workspaces" subtitle="Pick one to get to work." />
      <div className="grid gap-3 sm:grid-cols-2">
        {me.workspaces.map((w) => (
          <Link key={w.id} to={`/w/${w.slug}/inbox`} className="block">
            <Card className="p-5 hover:shadow transition">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 shrink-0 rounded-2xl bg-blue-600 text-white font-display text-xl flex items-center justify-center">
                  {w.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 truncate">{w.name}</p>
                  <p className="text-xs text-gray-500 capitalize">
                    {w.role} · {w.plan.name}
                  </p>
                </div>
                {w.counts.open_conversations > 0 && (
                  <span className="text-xs font-semibold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                    {w.counts.open_conversations} open
                  </span>
                )}
              </div>
            </Card>
          </Link>
        ))}

        <Link to="/workspaces/new" className="block">
          <Card className="p-5 border-dashed hover:shadow transition h-full flex items-center gap-3 text-gray-500">
            <span className="w-10 h-10 shrink-0 rounded-2xl bg-gray-100 flex items-center justify-center">
              <Plus className="w-5 h-5" aria-hidden />
            </span>
            <span className="font-semibold">New workspace</span>
          </Card>
        </Link>
      </div>
    </Page>
  );
}
