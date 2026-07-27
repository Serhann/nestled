import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router';
import { AlertTriangle, Clock } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { getResponseTargets, saveResponseTargets, type ResponseTargets } from '../../../lib/api/inbox';
import { listMembers } from '../../../lib/api/workspace';
import { Section } from '../../../ui/Card';
import { Button } from '../../../ui/Button';
import { Select, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { ErrorState, Spinner } from '../../../ui/Page';

/**
 * How long a customer should wait, and what happens when they wait longer.
 *
 * Written to be honest about two things a settings page usually hides:
 *
 *   - **What the clock does when you are closed.** The pause is on by default and the
 *     page says which schedule it uses, because a target that runs overnight reports a
 *     failure every Monday morning and teaches a team to ignore the whole thing.
 *   - **That changing a target does not move deadlines already running.** A promise
 *     made under the old target was made under the old target. Silently recomputing
 *     live deadlines would mean a conversation that was fine a second ago is now
 *     breached, which is far more confusing than the rule.
 */
export default function ResponseTimes() {
  const { websiteId } = useParams();
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can('website_settings:update');

  const key = ['response-targets', workspace.id, websiteId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getResponseTargets(workspace.id, websiteId!),
  });
  const members = useQuery({
    queryKey: ['members', workspace.id],
    queryFn: () => listMembers(workspace.id),
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState<ResponseTargets | null>(null);
  useEffect(() => {
    if (query.data && !draft) setDraft(query.data.targets);
  }, [query.data, draft]);

  const save = useMutation({
    mutationFn: () => saveResponseTargets(workspace.id, websiteId!, draft!),
    onSuccess: async (result) => {
      setDraft(result.targets);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (query.isLoading || !draft) return <Spinner />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const hours = query.data!.business_hours;
  const set = <K extends keyof ResponseTargets>(field: K, value: ResponseTargets[K]) =>
    setDraft({ ...draft, [field]: value });

  /** Minutes as a text field, because "" and 0 are different answers. */
  const minutesField = (field: 'first_response_minutes' | 'next_response_minutes') => (
    <TextInput
      value={draft[field] === null ? '' : String(draft[field])}
      disabled={!editable || !draft.enabled}
      inputMode="numeric"
      placeholder="No target"
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9]/g, '');
        set(field, raw === '' ? null : Math.min(100000, Number(raw)));
      }}
    />
  );

  return (
    <div className="space-y-4">
      <Section
        title="Response times"
        description="Set how long a customer should wait, and this becomes a queue that sorts by deadline instead of by whichever message arrived last."
      >
        <Toggle
          checked={draft.enabled}
          disabled={!editable}
          onChange={(value) => set('enabled', value)}
          label="Track response times for this website"
          description="Off means no deadlines and no alerts. Response times are still recorded either way, so the report works regardless."
        />

        <div className="grid gap-4 sm:grid-cols-2 mt-5">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">First reply within</span>
            <div className="flex items-center gap-2 mt-1.5">
              {minutesField('first_response_minutes')}
              <span className="text-sm text-gray-500 shrink-0">minutes</span>
            </div>
            <span className="block mt-1.5 text-xs text-gray-500">
              The one that matters most. Leave empty for no promise.
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Every reply after that within</span>
            <div className="flex items-center gap-2 mt-1.5">
              {minutesField('next_response_minutes')}
              <span className="text-sm text-gray-500 shrink-0">minutes</span>
            </div>
            <span className="block mt-1.5 text-xs text-gray-500">
              Usually longer. A conversation already being handled is a different promise
              from one nobody has touched.
            </span>
          </label>
        </div>
      </Section>

      <Section title="When you are closed">
        <Toggle
          checked={draft.business_hours_only}
          disabled={!editable || !draft.enabled}
          onChange={(value) => set('business_hours_only', value)}
          label="Pause the clock outside business hours"
          description="A message arriving at 17:50 is then due at 09:20 the next morning, not at 18:20 tonight."
        />
        {/*
          The setting that quietly does nothing, said out loud. With no schedule
          configured, "pause outside business hours" has nothing to pause for — and a
          greyed-out explanation is much better than a switch that lies.
        */}
        {draft.business_hours_only && !hours.enabled && (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span>
              This website has no business hours set, so there is nothing to pause for and
              deadlines will run around the clock.{' '}
              <Link to="../hours" className="font-semibold underline">
                Set your hours
              </Link>{' '}
              first.
            </span>
          </div>
        )}
        {draft.business_hours_only && hours.enabled && (
          <p className="mt-3 text-xs text-gray-500">
            Using this website&rsquo;s hours, in <b>{hours.timezone}</b>. Holidays count as
            closed.
          </p>
        )}
      </Section>

      <Section
        title="When a deadline is missed"
        description="This is the part that stops something being missed rather than reporting on it afterwards."
      >
        <Toggle
          checked={draft.escalate_enabled}
          disabled={!editable || !draft.enabled}
          onChange={(value) => set('escalate_enabled', value)}
          label="Hand it to someone else"
          description="A notification alone is one more thing to miss. Reassigning is what gets it answered."
        />
        {draft.escalate_enabled && (
          <label className="block mt-4 max-w-sm">
            <span className="text-sm font-medium text-gray-700">Give it to</span>
            <Select
              className="mt-1.5"
              disabled={!editable}
              value={draft.escalate_to_member_id ?? ''}
              onChange={(e) => set('escalate_to_member_id', e.target.value || null)}
              aria-label="Escalate to"
            >
              <option value="">Nobody — just flag it</option>
              {(members.data?.members ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.user.name ?? member.user.email} ({member.role})
                </option>
              ))}
            </Select>
          </label>
        )}

        <div className="mt-5">
          <Toggle
            checked={draft.notify_owners}
            disabled={!editable || !draft.enabled}
            onChange={(value) => set('notify_owners', value)}
            label="Send it to your notification channel"
            description="Uses the Discord webhook in workspace settings. Sent in red, and sent even if you have per-message notifications turned off — muting chatter is not the same as asking not to hear about a broken promise."
          />
        </div>

        <p className="mt-5 flex items-start gap-2 text-xs text-gray-500">
          <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
          <span>
            A missed conversation is also marked unread and moved to the top of the
            &ldquo;due soon or overdue&rdquo; view, so it cannot sit at the bottom of a list
            sorted by recency.
          </span>
        </p>
      </Section>

      {editable && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} busy={save.isPending}>
            Save
          </Button>
          <p className="text-xs text-gray-500">
            Deadlines already running keep the targets they were set with. Only new
            messages use the new numbers.
          </p>
        </div>
      )}
      {save.error ? <ErrorState error={save.error} /> : null}
    </div>
  );
}
