/**
 * Business hours evaluation.
 *
 * Deliberately dependency-free and evaluated in the WEBSITE's timezone, not the
 * server's: a customer in Istanbul whose hours were judged in UTC would appear
 * offline for the first three hours of every working day.
 */

export interface HoursRule {
  /** 0 = Sunday … 6 = Saturday, matching Date#getUTCDay. */
  dow: number;
  /** [["09:00","13:00"], ["14:00","18:00"]] — multiple ranges per day. */
  intervals: [string, string][];
}

export interface BusinessHoursRow {
  enabled: boolean;
  timezone: string;
  rules: unknown;
  holidays: unknown;
}

/** Wall-clock parts for `at` in `timeZone`, via Intl so DST is handled for us. */
function partsIn(at: Date, timeZone: string): { dow: number; minutes: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return {
    dow: dowMap[parts.weekday ?? 'Mon'] ?? 1,
    minutes: hour * 60 + Number(parts.minute ?? '0'),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * True when the site is currently open.
 *
 * Hours DISABLED means always open — the safe default, because a customer who has
 * not configured hours yet must not have their widget silently go offline.
 */
export function isWithinBusinessHours(
  hours: BusinessHoursRow | null | undefined,
  at = new Date(),
): boolean {
  if (!hours || !hours.enabled) return true;

  let now: { dow: number; minutes: number; ymd: string };
  try {
    now = partsIn(at, hours.timezone || 'UTC');
  } catch {
    // An invalid IANA name must not close the customer's inbox.
    return true;
  }

  const holidays = Array.isArray(hours.holidays) ? (hours.holidays as { date?: string }[]) : [];
  if (holidays.some((h) => h?.date === now.ymd)) return false;

  const rules = Array.isArray(hours.rules) ? (hours.rules as HoursRule[]) : [];
  const today = rules.filter((r) => r?.dow === now.dow);
  if (today.length === 0) return false;

  for (const rule of today) {
    for (const [from, to] of rule.intervals ?? []) {
      const start = toMinutes(from);
      const end = toMinutes(to);
      if (start === null || end === null) continue;
      // An interval ending before it starts spans midnight (e.g. 22:00–02:00).
      const open = end > start ? now.minutes >= start && now.minutes < end : now.minutes >= start || now.minutes < end;
      if (open) return true;
    }
  }
  return false;
}
