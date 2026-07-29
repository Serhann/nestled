import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Globe, PartyPopper, Users } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { useSession } from '../../providers/SessionProvider';
import { createWebsite, listWebsites, createInvite } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Field, TextInput } from '../../../ui/Form';
import { Page, PageHeader, Spinner } from '../../../ui/Page';
import { InstallPanel } from '../websites/InstallPanel';

/**
 * The onboarding wizard.
 *
 * One rule governs the whole thing: **the server owns the progress, the URL owns
 * the screen.** `workspace.onboarding.step` is derived from facts — does a website
 * exist, has the snippet been seen, has a conversation happened, is there a second
 * member — and never from a step the client reports finishing.
 *
 * That single choice is what makes every drop-off resumable from any device, and
 * reduces the "finish setting up" email to a plain deep link. It also means the
 * checklist cannot claim a step is done when it is not.
 *
 * An invited teammate never sees this: they arrive into a workspace that is
 * already installed, and walking them through creating a website would be
 * nonsense.
 */

type Step = 'website' | 'install' | 'team' | 'done';

export default function SetupFlow() {
  const { step: urlStep } = useParams();
  const { workspace } = useWorkspace();
  const { data: websites } = useQuery({
    queryKey: qk.websites(workspace.id),
    queryFn: () => listWebsites(workspace.id),
  });

  // The furthest incomplete step, unless the URL asks for an earlier one. Going
  // back is allowed; skipping ahead past something unfinished is not.
  const serverStep = mapServerStep(workspace.onboarding.step);
  const step: Step = isStep(urlStep) && order(urlStep) <= order(serverStep) ? urlStep : serverStep;

  if (!websites) return <Spinner />;
  const firstWebsite = websites.websites[0] ?? null;

  return (
    <Page>
      <PageHeader
        title="Set up Nestled"
        subtitle="Three steps. You can leave and come back — we remember where you were."
      />
      <Progress current={step} />

      {step === 'website' && <WebsiteStep />}
      {step === 'install' && firstWebsite && <InstallStep websiteId={firstWebsite.id} publicKey={firstWebsite.public_key} />}
      {step === 'team' && <TeamStep />}
      {step === 'done' && <DoneStep />}
    </Page>
  );
}

function Progress({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'website', label: 'Website' },
    { key: 'install', label: 'Install' },
    { key: 'team', label: 'Team' },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs font-semibold">
      {steps.map((s) => {
        const done = order(current) > order(s.key);
        const active = current === s.key;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center ${
                done ? 'bg-green-600 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
              }`}
            >
              {done ? <Check className="w-3.5 h-3.5" aria-hidden /> : steps.indexOf(s) + 1}
            </span>
            <span className={active ? 'text-gray-800' : 'text-gray-400'}>{s.label}</span>
            {s.key !== 'team' && <span className="w-6 h-px bg-gray-200" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function WebsiteStep() {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createWebsite(workspace.id, {
        name: name || suggestName(domain) || 'My website',
        primary_domain: normalizeDomain(domain) || undefined,
        // The domain the customer just typed becomes the allowlist. Leaving the
        // allowlist empty and asking them to fill it in later is how the widget
        // ends up refusing to load on the one site it was installed on.
        allowed_domains: normalizeDomain(domain) ? [normalizeDomain(domain)] : [],
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.websites(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: qk.me() });
    },
  });

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center">
          <Globe className="w-5 h-5" aria-hidden />
        </span>
        <h2 className="font-display text-2xl text-gray-800">Where will you use Nestled?</h2>
      </div>
      <Field label="Your website" hint="We use this to name your inbox and to allow the widget to load there.">
        {(a) => (
          <TextInput
            {...a}
            autoFocus
            placeholder="acme.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        )}
      </Field>
      <Field label="What should we call it?" hint="Only your team sees this.">
        {(a) => (
          <TextInput
            {...a}
            placeholder={suggestName(domain) || 'My website'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Button busy={create.isPending} onClick={() => create.mutate()}>
        Continue
      </Button>
      {create.error && (
        <p role="alert" className="text-sm text-red-600">
          {(create.error as Error).message}
        </p>
      )}
    </Card>
  );
}

function InstallStep({ websiteId, publicKey }: { websiteId: string; publicKey: string }) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <InstallPanel websiteId={websiteId} publicKey={publicKey} />
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => navigate(`/w/${workspace.slug}/setup/team`)}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function TeamStep() {
  const { workspace } = useWorkspace();
  const { me } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const queryClient = useQueryClient();

  const invite = useMutation({
    mutationFn: () => createInvite(workspace.id, { email, role: 'agent' }),
    onSuccess: async () => {
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: qk.invites(workspace.id) });
    },
  });

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center">
          <Users className="w-5 h-5" aria-hidden />
        </span>
        <h2 className="font-display text-2xl text-gray-800">Bring someone with you</h2>
      </div>
      <p className="text-sm text-gray-500">
        Chat is a team sport — someone has to be there when you are not. You can do this later.
      </p>
      {!me.user.email_verified && (
        <p className="text-sm bg-amber-50 text-amber-800 rounded-xl px-3 py-2">
          Confirm your email first and we will be able to send the invitation.
        </p>
      )}
      <div className="flex gap-2">
        <TextInput
          type="email"
          placeholder="teammate@acme.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1"
        />
        <Button
          busy={invite.isPending}
          disabled={!email || !me.user.email_verified}
          onClick={() => invite.mutate()}
        >
          Invite
        </Button>
      </div>
      {invite.isSuccess && <p className="text-sm text-green-700">Invitation sent.</p>}
      {invite.error && (
        <p role="alert" className="text-sm text-red-600">
          {(invite.error as Error).message}
        </p>
      )}
      <Button variant="ghost" onClick={() => navigate(`/w/${workspace.slug}/inbox`)}>
        Go to my inbox
      </Button>
    </Card>
  );
}

function DoneStep() {
  const { workspace } = useWorkspace();
  return (
    <Card className="p-8 text-center">
      <span className="w-14 h-14 rounded-3xl bg-green-100 text-green-700 flex items-center justify-center mx-auto mb-4">
        <PartyPopper className="w-7 h-7" aria-hidden />
      </span>
      <p className="font-display text-2xl text-gray-800">You’re live</p>
      <p className="text-sm text-gray-500 mt-1">Everything is set up and your widget is answering.</p>
      <Link
        to={`/w/${workspace.slug}/inbox`}
        className="inline-block mt-5 bg-blue-600 text-white rounded-full px-5 py-2.5 text-sm font-semibold"
      >
        Open my inbox
      </Link>
    </Card>
  );
}

const ORDER: Step[] = ['website', 'install', 'team', 'done'];
const order = (step: Step): number => ORDER.indexOf(step);
const isStep = (value: string | undefined): value is Step => ORDER.includes(value as Step);

function mapServerStep(step: string | null): Step {
  // `first_conversation` is not a screen — it is the install screen still waiting
  // for its final signal, and sending the customer somewhere else at that moment
  // would hide the thing they are watching for.
  if (step === 'website') return 'website';
  if (step === 'install' || step === 'first_conversation') return 'install';
  if (step === 'team') return 'team';
  return 'done';
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function suggestName(domain: string): string {
  const host = normalizeDomain(domain);
  if (!host) return '';
  const label = host.split('.')[0] ?? '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}
