import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { MailPlus, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { useSession } from '../../providers/SessionProvider';
import {
  createInvite,
  listInvites,
  listMembers,
  listWebsites,
  removeMember,
  revokeInvite,
  updateMember,
} from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { ApiError } from '../../../lib/http';
import { Button, IconButton } from '../../../ui/Button';
import { Section } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Badge } from '../../../ui/Badge';
import { Modal } from '../../../ui/Modal';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';
import { WebsiteScope, scopeLabel } from '../../../ui/WebsiteScope';
import { SettingsLayout } from './SettingsLayout';
import type { Role } from '../../../lib/api/types';

/**
 * The team.
 *
 * The old panel had an admin type someone else's password into a form. That is
 * replaced by a real invitation: the person sets their own password, we never
 * hold a credential they did not choose, and the pending state is visible to
 * everyone rather than living in one admin's memory.
 */
export default function Team() {
  const { workspace, can } = useWorkspace();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);

  const members = useQuery({
    queryKey: qk.members(workspace.id),
    queryFn: () => listMembers(workspace.id),
  });
  const invites = useQuery({
    queryKey: qk.invites(workspace.id),
    queryFn: () => listInvites(workspace.id),
  });
  const websites = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
    staleTime: 5 * 60_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.members(workspace.id) });
    await queryClient.invalidateQueries({ queryKey: qk.invites(workspace.id) });
  };

  const changeMember = useMutation({
    mutationFn: (input: { memberId: string; patch: Parameters<typeof updateMember>[2] }) =>
      updateMember(workspace.id, input.memberId, input.patch),
    onSuccess: refresh,
  });

  const kick = useMutation({
    mutationFn: (memberId: string) => removeMember(workspace.id, memberId),
    onSuccess: refresh,
  });

  const cancelInvite = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(workspace.id, inviteId),
    onSuccess: refresh,
  });

  if (!can('member:read')) return <NoAccess what="the team" />;

  const seats = members.data?.seats;
  const seatsFull = seats ? seats.included > 0 && seats.used >= seats.included : false;
  const sites = websites.data?.websites ?? [];

  return (
    <SettingsLayout
      title="Team"
      subtitle={seats ? `${seats.used} of ${seats.included} seats used.` : undefined}
      action={
        can('member:invite') &&
        (seatsFull ? (
          <Link to={`/w/${workspace.slug}/settings/billing`}>
            <Button variant="ghost">Add seats</Button>
          </Link>
        ) : (
          <Button onClick={() => setInviting(true)}>
            <MailPlus className="w-4 h-4" aria-hidden />
            Invite
          </Button>
        ))
      }
    >
      {members.isLoading && <Spinner />}
      {members.error && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}

      {members.data && (
        <Section title="Members">
          <div className="divide-y divide-gray-100">
            {members.data.members.map((member) => {
              const isSelf = member.user.id === me.user.id;
              return (
                <div key={member.id} className="flex items-center gap-3 py-3 first:pt-0">
                  <span className="relative w-9 h-9 shrink-0 rounded-full bg-gray-200 text-gray-600 text-sm font-semibold flex items-center justify-center">
                    {member.user.name.charAt(0).toUpperCase()}
                    {member.is_online && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-500 border-2 border-white" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800 truncate">
                      {member.user.name}
                      {isSelf && <span className="text-gray-400 font-normal"> (you)</span>}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{member.user.email}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {member.all_websites ? 'All websites' : scopeLabel(sites, member.website_ids)}
                    </p>
                  </div>

                  {can('member:update') && member.role !== 'owner' ? (
                    <Select
                      className="!py-1.5 !text-xs w-auto"
                      aria-label={`Role for ${member.user.name}`}
                      value={member.role}
                      onChange={(e) =>
                        changeMember.mutate({
                          memberId: member.id,
                          patch: { role: e.target.value as Role },
                        })
                      }
                    >
                      <option value="agent">Agent</option>
                      <option value="admin">Admin</option>
                    </Select>
                  ) : (
                    <Badge tone={member.role === 'owner' ? 'violet' : 'gray'}>{member.role}</Badge>
                  )}

                  {can('member:remove') && member.role !== 'owner' && !isSelf && (
                    <IconButton
                      label={`Remove ${member.user.name}`}
                      onClick={() => {
                        if (confirm(`Remove ${member.user.name} from ${workspace.name}?`)) {
                          kick.mutate(member.id);
                        }
                      }}
                    >
                      <Trash2 className="w-4 h-4" aria-hidden />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {(invites.data?.invites.length ?? 0) > 0 && (
        <Section title="Pending invitations">
          <div className="divide-y divide-gray-100">
            {invites.data!.invites.map((invite) => (
              <div key={invite.id} className="flex items-center gap-3 py-3 first:pt-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 truncate">{invite.email}</p>
                  <p className="text-[11px] text-gray-400">
                    {invite.role} · invited by {invite.author?.name ?? 'someone'} ·{' '}
                    {invite.expired ? 'expired' : `expires ${new Date(invite.expires_at).toLocaleDateString()}`}
                  </p>
                </div>
                {invite.expired && <Badge tone="amber">expired</Badge>}
                {can('member:invite') && (
                  <IconButton label={`Revoke the invitation for ${invite.email}`} onClick={() => cancelInvite.mutate(invite.id)}>
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {inviting && (
        <InviteDialog
          sites={sites}
          onClose={() => setInviting(false)}
          onDone={async () => {
            setInviting(false);
            await refresh();
          }}
        />
      )}
    </SettingsLayout>
  );
}

function InviteDialog({
  sites,
  onClose,
  onDone,
}: {
  sites: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { workspace } = useWorkspace();
  const { me } = useSession();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [websiteIds, setWebsiteIds] = useState<string[]>([]);

  const send = useMutation({
    mutationFn: () =>
      createInvite(workspace.id, {
        email,
        role,
        all_websites: websiteIds.length === 0,
        website_ids: websiteIds,
      }),
    onSuccess: onDone,
  });

  const limit = send.error instanceof ApiError ? send.error.planLimit : null;

  return (
    <Modal
      title="Invite a teammate"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={send.isPending} disabled={!email} onClick={() => send.mutate()}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        {!me.user.email_verified && (
          <p className="text-sm bg-amber-50 text-amber-800 rounded-xl px-3 py-2">
            Confirm your own email address first — until then we cannot send mail on your behalf.
          </p>
        )}
        {limit ? (
          <p role="alert" className="text-sm text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
            Your plan includes {limit.limit} seat{limit.limit === 1 ? '' : 's'} and {limit.used} are
            in use.
          </p>
        ) : (
          send.error && (
            <p role="alert" className="text-sm text-red-600">
              {(send.error as Error).message}
            </p>
          )
        )}
        <Field label="Their email" required>
          {(a) => (
            <TextInput
              {...a}
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Role"
          hint={
            role === 'admin'
              ? 'Admins can change everything except billing and deleting the workspace.'
              : 'Agents handle conversations. They cannot change settings.'
          }
        >
          {(a) => (
            <Select {...a} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        {sites.length > 1 && (
          <WebsiteScope
            websites={sites}
            value={websiteIds}
            onChange={setWebsiteIds}
            label="Which websites can they see?"
          />
        )}
      </div>
    </Modal>
  );
}
