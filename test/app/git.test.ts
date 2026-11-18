import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PullRequest } from '../../src/types.ts';
import { worktreeDir } from '../../src/core/git.ts';
import { harness, makeGitRepo, until } from './helpers.ts';
import { browserState, confirmState, modal } from './helpers.ts';

const branches = (h: { app: { gitItems(): Array<{ data: { kind: string; checkout?: { branch: string | null } } }> } }) =>
  h.app.gitItems().filter((it) => it.data.kind === 'checkout').map((it) => it.data.checkout?.branch);
const exists = async (p: string) => stat(p).then(() => true, () => false);

test('selection drives the Git and Sessions columns', async () => {
  let repo = '';
  let plain = '';
  const h = await harness({
    setupState: async (store, dir) => {
      repo = path.join(dir, 'repo');
      plain = path.join(dir, 'plain');
      await makeGitRepo(repo);
      await mkdir(plain);
      await store.addProject(repo);
      await store.addProject(plain);
    },
  });
  try {
    h.service.addSession({ directory: repo, title: 'Repo session' });
    h.service.addSession({ directory: plain, title: 'Plain session' });
    await h.tracker.refresh();
    await until(() => h.text().includes('⌂ main'), 3000, 'root checkout');
    await until(() => h.text().includes('Repo session'), 2000, 'repo session');
    assert.ok(!h.text().includes('Plain session'));
    await h.type('j', 100);
    const t = h.text();
    assert.match(t, /⌂ plain/);
    assert.match(t, /Plain session/);
    assert.ok(!t.includes('Repo session'));
  } finally {
    await h.dispose();
  }
});

test('create a worktree (new branch), refuse the root, delete with a typed confirm', async () => {
  let repo = '';
  const h = await harness({
    setupState: async (store, dir) => {
      repo = path.join(dir, 'repo');
      await makeGitRepo(repo);
      await store.addProject(repo);
    },
  });
  try {
    await until(() => h.text().includes('⌂ main'), 3000, 'root checkout');
    await h.type('l'); // focus Git
    assert.equal(h.app.focus, 'git');
    // The root cannot be deleted.
    await h.type('d');
    assert.equal(modal(h), null);
    assert.match(h.text(), /root checkout cannot be deleted/);

    await h.type('n');
    assert.equal(modal(h)?.kind, 'prompt');
    await h.type('feat/x');
    await h.type('\r');
    const dest = worktreeDir(repo, 'feat/x');
    await until(() => h.text().includes('feat/x'), 5000, 'new worktree row');
    assert.ok(await exists(dest));
    // The new worktree is selected and the Sessions column follows it.
    assert.equal(h.app.checkoutPath, dest);

    // Delete: a typed confirm; a wrong text does not delete.
    await h.type('d');
    assert.equal(modal(h)?.kind, 'confirm');
    await h.type('wrong\r');
    assert.equal(modal(h)?.kind, 'confirm');
    assert.ok(await exists(dest));
    await h.type('\x15feat/x\r');
    await until(() => !branches(h).includes('feat/x'), 5000, 'row removed');
    assert.equal(await exists(dest), false);
  } finally {
    await h.dispose();
  }
});

test('an existing branch is checked out; a dirty worktree asks for force', async () => {
  let repo = '';
  const h = await harness({
    setupState: async (store, dir) => {
      repo = path.join(dir, 'repo');
      await makeGitRepo(repo);
      const { run } = await import('../../src/core/exe.ts');
      await run('git', ['-C', repo, 'branch', 'existing']);
      await store.addProject(repo);
    },
  });
  try {
    await until(() => h.text().includes('⌂ main'), 3000, 'root');
    await h.type('l');
    await h.type('n');
    await h.type('existing\r');
    const dest = worktreeDir(repo, 'existing');
    await until(() => h.text().includes('existing'), 5000, 'worktree row');
    assert.ok(await exists(dest));
    await writeFile(path.join(dest, 'dirty.txt'), 'x');
    await h.app.loadCheckouts(h.app.selectedProject()!, true);
    await until(() => /existing \*/.test(h.text()), 3000, 'dirty mark');

    await h.type('d');
    await h.type('existing\r', 50);
    await until(() => confirmState(h)?.title === 'Force delete', 5000, 'force prompt');
    assert.ok(await exists(dest), 'nothing deleted before the force confirm');
    await h.type('y');
    await until(() => !branches(h).includes('existing'), 5000, 'row removed');
    assert.equal(await exists(dest), false);
  } finally {
    await h.dispose();
  }
});

test('pull requests show as a group; Enter opens the URL; nothing when unavailable', async () => {
  const pr: PullRequest = {
    id: '42', title: 'Add the widget', url: 'https://dev.azure.com/o/p/_git/r/pullrequest/42',
    sourceBranch: 'feat/widget', targetBranch: 'main', author: 'Ann', status: 'active',
  };
  const opened: string[] = [];
  let repo = '';
  const h = await harness({
    prs: { available: async () => true, list: async () => [pr] },
    deps: { openUrl: async (u) => void opened.push(u) },
    setupState: async (store, dir) => {
      repo = path.join(dir, 'repo');
      await makeGitRepo(repo);
      await store.addProject(repo);
    },
  });
  try {
    await until(() => h.text().includes('#42 Add the widget'), 3000, 'PR row');
    assert.match(h.text(), /PULL REQUESTS · 1/);
    await h.type('l');
    await h.type('j');
    assert.equal(h.app.selectedGitRow()?.kind, 'pr');
    await h.type('\r', 60);
    assert.deepEqual(opened, [pr.url]);
  } finally {
    await h.dispose();
  }
  const h2 = await harness({
    prs: { available: async () => false, list: async () => [pr] },
    setupState: async (store, dir) => {
      const r = path.join(dir, 'repo');
      await makeGitRepo(r);
      await store.addProject(r);
    },
  });
  try {
    await until(() => h2.text().includes('⌂ main'), 3000, 'root');
    assert.ok(!h2.text().includes('PULL REQUESTS'));
  } finally {
    await h2.dispose();
  }
});

test('a selected worktree and session are restored at start', async () => {
  let wt = '';
  let repo = '';
  const { FakeService } = await import('./helpers.ts');
  const service = new FakeService();
  const h = await harness({
    service,
    setupState: async (store, dir) => {
      repo = path.join(dir, 'repo');
      await makeGitRepo(repo);
      const { run } = await import('../../src/core/exe.ts');
      wt = worktreeDir(repo, 'side');
      await run('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'side', wt]);
      const p = await store.addProject(repo);
      service.addSession({ id: 'ses_wt', directory: wt, title: 'Worktree work' });
      store.setUi({ selectedProjectId: p.id, selectedCheckoutPath: wt, selectedSessionId: 'ses_wt' });
    },
  });
  try {
    await until(() => h.app.checkoutPath === wt, 3000, 'worktree restored');
    await until(() => h.app.selectedSession()?.id === 'ses_wt', 3000, 'session restored');
    assert.equal(h.app.selectedGitRow()?.kind, 'checkout');
  } finally {
    await h.dispose();
  }
});
