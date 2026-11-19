import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboxInput, Project, SessionMarks, SessionRow, SessionStatus } from '../../src/types.ts';
import { buildInbox, classify, formatSnooze, formatTime, marksToClear, nextWake, snoozeEnd } from '../../src/core/inbox.ts';

const project: Project = { id: 'p1', path: '/w/p', name: 'p', kind: 'dir' };
const NOW = 1_000_000_000_000;
/** The "until it needs input" value of the earlier build, still in old state files. */
const OLD_SENTINEL = 8_640_000_000_000_000;
const YEAR = 365 * 86_400_000;
const HOUR = 3_600_000;

type Outcome = SessionRow['outcome'];

function inp(
  id: string,
  status: SessionStatus,
  marks: SessionMarks = {},
  extra: { updated?: number; activity?: number; outcome?: Outcome } = {},
): InboxInput {
  const row: SessionRow = { id, title: id, directory: '/w/p', created: 1, updated: extra.updated ?? 100, status, archived: false };
  if (extra.outcome) row.outcome = extra.outcome;
  return { row, activity: extra.activity ?? 0, marks, project };
}

test('classify: the first matching rule wins', () => {
  const sec = (i: InboxInput) => classify(i, NOW).section;
  // needs-input beats snooze and settle.
  assert.equal(sec(inp('a', 'needs-input', { snoozedUntil: NOW + 1000, settledAt: NOW })), 'needs-input');
  // A running snooze beats working and settled.
  assert.equal(sec(inp('a', 'working', { snoozedUntil: NOW + 1 })), 'snoozed');
  assert.equal(sec(inp('a', 'idle', { snoozedUntil: NOW + 1000, settledAt: NOW })), 'snoozed');
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
  assert.equal(classify(inp('a', 'idle', { snoozedUntil: OLD_SENTINEL }), NOW).woke, false);
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
      'snoozed:snz_soon', 'snoozed:snz_late',
      'settled:set_new', 'settled:set_old',
    ],
  );
  // Ties are stable by id.
  const tie = buildInbox([inp('b', 'idle', { settledAt: 5 }), inp('a', 'idle', { settledAt: 5 })], NOW);
  assert.deepEqual(tie.map((e) => e.row.id), ['a', 'b']);
});

test('classify: a failed turn after the snooze was set ends it early; other turns do not', () => {
  const set = NOW - 60_000;
  const marks = { snoozedUntil: NOW + HOUR, snoozedAt: set };
  const sec = (outcome: Outcome, activity: number, m: SessionMarks = marks, status: SessionStatus = 'unseen') =>
    classify(inp('a', status, m, { outcome, activity }), NOW);
  const failed = sec('failed', set + 1);
  assert.equal(failed.section, 'open', 'a failed turn after the snooze: Open in the same pass');
  assert.equal(failed.woke, false, 'not "back": the time did not pass');
  assert.equal(sec('failed', set + 1, marks, 'idle').section, 'open');
  assert.equal(sec('failed', set).section, 'snoozed', 'activity not later than snoozedAt');
  assert.equal(sec('failed', set - 5000).section, 'snoozed', 'a failed turn before the snooze');
  assert.equal(sec('succeeded', set + 1).section, 'snoozed', 'a normal end does not end it');
  assert.equal(sec('interrupted', set + 1).section, 'snoozed', 'an interrupted turn does not end it');
  assert.equal(sec(undefined, set + 1).section, 'snoozed');
  assert.equal(sec('failed', set + 1, { snoozedUntil: NOW + HOUR }).section, 'snoozed', 'no snoozedAt (earlier build): no early end');
  assert.equal(sec('failed', set + 1, marks, 'working').section, 'snoozed', 'a new turn runs: the failed outcome is of the turn before');
});

test('classify: an unusable snooze value counts as no snooze', () => {
  const sec = (u: unknown) => classify(inp('a', 'idle', { snoozedUntil: u as number }), NOW).section;
  assert.equal(sec(OLD_SENTINEL), 'open');
  assert.equal(sec(NOW + 11 * YEAR), 'open', 'more than 10 years ahead');
  assert.equal(sec(Infinity), 'open');
  assert.equal(sec(Number.NaN), 'open');
  assert.equal(sec('soon'), 'open');
  assert.equal(sec(NOW + 9 * YEAR), 'snoozed', 'nine years is still a snooze');
  assert.equal(snoozeEnd({ snoozedUntil: OLD_SENTINEL }, NOW), undefined);
  assert.equal(snoozeEnd({ snoozedUntil: NOW + 5 }, NOW), NOW + 5);
  assert.equal(snoozeEnd({}, NOW), undefined);
});

test('marksToClear: a snooze that ended early, and unusable values; both marks go', () => {
  const set = NOW - 60_000;
  const changes = marksToClear(
    [
      inp('ask_snoozed', 'needs-input', { snoozedUntil: NOW + 10 }),
      inp('ask_ended', 'needs-input', { snoozedUntil: NOW - 10 }),
      inp('work_snoozed', 'working', { snoozedUntil: NOW + 10 }),
      inp('ask_plain', 'needs-input'),
      inp('fail_after', 'unseen', { snoozedUntil: NOW + HOUR, snoozedAt: set }, { outcome: 'failed', activity: set + 1 }),
      inp('fail_before', 'idle', { snoozedUntil: NOW + HOUR, snoozedAt: set }, { outcome: 'failed', activity: set - 1 }),
      inp('fail_no_at', 'unseen', { snoozedUntil: NOW + HOUR }, { outcome: 'failed', activity: set + 1 }),
      inp('ok_after', 'unseen', { snoozedUntil: NOW + HOUR, snoozedAt: set }, { outcome: 'succeeded', activity: set + 1 }),
      inp('stop_after', 'unseen', { snoozedUntil: NOW + HOUR, snoozedAt: set }, { outcome: 'interrupted', activity: set + 1 }),
      inp('fail_ended', 'unseen', { snoozedUntil: NOW - 10, snoozedAt: set }, { outcome: 'failed', activity: set + 1 }),
      inp('sentinel', 'idle', { snoozedUntil: OLD_SENTINEL }),
      inp('far', 'idle', { snoozedUntil: NOW + 11 * YEAR, snoozedAt: set }),
    ],
    NOW,
  );
  const clear = { snoozedUntil: undefined, snoozedAt: undefined };
  assert.deepEqual(changes, [
    { id: 'ask_snoozed', patch: clear },
    { id: 'fail_after', patch: clear },
    { id: 'sentinel', patch: clear },
    { id: 'far', patch: clear },
  ]);
  const patch = changes[0]?.patch ?? {};
  assert.ok('snoozedUntil' in patch && 'snoozedAt' in patch, 'the keys are there, with undefined, to delete them');
});

test('nextWake: the earliest real snooze end after now', () => {
  assert.equal(nextWake([], NOW), null);
  assert.equal(
    nextWake([inp('a', 'idle', { snoozedUntil: OLD_SENTINEL }), inp('b', 'idle', { snoozedUntil: NOW - 1 }), inp('c', 'idle', { snoozedUntil: NOW })], NOW),
    null,
  );
  assert.equal(nextWake([inp('a', 'idle', { snoozedUntil: NOW + 50 }), inp('b', 'idle', { snoozedUntil: NOW + 20 }), inp('c', 'idle')], NOW), NOW + 20);
});

const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime();

test('formatSnooze and formatTime: fixed English text from numbers', () => {
  const now = at(2026, 10, 18, 10, 5); // Wednesday
  assert.equal(formatSnooze(at(2026, 10, 18, 14, 30), now), 'until 14:30');
  assert.equal(formatSnooze(at(2026, 10, 19, 9), now), 'until Thu 09:00');
  assert.equal(formatSnooze(at(2026, 10, 24, 9), now), 'until Tue 09:00');
  assert.equal(formatSnooze(at(2026, 10, 25, 9), now), 'until 25 Nov 09:00', 'seven days and more: the date');
  assert.equal(formatSnooze(at(2026, 11, 3, 9), now), 'until 3 Dec 09:00');
  assert.equal(formatSnooze(at(2027, 0, 12, 9), now), 'until 12 Jan 2027 09:00');
  // Over the year end the weekday form still works.
  assert.equal(formatSnooze(at(2027, 0, 1, 9), at(2026, 11, 31, 20)), 'until Fri 09:00');
  // Past times (the information panel) use the date form.
  assert.equal(formatTime(at(2026, 10, 17, 9), now), '17 Nov 09:00');
  assert.equal(formatTime(at(2026, 10, 18, 0, 0), now), '00:00');
});
