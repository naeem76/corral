import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { harness, makeGitRepo, until } from './helpers.ts';
import { browserState, confirmState, modal } from './helpers.ts';

const ESC = '\x1b';

test('empty state shows the hints and does not crash', async () => {
  const h = await harness();
  try {
    const t = h.text();
    assert.match(t, /Projects/);
    assert.match(t, /Git/);
    assert.match(t, /Sessions/);
    assert.match(t, /No projects: press n/);
    assert.match(t, /Add a project with n/);
    // Footer hints for the Projects column come from the binding table.
    const footer = h.screen().at(-1) as string;
    assert.match(footer, /n add/);
    assert.match(footer, /q quit/);
  } finally {
    await h.dispose();
  }
});

test('add a Git project and a plain folder through the prompt', async () => {
  const h = await harness();
  try {
    const repo = path.join(h.dir, 'work', 'repo-one');
    const plain = path.join(h.dir, 'work', 'plain-folder');
    await makeGitRepo(repo);
    await mkdir(plain, { recursive: true });

    await h.type('n');
    assert.equal(modal(h)?.kind, 'browser');
    let t = h.text();
    assert.match(t, /Add project/);
    // The browser starts in the home folder (the temp dir here) and lists its sub-folders.
    await until(() => !browserState(h)?.loading, 2000, 'listing');
    assert.ok(h.text().includes('work'));

    // Type to filter, Tab completes "work/", then the listing shows both folders.
    await h.type('wo');
    await h.type('\t', 80);
    assert.equal(browserState(h)?.input.value, path.join(h.dir, 'work') + path.sep);
    await until(() => browserState(h)?.entries.length === 2, 2000, 'entries');
    await h.settle(80);
    t = h.text();
    assert.match(t, /plain-folder/);
    assert.match(t, /● repo-one/, 'Git repositories are marked');

    // ↓ picks the first entry (plain-folder, sorted), Enter adds it.
    await h.type(`${ESC}[B`);
    await h.type('\r', 120);
    await until(() => h.store.projects.length === 1, 2000, 'first project');
    assert.equal(h.store.projects[0]?.kind, 'dir');
    assert.equal(modal(h), null);

    // Add the repository by typing its full path.
    await h.type('o');
    const m = modal(h);
    assert.equal(m?.kind, 'browser');
    await h.type('\x15'); // Ctrl+U clears the field
    await h.type(repo, 60);
    await h.type('\r', 150);
    await until(() => h.store.projects.length === 2, 3000, 'second project');
    const added = h.store.projects[1];
    assert.equal(added?.kind, 'git');
    assert.equal(added?.path, repo);
    t = h.text();
    assert.match(t, /◇ plain-folder/);
    assert.match(t, /◆ repo-one/);
    // The new project is selected; its Git column shows the root checkout on main.
    await until(() => h.text().includes('⌂ main'), 3000, 'root checkout row');
  } finally {
    await h.dispose();
  }
});

test('the prompt reports a missing folder and keeps the modal open', async () => {
  const h = await harness();
  try {
    await h.type('n');
    await h.type('\x15');
    await h.type(path.join(h.dir, 'does-not-exist'), 30);
    await h.type('\r');
    // The folder check is asynchronous: wait for its message, not for a fixed time.
    await until(() => /not a folder|no such folder/.test(h.text()), 3000, 'missing-folder message');
    assert.equal(modal(h)?.kind, 'browser');
    await h.type(ESC, 30);
    assert.equal(modal(h), null);
    assert.equal(h.store.projects.length, 0);
  } finally {
    await h.dispose();
  }
});

test('200 projects: the selection stays visible while moving and jumping', async () => {
  const h = await harness({
    rows: 30,
    setupState: async (store, dir) => {
      for (let i = 0; i < 200; i++) {
        const p = path.join(dir, 'p', `proj-${String(i).padStart(3, '0')}`);
        await mkdir(p, { recursive: true });
        await store.addProject(p);
      }
    },
  });
  try {
    const visible = (name: string) => h.screen().some((l) => l.includes(name));
    const selectedName = () => h.app.selectedProject()?.name ?? '';
    assert.equal(selectedName(), 'proj-000');
    for (let i = 0; i < 60; i++) h.term.type('j');
    await h.settle();
    assert.equal(selectedName(), 'proj-060');
    assert.ok(visible('proj-060'), 'selection visible after 60 × j');
    await h.type(`${ESC}[F`); // End
    assert.equal(selectedName(), 'proj-199');
    assert.ok(visible('proj-199'));
    await h.type(`${ESC}[5~`); // PgUp
    assert.ok(visible(selectedName()));
    await h.type('\x04'); // Ctrl+D half down
    assert.ok(visible(selectedName()));
    await h.type(`${ESC}[H`); // Home
    assert.equal(selectedName(), 'proj-000');
    assert.ok(visible('proj-000'));
    // A filter jumps far; the match must be on screen.
    await h.type('/');
    await h.type('proj-150', 60);
    assert.equal(selectedName(), 'proj-150');
    assert.ok(visible('proj-150'));
    await h.type('\r');
    assert.equal(h.app.filterEditing, false);
    await h.type(ESC);
    assert.equal(h.app.filter, '');
    assert.equal(selectedName(), 'proj-150');
    assert.ok(visible('proj-150'), 'still visible after the filter is cleared');
    // Mouse wheel scrolls the view; then j brings the selection back into view.
    for (let i = 0; i < 10; i++) h.term.type('\x1b[<65;5;5M');
    await h.settle();
    await h.type('j');
    assert.ok(visible(selectedName()));
  } finally {
    await h.dispose();
  }
});

test('rename, reorder (J/K) and remove a project; files stay', async () => {
  const h = await harness({
    setupState: async (store, dir) => {
      for (const n of ['alpha', 'beta', 'gamma']) {
        await mkdir(path.join(dir, n), { recursive: true });
        await store.addProject(path.join(dir, n));
      }
    },
  });
  try {
    await h.type('r');
    assert.equal(modal(h)?.kind, 'prompt');
    await h.type('\x15');
    await h.type('First');
    await h.type('\r');
    assert.equal(h.store.projects[0]?.name, 'First');
    await h.type('J');
    assert.deepEqual(h.store.projects.map((p) => p.name), ['beta', 'First', 'gamma']);
    assert.equal(h.app.selectedProject()?.name, 'First');
    await h.type('K');
    assert.deepEqual(h.store.projects.map((p) => p.name), ['First', 'beta', 'gamma']);
    await h.type('j');
    await h.type('d');
    assert.equal(modal(h)?.kind, 'confirm');
    const cm = modal(h);
    assert.ok(cm?.kind === 'confirm' && /folder and its files stay/.test(cm.state.message));
    await h.type('y');
    assert.deepEqual(h.store.projects.map((p) => p.name), ['First', 'gamma']);
    const { stat } = await import('node:fs/promises');
    assert.ok((await stat(path.join(h.dir, 'beta'))).isDirectory());
  } finally {
    await h.dispose();
  }
});

test('selection is persisted and restored at the next start', async () => {
  const h = await harness({
    setupState: async (store, dir) => {
      for (const n of ['one', 'two', 'three']) {
        await mkdir(path.join(dir, n), { recursive: true });
        await store.addProject(path.join(dir, n));
      }
    },
  });
  try {
    await h.type('jj');
    assert.equal(h.store.ui.selectedProjectId, h.store.projects[2]?.id);
    await h.type('z');
    assert.equal(h.store.ui.zoom, true);
  } finally {
    await h.app.shutdown(0);
  }
  // A second app on the same state directory.
  const { Store } = await import('../../src/core/store.ts');
  const s2 = new Store({ dir: h.stateDir });
  await s2.load();
  assert.equal(s2.ui.selectedProjectId, s2.projects[2]?.id);
  assert.equal(s2.ui.zoom, true);
  const h2 = await harness({
    setupState: async (store) => {
      for (const p of s2.projects) await store.addProject(p.path);
      store.setUi({ selectedProjectId: store.projects[2]?.id ?? null });
    },
  });
  try {
    assert.equal(h2.app.selectedProject()?.name, 'three');
  } finally {
    await h2.dispose();
    await h.dispose();
  }
});
