import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  isWithinBusinessHours,
  type BusinessHoursRow,
} from '../lib/businessHours.js';

/**
 * The response clock.
 *
 * Everything about response-time targets rests on this arithmetic, and the failure
 * mode is specific: a clock that runs during closed hours tells a team they missed a
 * deadline they never had, every weekend, until they stop believing the report. So the
 * cases here are the ones that produce a false breach — arriving after closing, over a
 * weekend, on a holiday, and the schedule shapes that make a naive implementation
 * count time twice.
 */

/** Mon–Fri 09:00–17:00 Istanbul. */
const OFFICE: BusinessHoursRow = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  rules: [1, 2, 3, 4, 5].map((dow) => ({ dow, intervals: [['09:00', '17:00']] })),
  holidays: [],
};

/** An instant, given Istanbul wall-clock. Istanbul is UTC+3 with no DST. */
const ist = (iso: string): Date => new Date(`${iso}+03:00`);

test('inside opening hours the clock is just the clock', () => {
  // Tuesday 10:00 + 30 open minutes = 10:30.
  const due = addBusinessMinutes(ist('2026-07-28T10:00'), 30, OFFICE);
  assert.equal(due?.toISOString(), ist('2026-07-28T10:30').toISOString());
});

test('a message arriving after closing is due the next morning, not overnight', () => {
  // THE case this exists for. Tuesday 17:50 + 30 minutes is NOT 18:20.
  const due = addBusinessMinutes(ist('2026-07-28T17:50'), 30, OFFICE);
  assert.equal(due?.toISOString(), ist('2026-07-29T09:30').toISOString());
});

test('a message arriving before opening waits for the doors, not for the target', () => {
  const due = addBusinessMinutes(ist('2026-07-28T06:00'), 45, OFFICE);
  assert.equal(due?.toISOString(), ist('2026-07-28T09:45').toISOString());
});

test('Friday evening is due Monday morning', () => {
  // 2026-07-31 is a Friday. 17:30 + 60 open minutes → Monday 10:00.
  const due = addBusinessMinutes(ist('2026-07-31T17:30'), 60, OFFICE);
  assert.equal(due?.toISOString(), ist('2026-08-03T10:00').toISOString());
});

test('a target longer than one working day rolls onto the following days', () => {
  // 8h/day. Friday 16:00 + 10 open hours: 1h Friday, 8h Monday, 1h Tuesday → Tue 10:00.
  const due = addBusinessMinutes(ist('2026-07-31T16:00'), 600, OFFICE);
  assert.equal(due?.toISOString(), ist('2026-08-04T10:00').toISOString());
});

test('a holiday contributes nothing', () => {
  const withHoliday: BusinessHoursRow = {
    ...OFFICE,
    holidays: [{ date: '2026-07-29', label: 'Closed' }],
  };
  // Tuesday 16:30 + 60 minutes: 30 min Tuesday, Wednesday is closed, so Thursday 09:30.
  const due = addBusinessMinutes(ist('2026-07-28T16:30'), 60, withHoliday);
  assert.equal(due?.toISOString(), ist('2026-07-30T09:30').toISOString());
});

test('hours switched off means wall-clock targets, not no targets', () => {
  const always: BusinessHoursRow = { ...OFFICE, enabled: false };
  const from = ist('2026-08-01T23:30'); // A Saturday night.
  const due = addBusinessMinutes(from, 60, always);
  assert.equal(due?.getTime(), from.getTime() + 60 * 60_000);
});

test('a schedule that never opens produces NO due date rather than a wrong one', () => {
  // Null, not a guess. An invented deadline is a false breach, and false breaches are
  // how a team learns to ignore the feature.
  const never: BusinessHoursRow = { ...OFFICE, rules: [] };
  assert.equal(addBusinessMinutes(ist('2026-07-28T10:00'), 30, never), null);

  const alsoNever: BusinessHoursRow = { ...OFFICE, rules: [{ dow: 2, intervals: [['09:00', '09:00']] }] };
  assert.equal(addBusinessMinutes(ist('2026-07-28T10:00'), 30, alsoNever), null);
});

test('overlapping intervals do not make the clock run fast', () => {
  // 09:00–13:00 and 12:00–17:00 is eight open hours, not nine. Counting the shared
  // hour twice would show a team answering faster than they do.
  const overlapping: BusinessHoursRow = {
    ...OFFICE,
    rules: [{ dow: 2, intervals: [['09:00', '13:00'], ['12:00', '17:00']] }],
  };
  assert.equal(
    businessMinutesBetween(ist('2026-07-28T00:00'), ist('2026-07-29T00:00'), overlapping),
    8 * 60,
  );
});

test('a split day skips the lunch break', () => {
  const split: BusinessHoursRow = {
    ...OFFICE,
    rules: [{ dow: 2, intervals: [['09:00', '12:00'], ['13:00', '17:00']] }],
  };
  // 11:45 + 30 minutes: 15 min before lunch, 15 after → 13:15.
  const due = addBusinessMinutes(ist('2026-07-28T11:45'), 30, split);
  assert.equal(due?.toISOString(), ist('2026-07-28T13:15').toISOString());
});

test('a night shift spanning midnight is counted on both sides', () => {
  // 22:00–02:00 on Tuesday means four open hours, two of them on Wednesday.
  const night: BusinessHoursRow = {
    ...OFFICE,
    rules: [{ dow: 2, intervals: [['22:00', '02:00']] }],
  };
  // isWithinBusinessHours must agree. It did NOT before this: on the far side of
  // midnight it looked up Wednesday's rules, found none, and reported closed — so a
  // team working a declared shift had their widget go offline mid-shift. Two answers
  // to "are we open" is the corrosive kind of bug, so both now share one window builder.
  assert.equal(isWithinBusinessHours(night, ist('2026-07-28T23:00')), true);
  assert.equal(isWithinBusinessHours(night, ist('2026-07-29T01:00')), true);
  assert.equal(isWithinBusinessHours(night, ist('2026-07-29T03:00')), false);

  // 23:30 + 60 minutes crosses midnight into Wednesday's spillover.
  const due = addBusinessMinutes(ist('2026-07-28T23:30'), 60, night);
  assert.equal(due?.toISOString(), ist('2026-07-29T00:30').toISOString());

  assert.equal(
    businessMinutesBetween(ist('2026-07-28T00:00'), ist('2026-07-30T00:00'), night),
    4 * 60,
  );
});

test('measuring and promising use the same rule', () => {
  // If these ever disagree, the report contradicts the deadline it is reporting on.
  const from = ist('2026-07-28T16:30');
  const due = addBusinessMinutes(from, 120, OFFICE)!;
  assert.equal(businessMinutesBetween(from, due, OFFICE), 120);
});

test('open minutes ignore the closed stretch between two days', () => {
  // Tuesday 16:00 → Wednesday 10:00 is 1h + 1h of open time, not 18h.
  assert.equal(
    businessMinutesBetween(ist('2026-07-28T16:00'), ist('2026-07-29T10:00'), OFFICE),
    120,
  );
});

test('a weekend contributes nothing', () => {
  // Saturday to Sunday.
  assert.equal(
    businessMinutesBetween(ist('2026-08-01T00:00'), ist('2026-08-03T00:00'), OFFICE),
    0,
  );
});

test('a timezone that observes DST still lands on the right wall clock', () => {
  const london: BusinessHoursRow = {
    ...OFFICE,
    timezone: 'Europe/London',
    rules: [1, 2, 3, 4, 5].map((dow) => ({ dow, intervals: [['09:00', '17:00']] })),
  };
  // The clocks go back on 2026-10-25 in the UK. Friday 2026-10-23 16:30 + 60 open
  // minutes must be Monday 2026-10-26 09:30 LOCAL, which is 09:30 GMT — an
  // implementation adding a fixed 24h per day lands an hour out here.
  const due = addBusinessMinutes(new Date('2026-10-23T16:30:00+01:00'), 60, london);
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(due!);
  assert.match(local, /Mon.*09:30/);
});

test('an invalid timezone falls back rather than throwing', () => {
  const broken: BusinessHoursRow = { ...OFFICE, timezone: 'Not/AZone' };
  const from = ist('2026-07-28T10:00');
  const due = addBusinessMinutes(from, 30, broken);
  assert.ok(due instanceof Date, 'still returns a date');
  assert.equal(businessMinutesBetween(from, new Date(from.getTime() + 60_000), broken), 1);
});

test('a zero or negative target is the arrival instant', () => {
  const from = ist('2026-07-28T10:00');
  assert.equal(addBusinessMinutes(from, 0, OFFICE)?.getTime(), from.getTime());
  assert.equal(addBusinessMinutes(from, -5, OFFICE)?.getTime(), from.getTime());
  assert.equal(businessMinutesBetween(from, from, OFFICE), 0);
  assert.equal(businessMinutesBetween(from, new Date(from.getTime() - 1000), OFFICE), 0);
});
