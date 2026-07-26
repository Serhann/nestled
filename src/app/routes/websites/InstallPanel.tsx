import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Loader2, MessageCircle, Radio } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { useInstallProbe } from '../../hooks/useInstallProbe';
import { updateWebsite, listWebsites } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { EmbedSnippet } from '../../components/EmbedSnippet';
import type { InstallPhase } from '../../../lib/api/types';

/**
 * The install detector, shared by the wizard and the website settings page.
 *
 * It reports four states in order — waiting, script seen, visitor online, message
 * received — plus the one failure that actually happens in practice: the snippet
 * is live, but on a host the allowlist does not cover. Calling that out as its own
 * state, with a one-click fix, is the difference between "not detected yet" and an
 * answer.
 */

const STEPS: { phase: InstallPhase; label: string; hint: string }[] = [
  { phase: 'waiting', label: 'Waiting for your site', hint: 'Paste the snippet, then load a page.' },
  { phase: 'script_seen', label: 'We can see Nestled on your site', hint: 'The widget is loading.' },
  { phase: 'message_received', label: 'First message received', hint: 'You are live.' },
];

export function InstallPanel({ websiteId, publicKey }: { websiteId: string; publicKey: string }) {
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const { data: status } = useInstallProbe(workspace.id, websiteId);
  const [helpOpen, setHelpOpen] = useState(false);

  const allowHost = useMutation({
    mutationFn: async (host: string) => {
      const { websites } = await listWebsites(workspace.id);
      const site = websites.find((w) => w.id === websiteId);
      return updateWebsite(workspace.id, websiteId, {
        allowed_domains: [...new Set([...(site?.allowed_domains ?? []), host])],
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.installStatus(workspace.id, websiteId) });
      await queryClient.invalidateQueries({ queryKey: qk.websites(workspace.id) });
    },
  });

  const phase = status?.phase ?? 'waiting';
  const reached = (target: InstallPhase): boolean =>
    ['waiting', 'script_seen', 'message_received'].indexOf(phase) >=
    ['waiting', 'script_seen', 'message_received'].indexOf(target);

  return (
    <Card className="p-6 space-y-5">
      <div>
        <h2 className="font-display text-2xl text-gray-800">Add Nestled to your site</h2>
        <p className="text-sm text-gray-500 mt-1">
          Paste this before <code className="text-xs">&lt;/body&gt;</code>. We will tell you the moment we
          see it.
        </p>
      </div>

      <EmbedSnippet publicKey={publicKey} />

      <div className="rounded-2xl bg-gray-50 p-4 space-y-3">
        {STEPS.map((step) => {
          const done = reached(step.phase) && phase !== step.phase;
          const active = phase === step.phase;
          return (
            <div key={step.phase} className="flex items-start gap-3">
              <span
                className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center ${
                  done ? 'bg-green-600 text-white' : active ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-400'
                }`}
              >
                {done ? (
                  <Check className="w-3.5 h-3.5" aria-hidden />
                ) : active ? (
                  step.phase === 'message_received' ? (
                    <MessageCircle className="w-3.5 h-3.5" aria-hidden />
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                  )
                ) : (
                  <Radio className="w-3 h-3" aria-hidden />
                )}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-medium ${done || active ? 'text-gray-800' : 'text-gray-400'}`}>
                  {step.label}
                </p>
                {active && <p className="text-xs text-gray-500 mt-0.5">{step.hint}</p>}
              </div>
            </div>
          );
        })}
      </div>

      {phase === 'wrong_domain' && status?.wrong_domain_host && (
        <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900">
                The snippet is running on {status.wrong_domain_host}
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                That host is not on this website’s allowlist, so the widget is staying hidden.
              </p>
              <Button
                size="sm"
                className="mt-3"
                busy={allowHost.isPending}
                onClick={() => allowHost.mutate(status.wrong_domain_host!)}
              >
                Allow {status.wrong_domain_host}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div>
        <button
          onClick={() => setHelpOpen((v) => !v)}
          aria-expanded={helpOpen}
          className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition ${helpOpen ? 'rotate-180' : ''}`} aria-hidden />
          Nothing happening?
        </button>
        {helpOpen && (
          <ul className="mt-3 space-y-2 text-xs text-gray-600 list-disc pl-5">
            <li>
              Check the snippet is before <code>&lt;/body&gt;</code> and not inside a conditional
              block that never runs.
            </li>
            <li>
              A Content-Security-Policy needs <code>script-src</code> and <code>connect-src</code> to
              allow this host.
            </li>
            <li>Ad blockers occasionally catch chat widgets — try a private window.</li>
            <li>
              A cached page will still be serving the old HTML; purge your CDN or hard-reload.
            </li>
          </ul>
        )}
      </div>
    </Card>
  );
}
