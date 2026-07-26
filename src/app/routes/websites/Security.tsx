import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useWebsiteSettings } from './WebsiteLayout';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { rotateIdentitySecret, updateWebsite } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Section } from '../../../ui/Card';
import { Button, IconButton } from '../../../ui/Button';
import { TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { Modal } from '../../../ui/Modal';
import { CodeBlock } from '../../components/EmbedSnippet';

/**
 * Domains and signed visitor attributes.
 *
 * The allowlist is what decides where this widget may run, and it is per-website
 * — a single global CORS list cannot work in a multi-tenant product where every
 * customer has their own domains.
 */
export default function Security() {
  const { data } = useWebsiteSettings();
  const { websiteId = '' } = useParams();
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [newDomain, setNewDomain] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);

  const website = data.website;

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateWebsite>[2]) =>
      updateWebsite(workspace.id, websiteId, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.websiteSettings(workspace.id, websiteId) });
      await queryClient.invalidateQueries({ queryKey: qk.websites(workspace.id) });
    },
  });

  const rotate = useMutation({
    mutationFn: () => rotateIdentitySecret(workspace.id, websiteId),
    onSuccess: async (result) => {
      setRevealed(result.secret);
      await queryClient.invalidateQueries({ queryKey: qk.websiteSettings(workspace.id, websiteId) });
    },
  });

  return (
    <div className="space-y-4">
      <Section
        title="Where this widget may load"
        description="Hosts not on this list are recorded so you can see them, and the widget stays hidden there."
      >
        <div className="space-y-2">
          {website.allowed_domains.map((domain) => (
            <div key={domain} className="flex items-center gap-2">
              <span className="flex-1 text-sm text-gray-700 font-mono">{domain}</span>
              <IconButton
                label={`Remove ${domain}`}
                onClick={() =>
                  save.mutate({ allowed_domains: website.allowed_domains.filter((d) => d !== domain) })
                }
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </IconButton>
            </div>
          ))}
          <div className="flex gap-2">
            <TextInput
              value={newDomain}
              placeholder="acme.com"
              aria-label="Add a domain"
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !newDomain.trim()) return;
                save.mutate({
                  allowed_domains: [...new Set([...website.allowed_domains, normalize(newDomain)])],
                });
                setNewDomain('');
              }}
            />
            <Button
              variant="ghost"
              disabled={!newDomain.trim()}
              onClick={() => {
                save.mutate({
                  allowed_domains: [...new Set([...website.allowed_domains, normalize(newDomain)])],
                });
                setNewDomain('');
              }}
            >
              <Plus className="w-4 h-4" aria-hidden />
              Add
            </Button>
          </div>

          <div className="pt-2">
            <Toggle
              checked={website.enforce_domains}
              onChange={(v) => save.mutate({ enforce_domains: v })}
              label="Only load on the domains above"
              description="Leave this off while you are still setting up — turning it on before your list is right hides the widget on your own site."
            />
          </div>
        </div>
      </Section>

      {can('integration:manage') && (
        <Section
          title="Signed visitor details"
          description="Sign details on your own server and we will show them to agents as verified. Without a signature, anything the page sends is treated as an unverified hint."
        >
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              {website.has_identity_secret
                ? 'A signing key exists for this website.'
                : 'No signing key yet.'}
            </p>
            <Button
              variant={website.has_identity_secret ? 'ghost' : 'primary'}
              busy={rotate.isPending}
              onClick={() => {
                if (
                  website.has_identity_secret &&
                  !confirm(
                    'Rotating stops every token signed with the current key from being accepted, immediately. Continue?',
                  )
                ) {
                  return;
                }
                rotate.mutate();
              }}
            >
              <KeyRound className="w-4 h-4" aria-hidden />
              {website.has_identity_secret ? 'Rotate the key' : 'Create a signing key'}
            </Button>
          </div>
        </Section>
      )}

      {revealed && (
        <Modal
          title="Your signing key"
          onClose={() => setRevealed(null)}
          wide
          footer={<Button onClick={() => setRevealed(null)}>I have saved it</Button>}
        >
          <div className="space-y-3 pb-2">
            <p className="text-sm text-red-700 bg-red-50 rounded-xl px-3 py-2">
              This is the only time we will show it. Store it with your other server secrets.
            </p>
            <CodeBlock code={revealed} />
            <p className="text-sm text-gray-600">Sign a short-lived token on your server:</p>
            <CodeBlock
              code={`// Node, using the key above as the HMAC secret.
const payload = {
  customer: { id: user.id, name: user.name, email: user.email },
  attributes: { plan: user.plan, mrr: user.mrr },
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,   // required, and at most 24h out
};
const token = jwt.sign(payload, NESTLED_SIGNING_KEY, { algorithm: 'HS256' });

// Then, in the page:
Nestled('context', token);`}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}
