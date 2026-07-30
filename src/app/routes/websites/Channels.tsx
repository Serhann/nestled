import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { AlertTriangle, Mail, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import {
  addChannelEndpoint,
  deleteChannelEndpoint,
  listChannelEndpoints,
  type ChannelEndpoint,
} from '../../../lib/api/workspace';
import { Section } from '../../../ui/Card';
import { Button, IconButton } from '../../../ui/Button';
import { TextInput, Select } from '../../../ui/Form';
import { ErrorState, Spinner } from '../../../ui/Page';

/**
 * The other ways people can reach this inbox.
 *
 * A "website" in Nestled has always been the thing that owns settings, business
 * hours, the knowledge base and per-agent permissions. Adding an email address or a
 * phone number to it means all of those already apply to email and SMS, and an agent
 * scoped to one website keeps seeing exactly what they should — which is why channels
 * live here rather than at workspace level.
 *
 * The page is written to answer the two questions a customer actually has: what do I
 * put in my DNS, and what happens to a reply. Both have answers that are easy to get
 * wrong silently, so both are on screen rather than in a support article.
 */
export default function Channels() {
  const { websiteId } = useParams();
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('website_settings:update');

  const key = ['channels', workspace.id, websiteId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => listChannelEndpoints(workspace.id, websiteId!),
  });

  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');

  const add = useMutation({
    mutationFn: () =>
      addChannelEndpoint(workspace.id, websiteId!, {
        channel,
        address: address.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: async () => {
      setAddress('');
      setLabel('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteChannelEndpoint(workspace.id, websiteId!, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const endpoints = list.data?.endpoints ?? [];
  const mailDomain = list.data?.inbound_mail_domain ?? null;

  return (
    <div className="space-y-4">
      <Section
        title="Email and SMS"
        description="Conversations that arrive by email or text land in the same inbox as your website chat, with the same assignment rules and the same knowledge base."
      >
        {endpoints.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing connected yet. Your website chat keeps working exactly as it does now —
            this only adds ways in.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                endpoint={endpoint}
                editable={editable}
                removing={remove.isPending && remove.variables === endpoint.id}
                onRemove={() => remove.mutate(endpoint.id)}
              />
            ))}
          </ul>
        )}

        {remove.error ? (
          <div className="mt-3">
            <ErrorState error={remove.error} />
          </div>
        ) : null}
      </Section>

      {editable && (
        <Section title="Connect an address">
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <Select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
              aria-label="Channel"
            >
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </Select>
            <TextInput
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={
                channel === 'email'
                  ? mailDomain
                    ? `support@${mailDomain}`
                    : 'support@your-domain.com'
                  : '+905551112233'
              }
              aria-label="Address"
            />
          </div>
          <div className="mt-3">
            <TextInput
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Name customers see on replies, e.g. Acme Support"
              aria-label="Reply name"
            />
            <p className="mt-1.5 text-xs text-gray-500">
              Replies go out under this name, not under the name of whoever answered. Your
              team&rsquo;s names stay yours.
            </p>
          </div>

          {/*
            The instruction that makes this work, and the one thing a customer cannot
            discover for themselves. Left in a support article, every single setup
            fails silently and looks like our bug.
          */}
          {channel === 'email' && (
            <div className="mt-4 rounded-2xl bg-cream border border-gray-200 p-4 text-sm">
              <p className="font-semibold text-gray-800">Before this receives anything</p>
              {mailDomain ? (
                <p className="mt-1.5 text-gray-600 leading-relaxed">
                  Use an address on <b>{mailDomain}</b> and it works immediately. To use an
                  address on your own domain, forward that mailbox to your{' '}
                  <b>{mailDomain}</b> address — every mail provider can do this in a few
                  clicks, and it means you keep control of your own domain.
                </p>
              ) : (
                <p className="mt-1.5 text-gray-600 leading-relaxed">
                  {/*
                    Receiving mail needs a domain on our side that is not ready yet.
                    That is ours to arrange, so this says so and points at us — the
                    earlier wording told the customer to go and ask an operator to
                    configure a receiving domain, which is our vocabulary and not a
                    thing they can do.
                  */}
                  Email isn’t ready for your account yet — we still have to set up the
                  receiving side. Contact us and we’ll turn it on; website chat and SMS
                  are unaffected.
                </p>
              )}
            </div>
          )}
          {channel === 'sms' && (
            <div className="mt-4 rounded-2xl bg-cream border border-gray-200 p-4 text-sm">
              <p className="font-semibold text-gray-800">About replying by text</p>
              <ul className="mt-1.5 text-gray-600 leading-relaxed space-y-1 list-disc pl-4">
                <li>
                  The number must be one we can send from. If you are not sure, ask us before
                  you hand it out to customers.
                </li>
                <li>
                  Long messages, and any message with Turkish or other non-Latin characters,
                  are split into several texts and charged per part.
                </li>
                <li>
                  Anyone who texts <b>STOP</b> stops receiving messages, by law. You will see
                  that in the conversation so you know not to keep typing.
                </li>
              </ul>
            </div>
          )}

          {add.error ? (
            <div className="mt-3">
              <ErrorState error={add.error} />
            </div>
          ) : null}

          <div className="mt-4">
            <Button
              onClick={() => add.mutate()}
              busy={add.isPending}
              disabled={!address.trim()}
            >
              <Plus className="w-4 h-4" aria-hidden />
              Connect
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function EndpointRow({
  endpoint,
  editable,
  removing,
  onRemove,
}: {
  endpoint: ChannelEndpoint;
  editable: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const Icon = endpoint.channel === 'email' ? Mail : MessageSquare;
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="w-8 h-8 shrink-0 rounded-xl bg-gray-100 text-gray-500 flex items-center justify-center">
        <Icon className="w-4 h-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800 truncate">{endpoint.address}</p>
        <p className="text-xs text-gray-500">
          {endpoint.label ? `Replies as “${endpoint.label}” · ` : ''}
          {endpoint.last_inbound_at
            ? `last message ${new Date(endpoint.last_inbound_at).toLocaleDateString()}`
            : 'nothing received yet'}
        </p>
        {/*
          Said plainly, because it is the thing that will surprise someone: nothing
          arrives until mail is actually pointed here, and a connected address that has
          never received anything looks identical to a broken one.
        */}
        {!endpoint.last_inbound_at && endpoint.channel === 'email' && (
          <p className="mt-1 text-xs text-amber-700 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
            Send yourself a test message to check the forwarding works.
          </p>
        )}
      </div>
      {editable && (
        <IconButton
          label={`Disconnect ${endpoint.address}`}
          onClick={onRemove}
          disabled={removing}
        >
          <Trash2 className="w-4 h-4" aria-hidden />
        </IconButton>
      )}
    </li>
  );
}
