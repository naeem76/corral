import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { harness } from './helpers.ts';

type Harness = Awaited<ReturnType<typeof harness>>;

async function withProject(): Promise<Harness> {
  const h = await harness({
    setupState: async (store, d) => {
      const dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
    },
  });
  const dir = h.store.projects[0]!.path;
  h.service.addSession({ id: 'ses_00', directory: dir, title: 'Session 0', updated: Date.now() - 60_000 });
  await h.tracker.refresh();
  await h.settle();
  return h;
}

/** A left press and release on the first row of a column (SGR mouse, 1-based). */
function click(h: Harness, col: 'projects' | 'git' | 'sessions'): string {
  const r = h.app.listRect(col);
  return `\x1b[<0;${r.x + 2};${r.y + 1}M\x1b[<0;${r.x + 2};${r.y + 1}m`;
}

test('one click on the selected project keeps the focus in the Projects column', async () => {
  const h = await withProject();
  try {
    await h.type('l');
    assert.equal(h.app.focus, 'git');
    await h.type(click(h, 'projects'));
    assert.equal(h.app.focus, 'projects');
    // A second click after a long pause is a new single click, not a double click.
    await h.type(click(h, 'projects'), 450);
    await h.type(click(h, 'projects'));
    assert.equal(h.app.focus, 'projects');
  } finally {
    await h.dispose();
  }
});

test('one click on a session selects it; a double click opens it', async () => {
  const h = await withProject();
  try {
    await h.type(click(h, 'sessions'), 450);
    assert.equal(h.app.focus, 'sessions');
    assert.equal(h.ptys.length, 0, 'a single click does not open the session');
    await h.type(click(h, 'sessions') + click(h, 'sessions'), 80);
    assert.equal(h.ptys.length, 1);
  } finally {
    await h.dispose();
  }
});

test('a double click on a project acts as Enter and moves to the Git column', async () => {
  const h = await withProject();
  try {
    await h.type(click(h, 'projects') + click(h, 'projects'));
    assert.equal(h.app.focus, 'git');
  } finally {
    await h.dispose();
  }
});
