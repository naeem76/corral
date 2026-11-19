import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InputEvent } from '../../src/types.ts';
import { samePath } from '../../src/core/paths.ts';
import { FakeClock, harness, modal, until, type Harness } from './helpers.ts';
import { inboxFixture } from './inbox-fixture.ts';

const HOUR = 3_600_000;

/** Section of a session in the inbox, or undefined when it is not in the list. */
const sectionOf = (h: Harness, id: string) => h.app.inbox.entry(id)?.section;
/** Rows inside the list box (the selection bar removed), top to bottom, without empty rows. */
function listLines(h: Harness): string[] {
  const lay = h.app.layout();
  const box = lay.list ?? lay.columns?.[2];
  if (!box) return [];
  return h
    .screen()
    .slice(box.y + 1, box.y + box.h - 1)
    .map((l) => [...l].slice(box.x + 1, box.x + box.w - 1).join('').replace(/^▌/, '').trim())
    .filter((l) => l);
}
/** The list row that shows `text` (inbox list, or the Sessions column in the projects view). */
const lineWith = (h: Harness, text: string) => listLines(h).find((l) => l.includes(text));

function click(h: Harness, x: number, y: number): void {
  const ev: InputEvent = { type: 'mouse', x, y, button: 'left', action: 'down', ctrl: false, alt: false, shift: false, raw: '' };
  h.term.events([ev, { ...ev, action: 'up' }]);
}

/**
 * A clock at a fixed local weekday and time: the Wednesday at least a week after today, so the
 * snooze menu is the same on every run.
 */
function wednesdayClock(hour: number, minute = 0): FakeClock {
  const d = new Date();
  const ahead = 7 + ((3 - d.getDay() + 7) % 7 || 7);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ahead, hour, minute).getTime();
  const clock = new FakeClock();
  clock.offset = target - Date.now();
  return clock;
}

/** The lines of the open modal box (between its borders), trimmed. */
function modalLines(h: Harness): string[] {
  const lines = h.screen();
  const top = lines.findIndex((l) => /╭.*(Snooze)/.test(l));
  if (top < 0) return [];
  const bottom = lines.findIndex((l, i) => i > top && l.includes('╰'));
  const left = [...(lines[top] as string)].indexOf('╭');
  const right = [...(lines[top] as string)].indexOf('╮');
  return lines.slice(top, bottom + 1).map((l) => [...l].slice(left, right + 1).join(''));
}

/** Sessions used by most tests: two projects and a worktree. */
function standard(t = Date.now() - HOUR) {
  return (f: { alpha: string; worktree: string; beta: string }, h: Harness) => {
    h.service.addSession({ id: 'ses_a1', directory: f.alpha, title: 'Alpha one', updated: t });
    h.service.addSession({ id: 'ses_a2', directory: f.alpha, title: 'Alpha two', updated: t - 1000 });
    h.service.addSession({ id: 'ses_w1', directory: f.worktree, title: 'Worktree one', updated: t - 2000 });
    h.service.addSession({ id: 'ses_b1', directory: f.beta, title: 'Beta one', updated: t - 3000 });
    h.service.addSession({ id: 'ses_old', directory: f.beta, title: 'Archived one', updated: t - 4000, archived: t });
    h.service.addSession({ id: 'ses_child', directory: f.beta, title: 'Child one', updated: t, parentID: 'ses_b1' });
  };
}

test('v switches between the views and the choice is saved', async () => {
  const { h, beta } = await inboxFixture(standard(), { view: 'projects' });
  try {
    assert.equal(h.app.view, 'projects');
    // Select Beta one in the Sessions column, then switch: the inbox selects it too.
    h.app.selectSession(h.store.projects[1]!, beta, 'ses_b1');
    h.app.focus = 'sessions';
    await h.type('v', 60);
    assert.equal(h.app.view, 'inbox');
    assert.equal(h.app.focus, 'inbox');
    assert.equal(h.store.ui.view, 'inbox');
    assert.equal(h.app.selectedSession()?.id, 'ses_b1');
    assert.match(h.text(), /Inbox · 4/);
    // Move in the inbox, switch back: the projects view shows that session.
    await until(() => sectionOf(h, 'ses_w1') !== undefined, 3000, 'worktree loaded');
    h.app.inbox.select('ses_w1');
    await h.type('v', 60);
    assert.equal(h.app.view, 'projects');
    assert.equal(h.store.ui.view, 'projects');
    assert.equal(h.app.focus, 'sessions');
    assert.equal(h.app.selectedProject()?.name, 'alpha');
    assert.equal(h.app.selectedSession()?.id, 'ses_w1');
    assert.match(h.text(), /Projects/);
  } finally {
    await h.dispose();
  }
});

test('sessions of two projects and a worktree are in sections with headers and counts', async () => {
  const { h, alpha, worktree, beta } = await inboxFixture(standard());
  try {
    assert.equal(h.app.view, 'inbox');
    h.events.emit('session.execution.started', { sessionID: 'ses_a2' }, alpha);
    h.events.emit('permission.asked', { id: 'per_1', sessionID: 'ses_b1' }, beta);
    await h.settle();
    assert.deepEqual(listLines(h).map((l) => l.replace(/\s{2,}.*$/, '')), [
      'Needs input (1)', '● Beta one',
      'Working (1)', '● Alpha two',
      'Open (2)', '● Alpha one', '● Worktree one',
    ]);
    // Archived and child sessions are not in the inbox.
    assert.equal(sectionOf(h, 'ses_old'), undefined);
    assert.equal(sectionOf(h, 'ses_child'), undefined);
    // The worktree row names its project and branch; rows show the age.
    assert.match(lineWith(h, 'Worktree one') ?? '', /alpha · feature\s+1h/);
    assert.match(lineWith(h, 'Beta one') ?? '', /beta\s+1h/);
    const e = h.app.inbox.entry('ses_w1');
    assert.ok(e?.checkout && samePath(e.checkout.path, worktree, process.platform));
    // The tracker watches all folders of all projects.
    assert.equal(h.tracker.rows(worktree).length, 1);
  } finally {
    await h.dispose();
  }
});

test('a request for input moves a snoozed session to Needs input and ends the snooze for good', async () => {
  const { h, beta } = await inboxFixture(standard());
  try {
    h.store.setSessionMeta('ses_b1', { snoozedUntil: h.clock.now() + 5 * HOUR });
    await h.settle();
    assert.equal(sectionOf(h, 'ses_b1'), 'snoozed');
    h.events.emit('permission.asked', { id: 'per_1', sessionID: 'ses_b1' }, beta);
    await until(() => sectionOf(h, 'ses_b1') === 'needs-input', 2000, 'needs input');
    await until(() => h.store.sessionMeta('ses_b1')?.snoozedUntil === undefined, 2000, 'snooze removed');
    h.events.emit('permission.replied', { requestID: 'per_1' }, beta);
    await until(() => sectionOf(h, 'ses_b1') === 'open', 2000, 'back in Open, not Snoozed');
  } finally {
    await h.dispose();
  }
});

test('snooze from the menu; the session comes back with a tag when the time passes; opening removes it', async () => {
  const { h } = await inboxFixture(standard());
  try {
    h.app.inbox.select('ses_a1');
    await h.type('s');
    const m = modal(h);
    assert.equal(m?.kind, 'menu');
    const t = h.text();
    assert.ok(t.includes('In 1 hour'));
    assert.ok(!t.includes('Remove the snooze'));
    await h.type('1');
    assert.equal(modal(h), null);
    const until1 = h.store.sessionMeta('ses_a1')?.snoozedUntil as number;
    assert.ok(Math.abs(until1 - (h.clock.now() + HOUR)) < 2000);
    assert.equal(sectionOf(h, 'ses_a1'), 'snoozed');
    assert.match(lineWith(h, 'Alpha one') ?? '', /until \d\d:\d\d|until \w{3} \d\d:\d\d/);
    assert.match(h.text(), /Snoozed \(1\)/);
    // The selection follows the session into its new section.
    assert.equal(h.app.selectedSession()?.id, 'ses_a1');
    // On a snoozed session the menu offers to remove the snooze.
    await h.type('s');
    assert.match(h.text(), /u\s+Remove the snooze/);
    await h.type('\x1b');
    assert.equal(modal(h), null);

    // The time passes: within about a second the row moves to Open with the "back" tag.
    h.clock.advance(HOUR + 1000);
    await until(() => /Alpha one.*back/.test(lineWith(h, 'Alpha one') ?? ''), 3000, 'back tag');
    assert.equal(sectionOf(h, 'ses_a1'), 'open');
    assert.equal(listLines(h)[listLines(h).findIndex((l) => l.startsWith('Open'))+1]?.startsWith('● Alpha one'), true, 'woke rows come first in Open');

    // Opening the session removes the tag and the expired mark.
    await h.type('\r');
    await until(() => h.app.focus === 'pane', 2000, 'pane focus');
    assert.equal(h.store.sessionMeta('ses_a1')?.snoozedUntil, undefined);
    await h.type('\x11');
    assert.equal(h.app.focus, 'inbox');
    assert.ok(!/back/.test(lineWith(h, 'Alpha one') ?? ''));
  } finally {
    await h.dispose();
  }
});

test('settle: the Settled section is collapsed until E; new activity brings the session back', async () => {
  const { h, alpha } = await inboxFixture(standard());
  try {
    h.app.inbox.select('ses_a1');
    await h.type('e');
    assert.equal(sectionOf(h, 'ses_a1'), 'settled');
    assert.ok(h.store.sessionMeta('ses_a1')?.settledAt);
    let lines = listLines(h);
    assert.ok(lines.includes('Settled (1) · E shows'));
    assert.ok(!lines.some((l) => l.includes('Alpha one')), 'collapsed');
    // The selection moved to the next row at the same place.
    assert.equal(h.app.selectedSession()?.id, 'ses_a2');
    await h.type('E');
    assert.equal(h.store.ui.inboxShowSettled, true);
    lines = listLines(h);
    assert.ok(lines.includes('Settled (1)'));
    assert.ok(lines.some((l) => l.startsWith('● Alpha one')));
    // Settle is not allowed on a working session.
    h.events.emit('session.execution.started', { sessionID: 'ses_a2' }, alpha);
    await until(() => sectionOf(h, 'ses_a2') === 'working', 2000, 'working');
    await h.type('e');
    assert.equal(h.store.sessionMeta('ses_a2'), undefined);
    assert.match(h.text(), /working; settle it when the turn ends/);

    // New activity on the settled session: it leaves Settled by itself.
    h.clock.advance(1000);
    h.events.emit('session.execution.started', { sessionID: 'ses_a1' }, alpha);
    await until(() => sectionOf(h, 'ses_a1') === 'working', 2000, 'working');
    h.clock.advance(1000);
    h.events.emit('session.execution.succeeded', { sessionID: 'ses_a1' }, alpha);
    await until(() => sectionOf(h, 'ses_a1') === 'open', 2000, 'open after the turn');
    assert.ok(h.store.sessionMeta('ses_a1')?.settledAt, 'the mark stays; it only stopped counting');
    // e settles it again.
    h.app.inbox.select('ses_a1');
    await h.type('e');
    assert.equal(sectionOf(h, 'ses_a1'), 'settled');
    // And e on a settled session unsettles it.
    h.app.inbox.select('ses_a1');
    await h.type('e');
    assert.equal(h.store.sessionMeta('ses_a1')?.settledAt, undefined);
    assert.equal(sectionOf(h, 'ses_a1'), 'open');
  } finally {
    await h.dispose();
  }
});

test('u returns a snoozed or a settled session to Open', async () => {
  const { h } = await inboxFixture(standard());
  try {
    h.store.setSessionMeta('ses_a1', { snoozedUntil: h.clock.now() + HOUR });
    h.store.setSessionMeta('ses_b1', { settledAt: h.clock.now() });
    await h.type('E');
    assert.equal(sectionOf(h, 'ses_a1'), 'snoozed');
    assert.equal(sectionOf(h, 'ses_b1'), 'settled');
    h.app.inbox.select('ses_a1');
    await h.type('u');
    assert.equal(sectionOf(h, 'ses_a1'), 'open');
    assert.equal(h.store.sessionMeta('ses_a1'), undefined);
    h.app.inbox.select('ses_b1');
    await h.type('u');
    assert.equal(sectionOf(h, 'ses_b1'), 'open');
    assert.equal(h.store.sessionMeta('ses_b1'), undefined);
    await h.type('u');
    assert.match(h.text(), /no snooze and no settle mark/);
    // A snooze from the menu deletes a settle mark.
    h.store.setSessionMeta('ses_b1', { settledAt: h.clock.now() });
    h.app.inbox.select('ses_b1');
    await h.type('s');
    await h.type('3');
    assert.equal(h.store.sessionMeta('ses_b1')?.settledAt, undefined);
    assert.equal(sectionOf(h, 'ses_b1'), 'snoozed');
  } finally {
    await h.dispose();
  }
});

test('Enter opens the pane, keys reach the PTY, Ctrl+q returns to the inbox; a double click opens', async () => {
  const { h, beta } = await inboxFixture(standard());
  try {
    h.app.inbox.select('ses_b1');
    await h.type('l');
    assert.equal(h.app.focus, 'inbox', 'l does nothing before the pane is open');
    await h.type('\r');
    await until(() => h.ptys.length === 1 && h.app.focus === 'pane', 2000, 'pane');
    const pty = h.ptys[0]!;
    assert.deepEqual(pty.spawn.args, ['--session', 'ses_b1']);
    assert.equal(pty.spawn.cwd, beta);
    assert.equal(h.app.focus, 'pane');
    const inner = h.app.layout().paneInner!;
    assert.equal(inner.x, 57, 'the pane is right of the 56-cell list');
    assert.equal(pty.spawn.cols, inner.w);
    pty.emit('HELLO-INBOX');
    await h.settle();
    assert.equal((h.screen()[inner.y] as string).indexOf('HELLO-INBOX'), inner.x);
    pty.written.length = 0;
    await h.type('vq');
    assert.deepEqual(pty.written, ['v', 'q'], 'every key goes to OpenCode');
    await h.type('\x11');
    assert.equal(h.app.focus, 'inbox');
    assert.equal(h.app.view, 'inbox');
    // l / Tab focus the open pane.
    await h.type('\t');
    assert.equal(h.app.focus, 'pane');
    await h.type('\x11');
    // Zoom: the focused pane takes the window.
    await h.type('z');
    assert.equal(h.app.focus, 'pane');
    assert.equal(h.app.layout().list, null);
    await h.type('\x11');
    await h.type('z');
    assert.ok(h.app.layout().list);

    // One click selects; a second click on the same row opens.
    const y = h.screen().findIndex((l) => [...l].slice(0, 56).join('').includes('Alpha two'));
    click(h, 5, y);
    await h.settle();
    assert.equal(h.app.selectedSession()?.id, 'ses_a2');
    assert.equal(h.ptys.length, 1, 'one click does not open');
    click(h, 5, y);
    await until(() => h.ptys.length === 2, 2000, 'double click opens');
    assert.deepEqual(h.ptys[1]?.spawn.args, ['--session', 'ses_a2']);
  } finally {
    await h.dispose();
  }
});

test('g shows the session in the projects view; ] and [ walk the sessions that want attention', async () => {
  const { h, alpha, worktree, beta } = await inboxFixture(standard());
  try {
    h.events.emit('permission.asked', { id: 'per_1', sessionID: 'ses_b1' }, beta);
    h.events.emit('session.execution.started', { sessionID: 'ses_w1' }, worktree);
    h.events.emit('session.execution.succeeded', { sessionID: 'ses_w1' }, worktree);
    await until(() => h.app.inbox.entry('ses_w1')?.row.status === 'unseen', 2000, 'unseen');
    h.app.inbox.select('ses_a2');
    await h.type(']');
    assert.equal(h.app.selectedSession()?.id, 'ses_b1');
    await h.type(']');
    assert.equal(h.app.selectedSession()?.id, 'ses_w1');
    await h.type(']');
    assert.equal(h.app.selectedSession()?.id, 'ses_b1', 'wraps');
    await h.type('[');
    assert.equal(h.app.selectedSession()?.id, 'ses_w1');

    await h.type('g', 60);
    assert.equal(h.app.view, 'projects');
    assert.equal(h.app.focus, 'sessions');
    assert.equal(h.app.selectedProject()?.name, 'alpha');
    assert.ok(h.app.checkoutPath && samePath(h.app.checkoutPath, worktree, process.platform));
    assert.equal(h.app.selectedSession()?.id, 'ses_w1');
    void alpha;
  } finally {
    await h.dispose();
  }
});

test('rename, archive and delete from the inbox; delete drops the marks', async () => {
  const { h, beta } = await inboxFixture(standard());
  try {
    h.app.inbox.select('ses_b1');
    await h.type('r');
    assert.equal(modal(h)?.kind, 'prompt');
    await h.type('\x15Beta renamed\r');
    await until(() => h.service.sessions.get('ses_b1')?.title === 'Beta renamed', 2000, 'renamed');
    await until(() => (lineWith(h, 'Beta renamed') ?? '') !== '', 2000, 'renamed row');

    h.app.inbox.select('ses_a2');
    const before = listLines(h).findIndex((l) => l.includes('Alpha two'));
    await h.type('a');
    await until(() => h.service.sessions.get('ses_a2')?.archived !== undefined, 2000, 'archived');
    await until(() => h.app.selectedSession()?.id !== 'ses_a2', 2000, 'selection moved');
    assert.equal(sectionOf(h, 'ses_a2'), undefined, 'an archived session leaves the inbox');
    // The selection takes the next row at the same place.
    assert.ok(listLines(h)[before]?.startsWith('● Worktree one'));
    assert.equal(h.app.selectedSession()?.id, 'ses_w1');

    h.app.inbox.select('ses_b1');
    h.store.setSessionMeta('ses_b1', { settledAt: 1 });
    await h.type('E');
    h.app.inbox.select('ses_b1');
    await h.type('d');
    assert.equal(modal(h)?.kind, 'confirm');
    await h.type('y');
    await until(() => !h.service.sessions.has('ses_b1') && h.store.sessionMeta('ses_b1') === undefined, 2000, 'deleted');
    assert.equal(h.store.sessionMeta('ses_b1'), undefined);
    assert.equal(sectionOf(h, 'ses_b1'), undefined);

    // n starts a session in the folder of the selected one and opens it.
    h.app.inbox.select('ses_a1');
    await h.type('n');
    await until(() => h.ptys.length === 1 && h.app.focus === 'pane', 2000, 'new session pane');
    const id = h.ptys[0]!.spawn.args[1] as string;
    assert.equal(h.service.sessions.get(id)?.directory, h.service.sessions.get('ses_a1')?.directory);
    assert.equal(h.app.selectedSession()?.id, id);
    void beta;
  } finally {
    await h.dispose();
  }
});

test('the selection follows a session that changes section', async () => {
  const { h, alpha } = await inboxFixture(standard());
  try {
    h.app.inbox.select('ses_a2');
    h.events.emit('session.execution.started', { sessionID: 'ses_a2' }, alpha);
    await until(() => sectionOf(h, 'ses_a2') === 'working', 2000, 'working');
    const lines = h.screen().map((l) => [...l].slice(0, 56).join(''));
    const y = lines.findIndex((l) => l.includes('Alpha two'));
    assert.ok(lines[y - 1]?.includes('Working (1)'));
    assert.equal(h.app.selectedSession()?.id, 'ses_a2');
    assert.equal(h.app.frame?.getCell(1, y).ch, '▌', 'the selection bar is on that row');
  } finally {
    await h.dispose();
  }
});

test('marks, the view and the inbox selection survive a restart', async () => {
  const { h } = await inboxFixture(standard());
  let h2: Harness | null = null;
  try {
    h.store.setSessionMeta('ses_a1', { snoozedUntil: h.clock.now() + HOUR });
    h.store.setSessionMeta('ses_b1', { settledAt: h.clock.now() + HOUR });
    h.app.inbox.select('ses_a2');
    await h.app.shutdown(0);
    h2 = await harness({ cols: 150, rows: 30, stateDir: h.stateDir, service: h.service });
    const x = h2;
    assert.equal(x.app.view, 'inbox');
    await until(() => sectionOf(x, 'ses_a1') === 'snoozed', 3000, 'snoozed after restart');
    assert.equal(sectionOf(x, 'ses_b1'), 'settled');
    await until(() => x.app.selectedSession()?.id === 'ses_a2', 3000, 'saved selection');
    assert.match(x.text(), /Snoozed \(1\)/);
  } finally {
    await h2?.dispose();
    await h.dispose();
  }
});

test('projects view: s and e in the Sessions column set the marks and show a tag', async () => {
  const clock = wednesdayClock(14, 30);
  const { h, beta } = await inboxFixture(standard(clock.now() - HOUR), { view: 'projects', clock });
  try {
    h.app.selectSession(h.store.projects[1]!, beta, 'ses_b1');
    h.app.focus = 'sessions';
    await h.type('s');
    assert.equal(modal(h)?.kind, 'menu');
    assert.match(h.text(), /4\s+Tomorrow\s+Thu 09:00/);
    await h.type('4');
    assert.ok((h.store.sessionMeta('ses_b1')?.snoozedUntil ?? 0) > h.clock.now());
    assert.match(lineWith(h, 'Beta one') ?? '', /zz 1h/);
    await h.type('e');
    assert.equal(h.store.sessionMeta('ses_b1')?.snoozedUntil, undefined);
    assert.ok(h.store.sessionMeta('ses_b1')?.settledAt);
    assert.match(lineWith(h, 'Beta one') ?? '', /✓ 1h/);
    // The information panel names the inbox section.
    assert.match(h.text(), /Inbox\s+Settled since \d\d:\d\d/);
  } finally {
    await h.dispose();
  }
});

test('an empty inbox shows a hint', async () => {
  const h = await harness({ setupState: async (store) => store.setUi({ view: 'inbox' }) });
  try {
    assert.match(h.text(), /No projects yet/);
    assert.match(h.text(), /Press v for the projects view/);
    await h.type('n');
    assert.match(h.text(), /Select a session first/);
  } finally {
    await h.dispose();
  }
});

// ---- snooze choices, as in T3 Code -------------------------------------------

test('the snooze menu shows the default choices soonest first with their times; a number key snoozes', async () => {
  const clock = wednesdayClock(14, 30);
  const { h } = await inboxFixture(standard(clock.now() - HOUR), { clock });
  try {
    h.app.inbox.select('ses_a1');
    await h.type('s');
    assert.equal(modal(h)?.kind, 'menu');
    const box = modalLines(h);
    if (process.env.CORRAL_PRINT_MENU) console.log(box.join('\n'));
    const rows = box.map((l) => l.replace(/^│\s*|\s*│$/g, '').replace(/\s+/g, ' '));
    const start = rows.findIndex((r) => r.startsWith('1 '));
    assert.deepEqual(rows.slice(start, start + 6), [
      '1 In 1 hour 15:30',
      '2 In 3 hours 17:30',
      '3 This evening 18:00',
      '4 Tomorrow Thu 09:00',
      '5 Next week Mon 09:00',
      'c Custom time…',
    ]);
    assert.ok(rows.some((r) => r.includes('Hide "Alpha one" until:')));
    assert.ok(!rows.some((r) => r.includes('Remove the snooze')));
    // The old letter keys do nothing.
    for (const k of ['t', 'w', 'i']) await h.type(k);
    assert.equal(modal(h)?.kind, 'menu');
    const before = h.clock.now();
    await h.type('2');
    assert.equal(modal(h), null);
    const m = h.store.sessionMeta('ses_a1');
    assert.ok(Math.abs((m?.snoozedUntil as number) - (before + 3 * HOUR)) < 2000, 'In 3 hours');
    assert.ok(Math.abs((m?.snoozedAt as number) - before) < 2000, 'snoozedAt is the time of the snooze');
    assert.equal(sectionOf(h, 'ses_a1'), 'snoozed');
    assert.match(h.text(), /Snoozed until 17:30/);
    // u in the menu removes both marks.
    await h.type('s');
    assert.match(h.text(), /u\s+Remove the snooze/);
    await h.type('u');
    assert.equal(h.store.sessionMeta('ses_a1'), undefined);
  } finally {
    await h.dispose();
  }
});

test('late in the day the passed "today 18:00" choice is not offered', async () => {
  const clock = wednesdayClock(19, 30);
  const { h } = await inboxFixture(standard(clock.now() - HOUR), { clock });
  try {
    h.app.inbox.select('ses_a1');
    await h.type('s');
    const t = h.text();
    assert.ok(!t.includes('This evening'));
    assert.match(t, /1\s+In 1 hour\s+20:30/);
    assert.match(t, /2\s+In 3 hours\s+22:30/);
    assert.match(t, /3\s+Tomorrow\s+Thu 09:00/);
    assert.match(t, /4\s+Next week\s+Mon 09:00/);
    assert.ok(!/5\s+\S/.test(modalLines(h).join('\n')), 'four choices');
  } finally {
    await h.dispose();
  }
});

test('custom time: c opens a prompt; a bad text keeps it open with the error; a good one snoozes', async () => {
  const clock = wednesdayClock(14, 30);
  const { h } = await inboxFixture(standard(clock.now() - HOUR), { clock });
  try {
    h.app.inbox.select('ses_a1');
    await h.type('s');
    await h.type('c');
    assert.equal(modal(h)?.kind, 'prompt');
    await h.type('soon');
    await h.type('\r');
    const m = modal(h);
    assert.equal(m?.kind, 'prompt', 'the prompt stays open');
    assert.match(m?.kind === 'prompt' ? (m.error ?? '') : '', /Use HH:MM, YYYY-MM-DD, YYYY-MM-DD HH:MM, or 30m, 2h, 3d, 1w/);
    assert.match(h.text(), /Not a valid future time/);
    if (process.env.CORRAL_PRINT_MENU) console.log(h.screen().filter((l) => /[╭│╰]/.test(l)).join('\n'));
    assert.equal(h.store.sessionMeta('ses_a1'), undefined);
    // A past time is refused too.
    await h.type('\x7f\x7f\x7f\x7f');
    assert.ok(!(m?.kind === 'prompt' && m.error), 'typing clears the error');
    const today = new Date(h.clock.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    await h.type(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} 10:00\r`);
    assert.equal(modal(h)?.kind, 'prompt');
    assert.match(h.text(), /Not a valid future time/);
    await h.type('\x7f'.repeat(16));
    const before = h.clock.now();
    await h.type('90 m\r');
    assert.equal(modal(h), null);
    const marks = h.store.sessionMeta('ses_a1');
    assert.ok(Math.abs((marks?.snoozedUntil as number) - (before + 90 * 60_000)) < 2000);
    assert.ok(typeof marks?.snoozedAt === 'number');
    assert.equal(sectionOf(h, 'ses_a1'), 'snoozed');
    // HH:MM later today.
    h.app.inbox.select('ses_b1');
    await h.type('s');
    await h.type('c');
    await h.type('17:45\r');
    const u = new Date(h.store.sessionMeta('ses_b1')?.snoozedUntil as number);
    assert.deepEqual([u.getDate(), u.getHours(), u.getMinutes()], [today.getDate(), 17, 45]);
    // Esc in the prompt cancels.
    h.app.inbox.select('ses_w1');
    await h.type('s');
    await h.type('c');
    await h.type('\x1b');
    await until(() => modal(h) === null, 2000, 'prompt closed');
    assert.equal(h.store.sessionMeta('ses_w1'), undefined);
  } finally {
    await h.dispose();
  }
});

test('ui.snoozePresets replaces the defaults; an invalid list falls back and is logged once', async () => {
  const clock = wednesdayClock(14, 30);
  const presets = [{ kind: 'after', minutes: 30 }, { kind: 'at', day: 'friday', time: '08:00' }, { kind: 'after', minutes: 2880 }];
  const { h } = await inboxFixture(standard(clock.now() - HOUR), {
    clock,
    setupState: async (store) => store.setUi({ snoozePresets: presets }),
  });
  try {
    h.app.inbox.select('ses_a1');
    await h.type('s');
    const t = h.text();
    assert.match(t, /1\s+In 30 minutes\s+15:00/);
    assert.match(t, /2\s+Friday\s+Fri 08:00/);
    assert.match(t, /3\s+In 2 days\s+Fri 14:30/);
    assert.ok(!t.includes('In 1 hour'));
    await h.type('\x1b');
    // An invalid list: the defaults, and one line in the log.
    h.store.setUi({ snoozePresets: [{ kind: 'after', minutes: 30 }, { kind: 'at', day: 'someday', time: '08:00' }] });
    await h.type('s');
    assert.match(h.text(), /1\s+In 1 hour\s+15:30/);
    await h.type('\x1b');
    await h.type('s');
    await h.type('\x1b');
    assert.equal(h.logs.filter((l) => l.includes('snoozePresets')).length, 1);
    assert.ok(!h.text().includes('snoozePresets'), 'not in the UI');
  } finally {
    await h.dispose();
  }
});

test('a failed turn after the snooze brings the session back; a normal or interrupted end does not', async () => {
  const { h, alpha, beta } = await inboxFixture(standard());
  try {
    for (const id of ['ses_a1', 'ses_a2', 'ses_b1']) {
      h.app.inbox.select(id);
      await h.type('s');
      await h.type('2');
      assert.equal(sectionOf(h, id), 'snoozed', id);
    }
    h.clock.advance(1000);
    const turn = (id: string, end: string, dir: string) => {
      h.events.emit('session.execution.started', { sessionID: id }, dir);
      h.events.emit(`session.execution.${end}`, { sessionID: id }, dir);
    };
    turn('ses_a2', 'succeeded', alpha);
    turn('ses_b1', 'interrupted', beta);
    turn('ses_a1', 'failed', alpha);
    await until(() => sectionOf(h, 'ses_a1') === 'open', 2000, 'failed session in Open');
    await until(() => h.store.sessionMeta('ses_a1')?.snoozedUntil === undefined, 2000, 'snooze deleted');
    assert.equal(h.store.sessionMeta('ses_a1')?.snoozedAt, undefined);
    assert.match(lineWith(h, 'Alpha one') ?? '', /failed/);
    assert.doesNotMatch(lineWith(h, 'Alpha one') ?? '', /back/);
    await h.settle();
    assert.equal(sectionOf(h, 'ses_a2'), 'snoozed', 'a normal end does not end the snooze');
    assert.equal(sectionOf(h, 'ses_b1'), 'snoozed', 'an interrupted turn does not end the snooze');
    // The next turn does not snooze it again.
    h.events.emit('session.execution.started', { sessionID: 'ses_a1' }, alpha);
    await until(() => sectionOf(h, 'ses_a1') === 'working', 2000, 'working, not snoozed');
  } finally {
    await h.dispose();
  }
});

test('a snooze value of the earlier "until input" build counts as no snooze and is deleted', async () => {
  const { h, alpha } = await inboxFixture(standard(), {
    setupState: async (store) => store.setSessionMeta('ses_a1', { snoozedUntil: 8_640_000_000_000_000 }),
  });
  try {
    assert.equal(sectionOf(h, 'ses_a1'), 'open');
    assert.doesNotMatch(lineWith(h, 'Alpha one') ?? '', /back|until/);
    h.events.emit('session.execution.started', { sessionID: 'ses_a2' }, alpha);
    await until(() => h.store.sessionMeta('ses_a1') === undefined, 2000, 'old value deleted');
  } finally {
    await h.dispose();
  }
});
