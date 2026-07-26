import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useParams } from 'react-router';
import { useWebsiteSettings } from './WebsiteLayout';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import { updateHours } from '../../../lib/api/workspace';
import { qk } from '../../../lib/queryKeys';
import { Section } from '../../../ui/Card';
import { Button, IconButton } from '../../../ui/Button';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import type { BusinessHours } from '../../../lib/api/types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * When you are open, and what the widget does when you are not.
 *
 * The offline behaviour matters more than the schedule: a widget that looks
 * identical at 3am and at 3pm makes a promise the team cannot keep, and the
 * visitor's conclusion is not "they are closed", it is "they ignored me".
 */
export default function Hours() {
  const { data } = useWebsiteSettings();
  const { websiteId = '' } = useParams();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();

  const hours: BusinessHours = data.hours ?? {
    website_id: websiteId,
    enabled: false,
    timezone: workspace.timezone,
    rules: [],
    holidays: [],
    offline_behavior: 'collect_email',
    offline_bot_flow_id: null,
  };

  const save = useMutation({
    mutationFn: (patch: Partial<BusinessHours>) => updateHours(workspace.id, websiteId, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.websiteSettings(workspace.id, websiteId) }),
  });

  const setDay = (dow: number, intervals: [string, string][]) => {
    const rest = hours.rules.filter((r) => r.dow !== dow);
    const next = intervals.length ? [...rest, { dow, intervals }] : rest;
    save.mutate({ rules: next.sort((a, b) => a.dow - b.dow) });
  };

  return (
    <div className="space-y-4">
      <Section title="Business hours">
        <div className="space-y-4">
          <Toggle
            checked={hours.enabled}
            onChange={(v) => save.mutate({ enabled: v })}
            label="Use business hours"
            description="Off, and the widget shows you as online whenever an agent is connected."
          />
          {hours.enabled && (
            <Field label="Time zone">
              {(a) => (
                <Select
                  {...a}
                  value={hours.timezone}
                  onChange={(e) => save.mutate({ timezone: e.target.value })}
                >
                  {timezones(hours.timezone).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      </Section>

      {hours.enabled && (
        <>
          <Section title="Weekly schedule">
            <div className="space-y-2">
              {DAYS.map((label, dow) => {
                const intervals = hours.rules.find((r) => r.dow === dow)?.intervals ?? [];
                return (
                  <div key={dow} className="flex items-start gap-3 py-1">
                    <span className="w-24 shrink-0 text-sm text-gray-600 pt-2">{label}</span>
                    <div className="flex-1 space-y-2">
                      {intervals.length === 0 && (
                        <span className="text-sm text-gray-400 inline-block pt-2">Closed</span>
                      )}
                      {intervals.map((interval, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <TextInput
                            type="time"
                            aria-label={`${label} opens`}
                            value={interval[0]}
                            onChange={(e) =>
                              setDay(
                                dow,
                                intervals.map((iv, i) =>
                                  i === index ? [e.target.value, iv[1]] : iv,
                                ) as [string, string][],
                              )
                            }
                            className="w-32"
                          />
                          <span className="text-gray-400">to</span>
                          <TextInput
                            type="time"
                            aria-label={`${label} closes`}
                            value={interval[1]}
                            onChange={(e) =>
                              setDay(
                                dow,
                                intervals.map((iv, i) =>
                                  i === index ? [iv[0], e.target.value] : iv,
                                ) as [string, string][],
                              )
                            }
                            className="w-32"
                          />
                          <IconButton
                            label={`Remove ${label} hours`}
                            onClick={() => setDay(dow, intervals.filter((_, i) => i !== index))}
                          >
                            <Trash2 className="w-4 h-4" aria-hidden />
                          </IconButton>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDay(dow, [...intervals, ['09:00', '17:00']])}
                      >
                        <Plus className="w-3.5 h-3.5" aria-hidden />
                        {intervals.length ? 'Another window' : 'Open this day'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Holidays" description="Closed all day, whatever the weekly schedule says.">
            <div className="space-y-2">
              {hours.holidays.map((holiday, index) => (
                <div key={index} className="flex items-center gap-2">
                  <TextInput
                    type="date"
                    aria-label="Date"
                    value={holiday.date}
                    onChange={(e) =>
                      save.mutate({
                        holidays: hours.holidays.map((h, i) =>
                          i === index ? { ...h, date: e.target.value } : h,
                        ),
                      })
                    }
                    className="w-44"
                  />
                  <TextInput
                    aria-label="What is it?"
                    placeholder="New Year’s Day"
                    value={holiday.label ?? ''}
                    onChange={(e) =>
                      save.mutate({
                        holidays: hours.holidays.map((h, i) =>
                          i === index ? { ...h, label: e.target.value } : h,
                        ),
                      })
                    }
                  />
                  <IconButton
                    label="Remove holiday"
                    onClick={() =>
                      save.mutate({ holidays: hours.holidays.filter((_, i) => i !== index) })
                    }
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </IconButton>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  save.mutate({
                    holidays: [...hours.holidays, { date: new Date().toISOString().slice(0, 10), label: '' }],
                  })
                }
              >
                <Plus className="w-3.5 h-3.5" aria-hidden />
                Add a holiday
              </Button>
            </div>
          </Section>
        </>
      )}

      <Section title="When you are closed">
        <Field label="What should the widget do?">
          {(a) => (
            <Select
              {...a}
              value={hours.offline_behavior}
              onChange={(e) =>
                save.mutate({ offline_behavior: e.target.value as BusinessHours['offline_behavior'] })
              }
            >
              <option value="collect_email">Take a message and an email address</option>
              <option value="message_only">Take a message without asking for an email</option>
              <option value="hide_widget">Hide the widget completely</option>
              <option value="bot_flow">Hand over to a bot</option>
            </Select>
          )}
        </Field>
        {hours.offline_behavior === 'hide_widget' && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2">
            Hiding the widget means a visitor with a question at 2am has no way to leave it. Most
            teams find the leads worth the inbox.
          </p>
        )}
      </Section>
    </div>
  );
}

function timezones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  const all = supported ? supported('timeZone') : [current];
  return all.includes(current) ? all : [current, ...all];
}
