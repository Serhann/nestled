import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, Globe, MessageCirclePlus, Users } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { listPresence, startChat } from '../../../lib/api/inbox';
import { LiveViewer } from './LiveViewer';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Badge } from '../../../ui/Badge';
import { Modal } from '../../../ui/Modal';
import { TextArea } from '../../../ui/Form';
import { EmptyState, ErrorState, Page, PageHeader, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { relative } from '../inbox/ConversationList';
import type { PresenceVisitor } from '../../../lib/api/types';

/**
 * Who is on the site right now.
 *
 * The list is pushed over the socket — RealtimeProvider writes `presence:list`
 * straight into this query's cache — so the initial fetch is a cold start rather
 * than a poll.
 */
export default function Visitors() {
  const { workspace, can, plan } = useWorkspace();
  const [reachingOut, setReachingOut] = useState<PresenceVisitor | null>(null);
  const [watching, setWatching] = useState<PresenceVisitor | null>(null);

  const query = useQuery({
    queryKey: qk.presence(workspace.id),
    queryFn: () => listPresence(workspace.id),
    enabled: can('visitor:read'),
  });

  if (!can('visitor:read')) return <NoAccess what="live visitors" />;

  return (
    <Page wide>
      <PageHeader
        icon={Users}
        title="Live visitors"
        subtitle={
          query.data
            ? `${query.data.visitors.length} on your sites right now`
            : 'Who is browsing right now'
        }
      />

      {query.isLoading && <Spinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.data &&
        (query.data.visitors.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody here yet"
            hint="Visitors appear the moment the widget loads on one of your pages."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {query.data.visitors.map((visitor) => (
              <Card key={visitor.visitor_id} className="p-4">
                <div className="flex items-start gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800 truncate">
                      {visitor.name || visitor.email || 'Anonymous visitor'}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {[visitor.city, visitor.country].filter(Boolean).join(', ') || 'Unknown location'}
                      {' · '}
                      {relative(visitor.started_at)} on site
                    </p>
                  </div>
                  {visitor.conversation_id && <Badge tone="blue">chatting</Badge>}
                </div>

                <p className="flex items-center gap-1.5 text-xs text-gray-600 truncate">
                  <Globe className="w-3 h-3 shrink-0 text-gray-400" aria-hidden />
                  {visitor.page_title || visitor.current_url || 'Unknown page'}
                </p>
                <p className="text-[11px] text-gray-400 mt-1">
                  {visitor.page_count} page{visitor.page_count === 1 ? '' : 's'} ·{' '}
                  {visitor.browser ?? 'Unknown browser'}
                </p>

                <div className="flex gap-1.5 mt-3">
                  {can('conversation:reply') && !visitor.conversation_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="flex-1"
                      onClick={() => setReachingOut(visitor)}
                    >
                      <MessageCirclePlus className="w-3.5 h-3.5" aria-hidden />
                      Say hello
                    </Button>
                  )}
                  {can('visitor:replay') && plan.has('live_view') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="flex-1"
                      onClick={() => setWatching(visitor)}
                    >
                      <Eye className="w-3.5 h-3.5" aria-hidden />
                      Watch
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ))}

      {reachingOut && (
        <ProactiveDialog visitor={reachingOut} onClose={() => setReachingOut(null)} />
      )}
      {watching && <LiveViewer visitor={watching} onClose={() => setWatching(null)} />}
    </Page>
  );
}

function ProactiveDialog({ visitor, onClose }: { visitor: PresenceVisitor; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [message, setMessage] = useState('Hi! Anything I can help you find?');

  const send = useMutation({
    mutationFn: () =>
      startChat(workspace.id, visitor.visitor_id, {
        website_id: visitor.website_id,
        message,
      }),
    onSuccess: ({ conversation }) => {
      onClose();
      navigate(`/w/${workspace.slug}/inbox/${conversation.id}`);
    },
  });

  return (
    <Modal
      title="Start a chat"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={send.isPending} disabled={!message.trim()} onClick={() => send.mutate()}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-2">
        <p className="text-sm text-gray-500">
          They are on {visitor.page_title || visitor.current_url || 'your site'}. This opens the chat
          on their screen, so make it worth interrupting for.
        </p>
        {send.error && (
          <p role="alert" className="text-sm text-red-600">
            {(send.error as Error).message}
          </p>
        )}
        <TextArea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message" />
      </div>
    </Modal>
  );
}
