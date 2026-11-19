import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SNOOZE_UNTIL_INPUT, type InboxInput, type Project, type SessionMarks, type SessionRow, type SessionStatus } from '../../src/types.ts';
import {
  buildInbox, classify, formatSnooze, formatTime, marksToClear, nextWake, SNOOZE_PRESETS, snoozeUntil,
} from '../../src/core/inbox.ts';

const project: Project = { id: 'p1', path: '/w/p', name: 'p', kind: 'dir' };
const NOW = 1_000_000_000_000;

function inp(id: string, status: SessionStatus, marks: SessionMarks = {}, extra: { updated?: number; activity?: number } = {}): InboxInput {
  const row: SessionRow = { id, title: id, directory: '/w/p', created: 1, updated: extra.updated ?? 100, status, archived: false };
  return { row, activity: extra.activity ?? 0, marks, project };
}

test('classify: the first matching rule wins', () => {
  const sec = (i: InboxInput) => classify(i, NOW).section;
  // needs-input beats snooze and settle.
  assert.equal(sec(inp('a', 'needs-input', { snoozedUntil: NOW + 1000, settledAt: NOW })), 'needs-input');
  // A running snooze beats working and settled.
  assert.equal(sec(inp('a', 'working', { snoozedUntil: NOW + 1 })), 'snoozed');
  assert.equal(sec(inp('a', 'idle', { snoozedUntil: SNOOZE_UNTIL_INPUT, settledAt: NOW })), 'snoozed');
  // An ended snooze does not count.
  assert.equal(sec(inp('a', 'working', { snoozedUntil: NOW })), 'working');
  assert.equal(sec(inp('a', 'idle', { snoozedUntil: NOW - 5 })), 'open');
  // working beats settled.
  assert.equal(sec(inp('a', 'working', { settledAt: NOW })), 'working');
  // settled: idle and no later activity.
  assert.equal(sec(inp('a', 'idle', { settledAt: 500 }, { activity: 500 })), 'settled');
  assert.equal(sec(inp('a', 'idle', { settledAt: 500 }, { activity: 400 })), 'settled');
  assert.equal(sec(inp('a', 'idle', { settledAt: 500 }, { activity: 501 })), 'open', 'new activity brings it back');
  assert.equal(sec(inp('a', 'unseen', { settledAt: 500 }, { activity: 100 })), 'open', 'an unseen turn is not settled');
  assert.equal(sec(inp('a', 'idle')), 'open');
  assert.equal(sec(inp('a', 'unseen')), 'open');
});

test('classify: woke after the snooze time until the user opens the session', () => {
  const at = NOW - 60_000;
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: at }), NOW).woke, true);
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: at, lastSeen: at - 1 }), NOW).woke, true);
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: at, lastSeen: at }), NOW).woke, false, 'seen at or after the time');
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: NOW + 1 }), NOW).woke, false, 'still snoozed');
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: SNOOZE_UNTIL_INPUT }), NOW).woke, false);
  assert.equal(classify(inp('a', 'idle'), NOW).woke, false);
  // Woke also shows in another section (a working session that came back).
  const w = classify(inp('a', 'working', { snoozedUntil: at }), NOW);
  assert.equal(w.section, 'working');
  assert.equal(w.woke, true);
});

test('buildInbox: section order, then the order inside each section', () => {
  const list = buildInbox(
    [
      inp('set_old', 'idle', { settledAt: 10 }),
      inp('set_new', 'idle', { settledAt: 20 }),
      inp('snz_input', 'idle', { snoozedUntil: SNOOZE_UNTIL_INPUT }),
      inp('snz_late', 'idle', { snoozedUntil: NOW + 5000 }),
      inp('snz_soon', 'working', { snoozedUntil: NOW + 1000 }),
      inp('open_old', 'idle', {}, { updated: 10 }),
      inp('open_new', 'idle', {}, { updated: 90 }),
      inp('open_unseen', 'unseen', {}, { updated: 5 }),
      inp('open_woke', 'idle', { snoozedUntil: NOW - 1 }, { updated: 1 }),
      inp('work_b', 'working', {}, { updated: 50 }),
      inp('work_a', 'working', {}, { updated: 50 }),
      inp('work_new', 'working', {}, { updated: 70 }),
      inp('ask_old', 'needs-input', {}, { updated: 1 }),
      inp('ask_new', 'needs-input', {}, { updated: 2 }),
    ],
    NOW,
  );
  assert.deepEqual(
    list.map((e) => `${e.section}:${e.row.id}`),
    [
      'needs-input:ask_new', 'needs-input:ask_old',
      'working:work_new', 'working:work_a', 'working:work_b',
      // Woke and unseen first (newest first among them), then the rest by update time.
      'open:open_unseen', 'open:open_woke', 'open:open_new', 'open:open_old',
      'snoozed:snz_soon', 'snoozed:snz_late', 'snoozed:snz_input',
      'settled:set_new', 'settled:set_old',
    ],
  );
  // Ties are stable by id.
  const tie = buildInbox([inp('b', 'idle', { settledAt: 5 }), inp('a', 'idle', { settledAt: 5 })], NOW);
  assert.deepEqual(tie.map((e) => e.row.id), ['a', 'b']);
});

test('marksToClear: only a running snooze of a session that needs input', () => {
  const changes = marksToClear(
    [
      inp('ask_snoozed', 'needs-input', { snoozedUntil: NOW + 10 }),
      inp('ask_input', 'needs-input', { snoozedUntil: SNOOZE_UNTIL_INPUT }),
      inp('ask_ended', 'needs-input', { snoozedUntil: NOW - 10 }),
      inp('work_snoozed', 'working', { snoozedUntil: NOW + 10 }),
      inp('ask_plain', 'needs-input'),
    ],
    NOW,
  );
  assert.deepEqual(changes, [
    { id: 'ask_snoozed', patch: { snoozedUntil: undefined } },
    { id: 'ask_input', patch: { snoozedUntil: undefined } },
  ]);
  assert.ok('snoozedUntil' in (changes[0]?.patch ?? {}), 'the key is there, with undefined, to delete it');
});

test('nextWake: the earliest real snooze end after now', () => {
  assert.equal(nextWake([], NOW), null);
  assert.equal(
    nextWake([inp('a', 'idle', { snoozedUntil: SNOOZE_UNTIL_INPUT }), inp('b', 'idle', { snoozedUntil: NOW - 1 }), inp('c', 'idle', { snoozedUntil: NOW })], NOW),
    null,
  );
  assert.equal(nextWake([inp('a', 'idle', { snoozedUntil: NOW + 50 }), inp('b', 'idle', { snoozedUntil: NOW + 20 }), inp('c', 'idle')], NOW), NOW + 20);
});

const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime();

test('snooze presets: hours, tomorrow and next Monday in local time', () => {
  assert.deepEqual(SNOOZE_PRESETS.map((p) => p.key), ['1', '3', 't', 'w', 'i']);
  const now = at(2026, 10, 18, 14, 30); // Wednesday 18 Nov 2026
  assert.equal(new Date(now).getDay(), 3);
  assert.equal(snoozeUntil('hour', now), now + 3_600_000);
  assert.equal(snoozeUntil('three-hours', now), now + 3 * 3_600_000);
  assert.equal(snoozeUntil('tomorrow', now), at(2026, 10, 19, 9));
  assert.equal(snoozeUntil('monday', now), at(2026, 10, 23, 9));
  assert.equal(snoozeUntil('input', now), SNOOZE_UNTIL_INPUT);
  // Month and year ends.
  assert.equal(snoozeUntil('tomorrow', at(2026, 10, 30, 23, 59)), at(2026, 11, 1, 9));
  assert.equal(snoozeUntil('tomorrow', at(2026, 11, 31, 8)), at(2027, 0, 1, 9));
  assert.equal(snoozeUntil('monday', at(2026, 11, 30, 10)), at(2027, 0, 4, 9)); // Wednesday 30 Dec
  // On a Monday: the Monday of next week, even before 09:00.
  const monday = at(2026, 10, 16, 7);
  assert.equal(new Date(monday).getDay(), 1);
  assert.equal(snoozeUntil('monday', monday), at(2026, 10, 23, 9));
  // Sunday: the next day.
  assert.equal(snoozeUntil('monday', at(2026, 10, 22, 22)), at(2026, 10, 23, 9));
  // Every result of a calendar preset is 09:00 local, also across DST changes of any zone.
  for (let day = 0; day < 400; day += 3) {
    const n = at(2026, 0, 1 + day, 12);
    for (const id of ['tomorrow', 'monday'] as const) {
      const d = new Date(snoozeUntil(id, n));
      assert.deepEqual([d.getHours(), d.getMinutes()], [9, 0], `${id} from day ${day}`);
      assert.ok(d.getTime() > n);
    }
  }
});

test('formatSnooze and formatTime: fixed English text from numbers', () => {
  const now = at(2026, 10, 18, 10, 5); // Wednesday
  assert.equal(formatSnooze(at(2026, 10, 18, 14, 30), now), 'until 14:30');
  assert.equal(formatSnooze(at(2026, 10, 19, 9), now), 'until Thu 09:00');
  assert.equal(formatSnooze(at(2026, 10, 24, 9), now), 'until Tue 09:00');
  assert.equal(formatSnooze(at(2026, 10, 25, 9), now), 'until 25 Nov 09:00', 'seven days and more: the date');
  assert.equal(formatSnooze(at(2026, 11, 3, 9), now), 'until 3 Dec 09:00');
  assert.equal(formatSnooze(at(2027, 0, 12, 9), now), 'until 12 Jan 2027 09:00');
  assert.equal(formatSnooze(SNOOZE_UNTIL_INPUT, now), 'until input');
  // Over the year end the weekday form still works.
  assert.equal(formatSnooze(at(2027, 0, 1, 9), at(2026, 11, 31, 20)), 'until Fri 09:00');
  // Past times (the information panel) use the date form.
  assert.equal(formatTime(at(2026, 10, 17, 9), now), '17 Nov 09:00');
  assert.equal(formatTime(at(2026, 10, 18, 0, 0), now), '00:00');
});
