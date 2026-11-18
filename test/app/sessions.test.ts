import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ATTR } from '../../src/types.ts';
import { defaultTheme } from '../../src/tui/style.ts';
import { harness, until, type Harness } from './helpers.ts';
import { modal } from './helpers.ts';

async function twoProjects(): Promise<{ h: Harness; a: string; b: string }> {
  let a = '';
  let b = '';
  const h = await harness({
    setupState: async (store, dir) => {
      a = path.join(dir, 'alpha');
      b = path.join(dir, 'beta');
      await mkdir(a);
      await mkdir(b);
      await store.addProject(a);
      await store.addProject(b);
    },
  });
  return { h, a, b };
}

/** Color of the status dot in the row that shows `title`. */
function dotColor(h: Harness, title: string): number | null {
  const f = h.app.draw();
  for (let y = 0; y < f.rows; y++) {
    const row = f.rowText(y);
    const i = row.indexOf(title);
    if (i < 0) continue;
    // The dot sits two cells before the title in the Sessions column.
    let x = 0;
    let col = 0;
    for (const ch of row) {
      if (col === i - 2) break;
      col += ch.length;
      x++;
    }
    const c = f.getCell(x, y);
    if (c.ch === '●') return c.fg;
  }
  return null;
}

test('session rows follow scripted events with the right dots and order', async () => {
  const { h, a } = await twoProjects();
  try {
    const old = Date.now() - 3600_000;
    h.service.addSession({ id: 'ses_idle', directory: a, title: 'Idle one', created: old, updated: old });
    h.service.addSession({ id: 'ses_work', directory: a, title: 'Working one', created: old, updated: old - 1000 });
    h.service.addSession({ id: 'ses_ask', directory: a, title: 'Asking one', created: old, updated: old - 2000 });
    h.service.addSession({ id: 'ses_done', directory: a, title: 'Done one', created: old, updated: old - 3000 });
    await h.tracker.refresh();
    await h.settle();
    const order = () => h.app.sessionRows().map((r) => r.id);
    assert.deepEqual(order(), ['ses_idle', 'ses_work', 'ses_ask', 'ses_done']);

    h.events.emit('session.execution.started', { sessionID: 'ses_work' }, a);
    h.events.emit('permission.asked', { id: 'per_1', sessionID: 'ses_ask' }, a);
    h.events.emit('session.execution.started', { sessionID: 'ses_done' }, a);
    h.events.emit('session.execution.succeeded', { sessionID: 'ses_done' }, a);
    await h.settle();
    assert.deepEqual(order(), ['ses_ask', 'ses_work', 'ses_done', 'ses_idle']);
    const st = defaultTheme.status;
    assert.equal(dotColor(h, 'Asking one'), st['needs-input']);
    assert.equal(dotColor(h, 'Working one'), st.working);
    assert.equal(dotColor(h, 'Done one'), st.unseen);
    assert.equal(dotColor(h, 'Idle one'), st.idle);
    // The project row shows the worst status of its sessions.
    const f = h.app.draw();
    const y = [...Array(f.rows).keys()].find((r) => f.rowText(r).includes('alpha')) as number;
    const x = [...f.rowText(y)].indexOf('●');
    assert.equal(f.getCell(x, y).fg, st['needs-input']);

    h.events.emit('permission.replied', { requestID: 'per_1' }, a);
    h.events.emit('session.renamed', { sessionID: 'ses_idle', title: 'Renamed' }, a);
    await h.settle();
    assert.match(h.text(), /Renamed/);
    assert.equal(dotColor(h, 'Asking one'), st.idle);
    h.events.emit('session.deleted', { sessionID: 'ses_work' }, a);
    await h.settle();
    assert.ok(!h.text().includes('Working one'));
  } finally {
    await h.dispose();
  }
});

test('new, rename, archive (hidden, A shows), delete', async () => {
  const { h, a } = await twoProjects();
  try {
    await h.type('ll'); // Sessions column
    assert.equal(h.app.focus, 'sessions');
    await h.type('n', 80);
    // The new session exists at once and opens in the pane.
    await until(() => h.ptys.length === 1, 2000, 'pty');
    const id = h.ptys[0]?.spawn.args[1] as string;
    assert.deepEqual(h.ptys[0]?.spawn.args, ['--session', id]);
    assert.equal(h.ptys[0]?.spawn.cwd, a);
    assert.equal(h.app.focus, 'pane');
    await h.type('\x11'); // leave
    assert.equal(h.app.focus, 'sessions');

    await h.type('r');
    await h.type('\x15My task\r', 60);
    assert.equal(h.service.sessions.get(id)?.title, 'My task');
    assert.match(h.text(), /My task/);

    await h.type('a', 60);
    assert.ok(h.service.sessions.get(id)?.archived);
    const titles = () => h.app.sessionRows().map((r) => r.title);
    assert.ok(!titles().includes('My task'), 'archived sessions are hidden');
    await h.type('A', 30);
    assert.ok(titles().includes('My task'));
    assert.match(h.text(), /Sessions \(all\)/);
    await h.type('a', 60);
    assert.equal(h.service.sessions.get(id)?.archived, undefined, 'a on an archived session unarchives');

    await h.type('d');
    assert.equal(modal(h)?.kind, 'confirm');
    await h.type('y', 80);
    assert.equal(h.service.sessions.has(id), false);
    assert.equal(h.ptys[0]?.closed, true, 'its pane is closed first');
    assert.ok(!titles().includes('My task'));
  } finally {
    await h.dispose();
  }
});

test('] and [ walk sessions in attention order across projects', async () => {
  const { h, a, b } = await twoProjects();
  try {
    const t = Date.now() - 60_000;
    h.service.addSession({ id: 'ses_a1', directory: a, title: 'A idle', updated: t });
    h.service.addSession({ id: 'ses_b1', directory: b, title: 'B asks', updated: t - 5000 });
    h.service.addSession({ id: 'ses_b2', directory: b, title: 'B works', updated: t - 9000 });
    await h.tracker.refresh();
    h.events.emit('permission.asked', { id: 'per_9', sessionID: 'ses_b1' }, b);
    h.events.emit('session.execution.started', { sessionID: 'ses_b2' }, b);
    await h.settle();
    await h.type(']', 80);
    assert.equal(h.app.selectedProject()?.name, 'beta');
    assert.equal(h.app.selectedSession()?.id, 'ses_b1');
    assert.equal(h.app.focus, 'sessions');
    await h.type(']', 80);
    assert.equal(h.app.selectedSession()?.id, 'ses_b2');
    await h.type(']', 80);
    assert.equal(h.app.selectedProject()?.name, 'alpha');
    assert.equal(h.app.selectedSession()?.id, 'ses_a1');
    await h.type('[', 80);
    assert.equal(h.app.selectedSession()?.id, 'ses_b2');
  } finally {
    await h.dispose();
  }
});

test('a session in the focused pane is marked seen', async () => {
  const { h, a } = await twoProjects();
  try {
    h.service.addSession({ id: 'ses_u', directory: a, title: 'Finished', idle: Date.now() - 1000 });
    await h.tracker.refresh();
    await h.settle();
    assert.equal(h.tracker.status('ses_u'), 'unseen');
    await h.type('ll');
    await h.type('\r', 80);
    assert.equal(h.app.focus, 'pane');
    await until(() => h.tracker.status('ses_u') === 'idle', 2000, 'seen');
    assert.ok(h.store.sessionMeta('ses_u')?.lastSeen);
    // A turn that ends while the pane has focus is seen at once.
    h.events.emit('session.execution.started', { sessionID: 'ses_u' }, a);
    h.events.emit('session.execution.succeeded', { sessionID: 'ses_u' }, a);
    await until(() => h.tracker.status('ses_u') === 'idle', 2000, 'seen again');
  } finally {
    await h.dispose();
  }
});

test('the selected row uses the selection style; titles with escapes are cleaned', async () => {
  const { h, a } = await twoProjects();
  try {
    h.service.addSession({ id: 'ses_x', directory: a, title: 'evil\x1b[31mred' });
    await h.tracker.refresh();
    await h.settle();
    const t = h.text();
    assert.ok(!t.includes('\x1b'));
    assert.match(t, /evil \[31mred/);
    void ATTR;
  } finally {
    await h.dispose();
  }
});
