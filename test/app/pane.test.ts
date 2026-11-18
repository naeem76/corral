import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../src/core/store.ts';
import { harness, until, type Harness } from './helpers.ts';
import { modal } from './helpers.ts';

async function withSessions(n: number, opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; dir: string; ids: string[] }> {
  let dir = '';
  const h = await harness({
    ...opts,
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
    },
  });
  const ids: string[] = [];
  const t = Date.now() - 60_000;
  for (let i = 0; i < n; i++) ids.push(h.service.addSession({ id: `ses_${String(i).padStart(2, '0')}`, directory: dir, title: `Session ${i}`, updated: t - i * 1000 }).id);
  await h.tracker.refresh();
  await h.settle();
  return { h, dir, ids };
}

test('Enter opens a pane: output lands inside the pane rectangle, keys reach the PTY', async () => {
  const { h, dir, ids } = await withSessions(1);
  try {
    await h.type('ll');
    await h.type('\r', 60);
    assert.equal(h.ptys.length, 1);
    const pty = h.ptys[0]!;
    assert.equal(pty.spawn.command, '/usr/bin/opencode');
    assert.deepEqual(pty.spawn.args, ['--session', ids[0]]);
    assert.equal(pty.spawn.cwd, dir);
    assert.equal(pty.spawn.title, `nebula-enterprise:4242:${ids[0]}`);
    assert.equal(h.app.focus, 'pane');
    const lay = h.app.layout();
    const inner = lay.paneInner!;
    assert.equal(pty.spawn.cols, inner.w);
    assert.equal(pty.spawn.rows, inner.h);

    pty.emit('\x1b[2J\x1b[HHELLO-FROM-OPENCODE\r\n\x1b[3;5Hthird');
    await h.settle();
    const rows = h.screen();
    const line = rows[inner.y] as string;
    assert.equal(line.indexOf('HELLO-FROM-OPENCODE'), inner.x, 'first emulator row at the pane origin');
    assert.equal((rows[inner.y + 2] as string).indexOf('third'), inner.x + 4);
    // The real cursor follows the emulator cursor while the pane has focus.
    const f = h.app.frame!;
    assert.equal(f.cursor.visible, true);
    assert.deepEqual([f.cursor.x, f.cursor.y], [inner.x + 9, inner.y + 2]);

    pty.written.length = 0;
    await h.type('hi');
    await h.type('\x1b[A');
    assert.deepEqual(pty.written, ['h', 'i', '\x1b[A']);
    // The program asks for application cursor keys: arrows change encoding.
    pty.emit('\x1b[?1h');
    pty.written.length = 0;
    await h.type('\x1b[A');
    assert.deepEqual(pty.written, ['\x1bOA']);
    // Paste is wrapped when the program asked for bracketed paste.
    pty.emit('\x1b[?2004h');
    pty.written.length = 0;
    await h.type('\x1b[200~pasted\x1b[201~');
    assert.deepEqual(pty.written, ['\x1b[200~pasted\x1b[201~']);
    // q goes to OpenCode, it does not quit.
    pty.written.length = 0;
    await h.type('q');
    assert.deepEqual(pty.written, ['q']);
    assert.equal(modal(h), null);

    // The leave chord (Ctrl+Q) is not forwarded and returns to the Sessions column.
    pty.written.length = 0;
    await h.type('\x11');
    assert.deepEqual(pty.written, []);
    assert.equal(h.app.focus, 'sessions');
    assert.match(h.screen().at(-1) as string, /Enter open/);
    // The pane stays visible while the session is selected.
    assert.ok(h.text().includes('HELLO-FROM-OPENCODE'));
    // Enter again only focuses, no second PTY.
    await h.type('\r');
    assert.equal(h.ptys.length, 1);
    assert.equal(h.app.focus, 'pane');
    assert.match(h.screen().at(-1) as string, /Ctrl\+q leave pane/);
  } finally {
    await h.dispose();
  }
});

test('the leave chord comes from the store ui data', async () => {
  const { h } = await withSessions(1, { setupState: undefined });
  await h.dispose();
  let dir = '';
  const h2 = await harness({
    setupState: async (store, d) => {
      dir = path.join(d, 'p');
      await mkdir(dir);
      await store.addProject(dir);
      store.setUi({ leaveKey: 'ctrl+]' });
    },
  });
  try {
    h2.service.addSession({ directory: dir, title: 'S' });
    await h2.tracker.refresh();
    await h2.type('ll');
    await h2.type('\r', 60);
    const pty = h2.ptys[0]!;
    pty.written.length = 0;
    await h2.type('\x11'); // Ctrl+Q is forwarded now
    assert.deepEqual(pty.written, ['\x11']);
    assert.equal(h2.app.focus, 'pane');
    await h2.type('\x1d'); // Ctrl+]
    assert.equal(h2.app.focus, 'sessions');
    assert.deepEqual(pty.written, ['\x11']);
  } finally {
    await h2.dispose();
  }
});

test('a mouse click on a column leaves the pane; clicks inside go to the program', async () => {
  const { h } = await withSessions(1);
  try {
    await h.type('ll');
    await h.type('\r', 60);
    const pty = h.ptys[0]!;
    pty.emit('\x1b[?1000h\x1b[?1006h');
    const inner = h.app.layout().paneInner!;
    pty.written.length = 0;
    await h.type(`\x1b[<0;${inner.x + 3};${inner.y + 2}M`);
    assert.deepEqual(pty.written, ['\x1b[<0;3;2M']);
    await h.type('\x1b[<0;3;3M');
    assert.equal(h.app.focus, 'projects');
  } finally {
    await h.dispose();
  }
});

test('a layout change resizes the PTY to the pane inner size (debounced)', async () => {
  const { h } = await withSessions(1);
  try {
    await h.type('ll');
    await h.type('\r', 60);
    const pty = h.ptys[0]!;
    h.term.resizeTo(150, 35);
    h.term.resizeTo(140, 30);
    await h.settle(80);
    const inner = h.app.layout().paneInner!;
    assert.deepEqual(pty.resizes, [[inner.w, inner.h]], 'one resize after the pause');
    assert.equal(h.app.panes.get(h.app.selectedSession()!.id)?.emulator.cols, inner.w);
    // Zoom: the focused pane takes the whole window.
    await h.type('\x11');
    await h.type('z', 80);
    assert.equal(h.app.focus, 'pane');
    const full = h.app.layout().paneInner!;
    assert.deepEqual([full.x, full.y, full.w, full.h], [0, 0, 140, 29]);
    await h.settle(60);
    assert.deepEqual(pty.resizes.at(-1), [140, 29]);
  } finally {
    await h.dispose();
  }
});

test('LRU: the 9th pane evicts the least recently used idle pane', async () => {
  const { h, ids } = await withSessions(9);
  try {
    await h.type('ll');
    // ses_00 works: it must survive although it is the oldest.
    h.events.emit('session.execution.started', { sessionID: ids[0] }, undefined);
    await h.settle();
    for (let i = 0; i < 9; i++) {
      h.app.lists.sessions = { ...h.app.lists.sessions, selectedKey: ids[i] as string };
      await h.type('\r', 30);
      await h.type('\x11', 10);
    }
    assert.equal(h.ptys.length, 9);
    assert.equal(h.app.panes.list().length, 8);
    const closed = h.ptys.filter((p) => p.closed).map((p) => p.spawn.args[1]);
    assert.equal(closed.length, 1);
    assert.notEqual(closed[0], ids[0], 'the working session keeps its pane');
    assert.equal(closed[0], ids[1]);
  } finally {
    await h.dispose();
  }
});

test('program exit drops the pane and shows the reason; switching shows the info panel', async () => {
  const { h, ids } = await withSessions(2);
  try {
    await h.type('ll');
    await h.type('\r', 60);
    const pty = h.ptys[0]!;
    pty.emit('SCREEN-TEXT');
    await h.settle();
    pty.exit(3);
    await h.settle();
    assert.equal(h.app.focus, 'sessions');
    assert.equal(h.app.panes.has(ids[0]!), false);
    assert.equal(pty.closed, true, 'the exited PTY is deleted in the service');
    const t = h.text();
    assert.ok(!t.includes('SCREEN-TEXT'));
    assert.match(t, /OpenCode exited with code 3/);
    // Another session without a pane shows the information panel.
    await h.type('j');
    const t2 = h.text();
    assert.match(t2, /Enter opens the session here/);
    assert.match(t2, /Status/);
  } finally {
    await h.dispose();
  }
});

test('quit closes every PTY and flushes the store', async () => {
  const { h, ids } = await withSessions(3);
  await h.type('ll');
  for (const id of ids) {
    h.app.lists.sessions = { ...h.app.lists.sessions, selectedKey: id };
    await h.type('\r', 30);
    await h.type('\x11', 10);
  }
  assert.equal(h.ptys.length, 3);
  await h.type('q');
  assert.equal(modal(h)?.kind, 'confirm');
  await h.type('\r', 100);
  const code = await h.app.done;
  assert.equal(code, 0);
  assert.ok(h.ptys.every((p) => p.closed));
  assert.equal(h.term.closed, true);
  const s = new Store({ dir: h.stateDir });
  await s.load();
  assert.equal(s.ui.selectedSessionId, ids[2]);
  assert.deepEqual(s.ui.ptyDirs, []);
  await h.dispose();
});

test('q in the confirm can be refused; Ctrl+C asks too', async () => {
  const { h } = await withSessions(0);
  try {
    await h.type('\x03');
    assert.equal(modal(h)?.kind, 'confirm');
    await h.type('n');
    assert.equal(modal(h), null);
    assert.equal(h.app.quitting, false);
  } finally {
    await h.dispose();
  }
});
