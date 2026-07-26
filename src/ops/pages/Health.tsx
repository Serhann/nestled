import { useQuery } from '@tanstack/react-query';
import { api, dateTime } from '../api';
import type { HealthReport } from '../types';
import { Badge, Card, ErrorBox, Spinner, Stat } from '../ui';

/**
 * Fleet health.
 *
 * Every `status` here is computed on the server. The page renders the verdict and
 * does not second-guess it — a threshold duplicated in the frontend is a threshold
 * that eventually disagrees with whatever alert pages someone at 3am.
 */

const TONE = { ok: 'ok', warn: 'warn', fail: 'fail' } as const;

export function Health() {
  const { data, error, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthReport>('/platform/health'),
    refetchInterval: 30_000,
  });

  if (error) return <ErrorBox error={error} />;
  if (isPending || !data) return <Spinner />;

  const uptimeHours = Math.floor(data.process.uptime_seconds / 3600);

  return (
    <div className="space-y-4">
      <Card
        title="Process"
        action={<span className="text-xs text-gray-500">generated {dateTime(data.generated_at)}</span>}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Environment" value={data.process.node_env} />
          <Stat label="Uptime" value={`${uptimeHours} h`} />
          <Stat label="Started" value={dateTime(data.process.started_at)} />
        </div>
      </Card>

      <Section
        title="Database"
        check={data.database}
        stats={[['Latency', data.database.latency_ms === null ? 'unreachable' : `${data.database.latency_ms} ms`]]}
      />

      <Section
        title="Realtime"
        check={data.realtime}
        // Per process, not per cluster. Labelled so a second replica does not
        // silently halve these numbers without anyone noticing.
        stats={[
          ['Agent sockets', data.realtime.agentSockets],
          ['Visitor sockets', data.realtime.visitorSockets],
          ['Workspaces with agents', data.realtime.workspacesWithAgents],
          ['Chats with a visitor connected', data.realtime.conversationsWithVisitors],
        ]}
        footnote="Counted in this process. These reset on deploy."
      />

      <Section
        title="Web Push"
        check={data.push}
        stats={[
          ['Configured', data.push.configured ? 'yes' : 'no VAPID keys'],
          ['Stored devices', data.push.stored_subscriptions],
          ['Delivery errors', data.push.errors],
          ['Total failures', data.push.failures],
        ]}
        footnote="A pruned device is housekeeping; a delivery error is the push service refusing us."
      />

      <Section
        title="GeoIP"
        check={data.geoip}
        stats={[
          ['Source', data.geoip.source.replace('_', ' ')],
          ['Database age', data.geoip.age_days === null ? 'n/a' : `${data.geoip.age_days} days`],
          ['Path', data.geoip.path ?? '—'],
        ]}
        footnote="MaxMind publishes weekly; a local database over 45 days old starts drifting."
      />

      <Section
        title="Retention"
        check={data.retention}
        stats={[
          ['Scheduled', data.retention.enabled ? 'yes' : 'no'],
          ['Last run', data.retention.last_run ? dateTime(data.retention.last_run.at) : 'not since boot'],
          ['Outcome', data.retention.last_run ? (data.retention.last_run.ok ? 'clean' : 'failed') : '—'],
        ]}
        footnote="Retention windows come from each customer's plan, not one global number."
      />

      <Section
        title="Email"
        check={data.email}
        stats={[
          ['SMTP', data.email.smtp_configured ? 'configured' : 'none — queued to the database'],
          ['Queued', data.email.queued],
          ['Failed', data.email.failed],
        ]}
      />

      <Section
        title="Billing"
        check={data.billing}
        stats={[
          ['Stripe', data.billing.stripe_configured ? 'configured' : 'not configured'],
          ['Unprocessed events', data.billing.unprocessed_stripe_events],
        ]}
        footnote="A backlog shows up to customers as a plan that did not change after they paid."
      />
    </div>
  );
}

function Section({
  title,
  check,
  stats,
  footnote,
}: {
  title: string;
  check: { status: 'ok' | 'warn' | 'fail'; detail: string };
  stats: [string, string | number][];
  footnote?: string;
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {title} <Badge tone={TONE[check.status]}>{check.status}</Badge>
        </span>
      }
      action={<span className="text-xs text-gray-500">{check.detail}</span>}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <Stat key={label} label={label} value={String(value)} />
        ))}
      </div>
      {footnote && <p className="mt-3 text-xs text-gray-600">{footnote}</p>}
    </Card>
  );
}
