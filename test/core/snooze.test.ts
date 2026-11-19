import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SNOOZE_PRESETS, type SnoozeDay, type SnoozePreset } from '../../src/types.ts';
import { formatTime } from '../../src/core/inbox.ts';
import { parseSnoozePresets, parseSnoozeTime, resolveSnoozePreset, snoozeChoices, snoozeLabel } from '../../src/core/snooze.ts';

// Local times, so the tests pass in any time zone.
const at = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, m, d, h, mi, s).getTime();
const WED = at(2026, 10, 18, 14, 30); // Wednesday 18 Nov 2026
const MIN = 60_000;
const after = (minutes: number): SnoozePreset => ({ kind: 'after', minutes });
const atDay = (day: SnoozeDay, time: string): SnoozePreset => ({ kind: 'at', day, time });

test('the reference days are the weekdays the tests assume', () => {
  assert.equal(new Date(WED).getDay(), 3);
  assert.equal(new Date(at(2026, 10, 16)).getDay(), 1);
  assert.equal(new Date(at(2026, 10, 30)).getDay(), 1);
  assert.equal(new Date(at(2026, 11, 31)).getDay(), 4);
});

test('parseSnoozePresets: a good list is copied, extra keys are ignored', () => {
  assert.deepEqual(parseSnoozePresets(DEFAULT_SNOOZE_PRESETS), DEFAULT_SNOOZE_PRESETS);
  assert.deepEqual(parseSnoozePresets([{ kind: 'after', minutes: 30, note: 'x' }, { kind: 'at', day: 'friday', time: '23:59' }]), [
    after(30),
    atDay('friday', '23:59'),
  ]);
  assert.deepEqual(parseSnoozePresets([after(1)]), [after(1)]);
  assert.deepEqual(parseSnoozePresets([after(525_600)]), [after(525_600)]);
  assert.equal(parseSnoozePresets(Array.from({ length: 8 }, (_, i) => after(i + 1)))?.length, 8);
  for (const day of ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
    assert.ok(parseSnoozePresets([{ kind: 'at', day, time: '00:00' }]), day);
  }
});

test('parseSnoozePresets: one bad item makes the whole list invalid', () => {
  const good = { kind: 'after', minutes: 60 };
  const bad: unknown[] = [
    { kind: 'after', minutes: 0 },
    { kind: 'after', minutes: 525_601 },
    { kind: 'after', minutes: 1.5 },
    { kind: 'after', minutes: '60' },
    { kind: 'after', minutes: Number.NaN },
    { kind: 'after' },
    { kind: 'at', day: 'someday', time: '09:00' },
    { kind: 'at', day: 'Monday', time: '09:00' },
    { kind: 'at', time: '09:00' },
    { kind: 'at', day: 'today', time: '9:00' },
    { kind: 'at', day: 'today', time: '24:00' },
    { kind: 'at', day: 'today', time: '12:60' },
    { kind: 'at', day: 'today', time: '12:00 ' },
    { kind: 'at', day: 'today' },
    { kind: 'later', minutes: 5 },
    {},
    null,
    [good],
    'after 60',
    60,
  ];
  for (const item of bad) assert.equal(parseSnoozePresets([good, item]), null, JSON.stringify(item));
  assert.equal(parseSnoozePresets([]), null, 'empty');
  assert.equal(parseSnoozePresets(Array.from({ length: 9 }, () => good)), null, 'nine items');
  assert.equal(parseSnoozePresets(undefined), null);
  assert.equal(parseSnoozePresets(null), null);
  assert.equal(parseSnoozePresets({ 0: good, length: 1 }), null, 'not an array');
});

test('resolveSnoozePreset: every day value, in local time', () => {
  assert.equal(resolveSnoozePreset(after(60), WED), WED + 60 * MIN);
  assert.equal(resolveSnoozePreset(after(525_600), WED), WED + 525_600 * MIN);
  const cases: Array<[SnoozeDay, number]> = [
    ['today', at(2026, 10, 18, 18)],
    ['tomorrow', at(2026, 10, 19, 18)],
    ['thursday', at(2026, 10, 19, 18)],
    ['friday', at(2026, 10, 20, 18)],
    ['saturday', at(2026, 10, 21, 18)],
    ['sunday', at(2026, 10, 22, 18)],
    ['monday', at(2026, 10, 23, 18)],
    ['tuesday', at(2026, 10, 24, 18)],
    // The weekday of today: the same weekday of next week, even when the time is still ahead.
    ['wednesday', at(2026, 10, 25, 18)],
  ];
  for (const [day, want] of cases) assert.equal(resolveSnoozePreset(atDay(day, '18:00'), WED), want, day);
  // On a Monday, monday is the Monday of next week.
  assert.equal(resolveSnoozePreset(atDay('monday', '09:00'), at(2026, 10, 16, 7)), at(2026, 10, 23, 9));
  // Month end: Monday 30 Nov.
  const nov30 = at(2026, 10, 30, 10);
  assert.equal(resolveSnoozePreset(atDay('tomorrow', '09:00'), nov30), at(2026, 11, 1, 9));
  assert.equal(resolveSnoozePreset(atDay('wednesday', '09:00'), nov30), at(2026, 11, 2, 9));
  assert.equal(resolveSnoozePreset(atDay('monday', '09:00'), nov30), at(2026, 11, 7, 9));
  // Year end: Thursday 31 Dec.
  const dec31 = at(2026, 11, 31, 20);
  assert.equal(resolveSnoozePreset(atDay('today', '23:30'), dec31), at(2026, 11, 31, 23, 30));
  assert.equal(resolveSnoozePreset(atDay('tomorrow', '09:00'), dec31), at(2027, 0, 1, 9));
  assert.equal(resolveSnoozePreset(atDay('friday', '09:00'), dec31), at(2027, 0, 1, 9));
  assert.equal(resolveSnoozePreset(atDay('monday', '09:00'), dec31), at(2027, 0, 4, 9));
  assert.equal(resolveSnoozePreset(atDay('thursday', '09:00'), dec31), at(2027, 0, 7, 9));
  // Every day of a year (both DST changes of any zone): the wanted local time, on a later day.
  const days: SnoozeDay[] = ['tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (let i = 0; i < 400; i++) {
    const n = at(2026, 0, 1 + i, 12);
    for (const day of days) {
      const d = new Date(resolveSnoozePreset(atDay(day, '09:00'), n));
      assert.deepEqual([d.getHours(), d.getMinutes()], [9, 0], `${day} from day ${i}`);
      assert.ok(d.getTime() > n);
      const ahead = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - at(2026, 0, 1 + i)) / 86_400_000);
      assert.ok(ahead >= 1 && ahead <= 7, `${day} from day ${i}: ${ahead} days`);
    }
  }
});

test('snoozeLabel: the words of T3 Code', () => {
  const label = (p: SnoozePreset, now = WED) => snoozeLabel(p, resolveSnoozePreset(p, now), now);
  assert.equal(label(after(1)), 'In 1 minute');
  assert.equal(label(after(30)), 'In 30 minutes');
  assert.equal(label(after(90)), 'In 90 minutes');
  assert.equal(label(after(60)), 'In 1 hour');
  assert.equal(label(after(180)), 'In 3 hours');
  assert.equal(label(after(1440)), 'In 1 day');
  assert.equal(label(after(2880)), 'In 2 days');
  assert.equal(label(after(1500)), 'In 25 hours');
  assert.equal(label(atDay('today', '09:00')), 'This morning');
  assert.equal(label(atDay('today', '11:59')), 'This morning');
  assert.equal(label(atDay('today', '12:00')), 'This afternoon');
  assert.equal(label(atDay('today', '16:59')), 'This afternoon');
  assert.equal(label(atDay('today', '17:00')), 'This evening');
  assert.equal(label(atDay('tomorrow', '09:00')), 'Tomorrow');
  assert.equal(label(atDay('thursday', '09:00')), 'Tomorrow', 'a weekday that is tomorrow');
  assert.equal(label(atDay('monday', '09:00')), 'Next week');
  assert.equal(label(atDay('monday', '09:00'), at(2026, 10, 16, 7)), 'Next week', 'on a Monday');
  assert.equal(label(atDay('monday', '09:00'), at(2026, 10, 22, 10)), 'Tomorrow', 'on a Sunday');
  assert.equal(label(atDay('friday', '09:00')), 'Friday');
  assert.equal(label(atDay('tuesday', '09:00')), 'Tuesday');
  assert.equal(label(atDay('wednesday', '09:00')), 'Next Wednesday', 'the weekday of today');
});

test('snoozeChoices: the defaults, soonest first, with their times', () => {
  const show = (now: number, presets: readonly SnoozePreset[] = DEFAULT_SNOOZE_PRESETS) =>
    snoozeChoices(presets, now).map((c) => `${c.label} ${formatTime(c.until, now)}`);
  assert.deepEqual(show(WED), ['In 1 hour 15:30', 'In 3 hours 17:30', 'This evening 18:00', 'Tomorrow Thu 09:00', 'Next week Mon 09:00']);
  // At 16:00 the 3 hours choice is later than today 18:00.
  assert.deepEqual(show(at(2026, 10, 18, 16)), ['In 1 hour 17:00', 'This evening 18:00', 'In 3 hours 19:00', 'Tomorrow Thu 09:00', 'Next week Mon 09:00']);
  // At 19:00 "today 18:00" has passed: it is not offered.
  assert.deepEqual(show(at(2026, 10, 18, 19)), ['In 1 hour 20:00', 'In 3 hours 22:00', 'Tomorrow Thu 09:00', 'Next week Mon 09:00']);
  // Exactly at 18:00 it is not later than now either.
  assert.ok(!show(at(2026, 10, 18, 18)).some((l) => l.startsWith('This evening')));
  // Same minute: the first in the sorted order stays.
  assert.deepEqual(show(at(2026, 10, 18, 15)), ['In 1 hour 16:00', 'In 3 hours 18:00', 'Tomorrow Thu 09:00', 'Next week Mon 09:00']);
  assert.deepEqual(show(at(2026, 10, 18, 15, 0, 30)), ['In 1 hour 16:00', 'This evening 18:00', 'Tomorrow Thu 09:00', 'Next week Mon 09:00']);
  // On a Sunday next Monday is tomorrow: one line.
  assert.deepEqual(show(at(2026, 10, 22, 10)), ['In 1 hour 11:00', 'In 3 hours 13:00', 'This evening 18:00', 'Tomorrow Mon 09:00']);
  // A custom list, sorted by time, not by its order.
  assert.deepEqual(show(WED, [atDay('friday', '08:00'), after(30), atDay('today', '09:00')]), ['In 30 minutes 15:00', 'Friday Fri 08:00']);
});

test('parseSnoozeTime: each form in local time', () => {
  const p = (t: string, now = WED) => parseSnoozeTime(t, now);
  // HH:MM: today, or tomorrow when the time is not later than now.
  assert.equal(p('17:30'), at(2026, 10, 18, 17, 30));
  assert.equal(p('09:00'), at(2026, 10, 19, 9));
  assert.equal(p('14:30'), at(2026, 10, 19, 14, 30), 'now itself: tomorrow');
  assert.equal(p('7:05'), at(2026, 10, 19, 7, 5));
  assert.equal(p(' 23:59 '), at(2026, 10, 18, 23, 59));
  assert.equal(p('09:00', at(2026, 11, 31, 20)), at(2027, 0, 1, 9), 'over the year end');
  assert.equal(p('24:00'), null);
  assert.equal(p('12:60'), null);
  // Dates.
  assert.equal(p('2026-12-01 10:15'), at(2026, 11, 1, 10, 15));
  assert.equal(p('2026-12-01T10:15'), at(2026, 11, 1, 10, 15));
  assert.equal(p('2026-12-01'), at(2026, 11, 1, 9));
  assert.equal(p('2028-02-29'), at(2028, 1, 29, 9));
  assert.equal(p('2026-11-18 15:00'), at(2026, 10, 18, 15));
  assert.equal(p('2026-02-31'), null, 'impossible date');
  assert.equal(p('2027-02-29'), null, 'not a leap year');
  assert.equal(p('2026-13-01'), null);
  assert.equal(p('2026-12-00'), null);
  assert.equal(p('2026-12-01 25:00'), null);
  assert.equal(p('2026-11-18'), null, '09:00 today has passed');
  assert.equal(p('2026-11-18 14:30'), null, 'not later than now');
  assert.equal(p('2025-12-01'), null);
  assert.equal(p('2040-01-01'), null, 'more than 10 years ahead');
  // Durations.
  assert.equal(p('30m'), WED + 30 * MIN);
  assert.equal(p('2h'), WED + 120 * MIN);
  assert.equal(p('3d'), WED + 3 * 1440 * MIN);
  assert.equal(p('1w'), WED + 7 * 1440 * MIN);
  assert.equal(p('90 m'), WED + 90 * MIN);
  assert.equal(p('2H'), WED + 120 * MIN);
  assert.equal(p(' 45M '), WED + 45 * MIN);
  // Anything else.
  for (const t of ['', 'abc', '0m', '-5m', '2x', '1.5h', 'tomorrow', '2026/12/01', '12', 'm']) assert.equal(p(t), null, t);
});
