import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, Inbox } from 'lucide-react';
import { useWorkspace } from '../providers/WorkspaceProvider';
import { responseTimeReport } from '../../lib/api/inbox';
import { Card, Section } from '../../ui/Card';
import { Select } from '../../ui/Form';
import { ErrorState, Spinner } from '../../ui/Page';
import { NoAccess } from '../../ui/Locked';
import { channelLabel } from './inbox/channel';

/**
 * How long customers actually wait.
 *
 * Two things this page refuses to do, and both are the reason support reporting usually
 * gets ignored:
 *
 *   - **No average.** A mean is dragged around by the two conversations somebody forgot
 *     about, so it moves for reasons nobody can act on. "Half your customers wait under
 *     X" and "one in ten waits over Y" are two different sentences, both actionable.
 *   - **No hiding the ones you never answered.** They are counted, in their own tile.
 *     A report that measures only the conversations you did answer flatters you exactly
 *     where it matters least.
 */
export default function Reports() {
  const { workspace, can } = useWorkspace();
  const [days, setDays] = useState(30);

  const report = useQuery({
    queryKey: ['report', 'response-times', workspace.id, days],
    queryFn: () => responseTimeReport(workspace.id, days),
    enabled: can('conversation:read'),
  });

  if (!can('conversation:read')) return <NoAccess what="reports" />;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-gray-900">Response times</h1>
          <p className="text-sm text-gray-500 mt-1">
            Measured in <b>working</b> minutes, the same way your targets are — so a message
            that arrived overnight is not counted as eleven hours late.
          </p>
        </div>
        <Select
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          className="!py-1.5 !text-xs !w-auto"
          aria-label="Period"
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
      </div>

      {report.isLoading && <Spinner />}
      {report.error && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}

      {report.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Typical wait"
              value={fmt(report.data.first_response_minutes.p50)}
              hint="Half of your customers waited less than this."
              icon={Clock}
            />
            <Tile
              label="Slowest one in ten"
              value={fmt(report.data.first_response_minutes.p90)}
              hint="The number your least patient customers actually experience."
              icon={Clock}
            />
            <Tile
              label="Still unanswered"
              value={String(report.data.unanswered)}
              hint="Open, and nobody has replied yet."
              icon={Inbox}
              tone={report.data.unanswered > 0 ? 'amber' : undefined}
            />
            <Tile
              label="Missed a target"
              value={String(report.data.breached)}
              hint="Counted even if someone answered later — a breach that vanishes is one nobody learns from."
              icon={AlertTriangle}
              tone={report.data.breached > 0 ? 'red' : undefined}
            />
          </div>

          <Section
            title="By channel"
            description="Where the waiting happens. Email and SMS are usually slower than website chat, and it is worth knowing whether that is your team or your customers' expectations."
          >
            {report.data.by_channel.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nothing answered in this period yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
                      <th className="py-2 pr-4 font-semibold">Channel</th>
                      <th className="py-2 pr-4 font-semibold">Answered</th>
                      <th className="py-2 pr-4 font-semibold">Typical</th>
                      <th className="py-2 font-semibold">Slowest one in ten</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.by_channel.map((row) => (
                      <tr key={row.channel} className="border-t border-gray-100">
                        <td className="py-2.5 pr-4 font-medium text-gray-800">
                          {channelLabel(row.channel)}
                        </td>
                        <td className="py-2.5 pr-4 text-gray-600">{row.answered}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{fmt(row.p50)}</td>
                        <td className="py-2.5 text-gray-600">{fmt(row.p90)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <p className="text-xs text-gray-400 leading-relaxed">
            {report.data.total} conversation{report.data.total === 1 ? '' : 's'} started in the
            last {report.data.days} days, {report.data.answered} of which have had a reply.
            Percentiles are taken from actual response times rather than interpolated, so
            every number above is a wait a real customer had.
          </p>
        </>
      )}
    </div>
  );
}

/** Minutes into something readable. `null` means nothing was measured, not zero. */
function fmt(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Tile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof Clock;
  tone?: 'amber' | 'red';
}) {
  const tones = {
    amber: 'text-amber-700',
    red: 'text-red-700',
  };
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold">{label}</p>
        <Icon className={`w-4 h-4 shrink-0 ${tone ? tones[tone] : 'text-gray-300'}`} aria-hidden />
      </div>
      <p className={`font-display text-2xl mt-2 ${tone ? tones[tone] : 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{hint}</p>
    </Card>
  );
}
