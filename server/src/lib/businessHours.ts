/**
 * Business hours: evaluation, and arithmetic in open time.
 *
 * Deliberately dependency-free and evaluated in the WEBSITE's timezone, not the
 * server's: a customer in Istanbul whose hours were judged in UTC would appear
 * offline for the first three hours of every working day.
 *
 * `addBusinessMinutes` and `businessMinutesBetween` are what make a response-time
 * promise honest. A target of "reply within 30 minutes" cannot mean 30 wall-clock
 * minutes: a message arriving at 17:50 on a Friday is not late at 18:20, it is late
 * at 09:20 on Monday. Getting that wrong means spending every weekend telling a team
 * they failed, and a report nobody believes is a report nobody reads.
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

  // Delegated to the same window builder the duration arithmetic uses, so there is
  // exactly ONE definition of "which minutes of this local day are open".
  //
  // This used to filter today's rules and handle a midnight-spanning interval by
  // testing both sides of midnight in place. That is wrong on the far side: at 01:00
  // on Wednesday it looked up WEDNESDAY's rules, found none, and reported closed —
  // so a team whose shift is declared `22:00–02:00` on Tuesday had their widget go
  // offline in the middle of a shift they were actually working. Found by testing the
  // new arithmetic against the old predicate and watching them disagree.
  return windowsForLocalDay(hours, now.dow, now.ymd, holidaySet(hours)).some(
    (w) => now.minutes >= w.from && now.minutes < w.to,
  );
}

// ── Arithmetic in open time ─────────────────────────────────────────────────

const MINUTE = 60_000;
/**
 * How far forward a walk will look for open time before giving up.
 *
 * A schedule with no open intervals — every weekday blank, or a year of holidays —
 * would otherwise spin forever. Sixty days is far past any real schedule and bounded.
 */
const MAX_LOOKAHEAD_DAYS = 60;

interface Window {
  /** Minutes from local midnight, always `to > from`, always within one local day. */
  from: number;
  to: number;
}

/** `"2026-01-01"` → the set of closed local dates. */
function holidaySet(hours: BusinessHoursRow): Set<string> {
  const set = new Set<string>();
  const list = Array.isArray(hours.holidays) ? hours.holidays : [];
  for (const entry of list) {
    if (typeof entry === 'string') set.add(entry.trim());
    else if (entry && typeof entry === 'object') {
      const date = (entry as { date?: unknown }).date;
      if (typeof date === 'string') set.add(date.trim());
    }
  }
  return set;
}

/** The raw intervals declared for one weekday, unmerged, malformed entries dropped. */
function rawIntervals(hours: BusinessHoursRow, dow: number): { from: number; to: number }[] {
  const rules = Array.isArray(hours.rules) ? (hours.rules as HoursRule[]) : [];
  const out: { from: number; to: number }[] = [];
  for (const rule of rules) {
    if (rule?.dow !== dow || !Array.isArray(rule.intervals)) continue;
    for (const pair of rule.intervals) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const from = toMinutes(String(pair[0]));
      const to = toMinutes(String(pair[1]));
      if (from === null || to === null || from === to) continue;
      out.push({ from, to });
    }
  }
  return out;
}

/**
 * The open windows falling INSIDE one local day, in local minutes.
 *
 * Two things happen here that the simple "filter today's rules" version gets wrong:
 *
 *   - **Midnight-spanning intervals are split.** `22:00–02:00` is two windows on two
 *     days, and the second belongs to tomorrow. `isWithinBusinessHours` handles the
 *     spanning case by testing both sides of midnight, which works for a point in
 *     time but not for measuring a duration.
 *   - **Yesterday's spillover counts.** A day that follows a `22:00–02:00` night
 *     opens at 00:00, and a message arriving at 00:30 is inside opening hours.
 *
 * Overlaps are merged, because a schedule of 09:00–13:00 plus 12:00–17:00 would
 * otherwise count the shared hour twice and the clock would run fast — which surfaces
 * as "our report says we answer faster than we do".
 */
function windowsForLocalDay(
  hours: BusinessHoursRow,
  dow: number,
  ymd: string,
  holidays: Set<string>,
): Window[] {
  if (holidays.has(ymd)) return [];
  const DAY = 24 * 60;
  const raw: Window[] = [];

  for (const interval of rawIntervals(hours, dow)) {
    if (interval.to > interval.from) raw.push({ from: interval.from, to: Math.min(interval.to, DAY) });
    // Spans midnight: today's part only. Tomorrow's part is picked up as spillover.
    else raw.push({ from: interval.from, to: DAY });
  }
  // Spillover from the previous weekday's midnight-spanning intervals.
  const yesterday = (dow + 6) % 7;
  for (const interval of rawIntervals(hours, yesterday)) {
    if (interval.to <= interval.from && interval.to > 0) raw.push({ from: 0, to: interval.to });
  }

  raw.sort((a, b) => a.from - b.from);
  const merged: Window[] = [];
  for (const window of raw) {
    const last = merged[merged.length - 1];
    if (last && window.from <= last.to) last.to = Math.max(last.to, window.to);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * The instant of 00:00 local on the local date containing `at`.
 *
 * Converge rather than compute: subtract the local minutes seen at `at`, then check
 * again, because subtracting across a DST boundary lands an hour off. Two passes is
 * enough for every real zone — offsets move by whole or half hours, never by more
 * than the correction being applied.
 */
function localMidnight(at: Date, timeZone: string): Date {
  let cursor = new Date(at.getTime() - partsIn(at, timeZone).minutes * MINUTE);
  const drift = partsIn(cursor, timeZone).minutes;
  if (drift !== 0) {
    // Ambiguous: either the day is longer or shorter here. Stepping back by the drift
    // lands on 00:00 when the clock went forward; when it went back, the extra hour
    // means 00:00 occurred twice and either instant is a defensible answer.
    cursor = new Date(cursor.getTime() - (drift > 12 * 60 ? drift - 24 * 60 : drift) * MINUTE);
  }
  return cursor;
}

/**
 * `minutes` of OPEN time after `from`, or null when the schedule never opens.
 *
 * Null rather than a guess. The caller decides what "we cannot tell when you will be
 * open" means, and for a response target the answer is "no due time" — not a due date
 * invented from an empty schedule. A wrong due date produces a false breach, and false
 * breaches are how a team learns to ignore the whole feature.
 *
 * Known limit, stated rather than hidden: within a day the result is computed by
 * adding local minutes to that day's midnight, so a deadline landing on the far side
 * of a DST transition can be an hour out. Twice a year, on a support deadline, that is
 * not worth a timezone library.
 */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  hours: BusinessHoursRow | null | undefined,
): Date | null {
  if (minutes <= 0) return new Date(from.getTime());
  // Hours disabled means always open — the same convention as isWithinBusinessHours,
  // so a customer who has not configured hours gets plain wall-clock targets rather
  // than none at all.
  if (!hours || !hours.enabled) return new Date(from.getTime() + minutes * MINUTE);

  const timeZone = hours.timezone || 'UTC';
  let holidays: Set<string>;
  let anchor: Date;
  try {
    holidays = holidaySet(hours);
    anchor = localMidnight(from, timeZone);
  } catch {
    // An invalid IANA name must not stop targets working; wall clock is wrong but
    // bounded, and matches what isWithinBusinessHours does with the same input.
    return new Date(from.getTime() + minutes * MINUTE);
  }

  let remaining = minutes;
  let startLocal = partsIn(from, timeZone).minutes;

  for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day += 1) {
    const at = partsIn(anchor, timeZone);
    for (const window of windowsForLocalDay(hours, at.dow, at.ymd, holidays)) {
      const start = Math.max(window.from, startLocal);
      if (start >= window.to) continue;
      const available = window.to - start;
      if (available >= remaining) return new Date(anchor.getTime() + (start + remaining) * MINUTE);
      remaining -= available;
    }
    // Next local day. Jumping 36h and re-anchoring is robust to 23- and 25-hour days
    // in a way that adding exactly 24h is not.
    anchor = localMidnight(new Date(anchor.getTime() + 36 * 60 * MINUTE), timeZone);
    startLocal = 0;
  }
  return null;
}

/**
 * Open minutes between two instants.
 *
 * The report uses this, and it has to be the same rule that set the due date —
 * otherwise the promise and the measurement of the promise disagree, which is the
 * most corrosive kind of wrong.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  hours: BusinessHoursRow | null | undefined,
): number {
  if (to <= from) return 0;
  if (!hours || !hours.enabled) return Math.round((to.getTime() - from.getTime()) / MINUTE);

  const timeZone = hours.timezone || 'UTC';
  let holidays: Set<string>;
  let anchor: Date;
  try {
    holidays = holidaySet(hours);
    anchor = localMidnight(from, timeZone);
  } catch {
    return Math.round((to.getTime() - from.getTime()) / MINUTE);
  }

  let total = 0;
  let startLocal = partsIn(from, timeZone).minutes;

  for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day += 1) {
    if (anchor.getTime() > to.getTime()) break;
    const at = partsIn(anchor, timeZone);
    for (const window of windowsForLocalDay(hours, at.dow, at.ymd, holidays)) {
      const start = Math.max(window.from, startLocal);
      if (start >= window.to) continue;
      const startAt = anchor.getTime() + start * MINUTE;
      if (startAt >= to.getTime()) break;
      const endAt = Math.min(anchor.getTime() + window.to * MINUTE, to.getTime());
      total += Math.max(0, Math.round((endAt - startAt) / MINUTE));
    }
    anchor = localMidnight(new Date(anchor.getTime() + 36 * 60 * MINUTE), timeZone);
    startLocal = 0;
  }
  return total;
}
