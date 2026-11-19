// Shared setup of the inbox tests: two projects (a Git repository with one worktree, and a
// plain folder) and sessions in each folder.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../src/core/exe.ts';
import { harness, makeGitRepo, until, type Harness, type HarnessOptions } from './helpers.ts';

export interface InboxFixture {
  h: Harness;
  alpha: string;
  worktree: string;
  beta: string;
}

/** Start in the inbox view with sessions from `add` (called with the folders). */
export async function inboxFixture(
  add: (f: Omit<InboxFixture, 'h'>, h: Harness) => void,
  opts: HarnessOptions & { view?: 'inbox' | 'projects' } = {},
): Promise<InboxFixture> {
  const dirs = { alpha: '', worktree: '', beta: '' };
  const h = await harness({
    cols: 150,
    rows: 30,
    ...opts,
    setupState: async (store, dir) => {
      dirs.alpha = path.join(dir, 'alpha');
      dirs.worktree = path.join(dir, 'alpha-feature');
      dirs.beta = path.join(dir, 'beta');
      await makeGitRepo(dirs.alpha);
      await run('git', ['-C', dirs.alpha, 'worktree', 'add', '-q', '-b', 'feature', dirs.worktree]);
      await mkdir(dirs.beta);
      await store.addProject(dirs.alpha);
      await store.addProject(dirs.beta);
      store.setUi({ view: opts.view ?? 'inbox' });
      await opts.setupState?.(store, dir);
    },
  });
  add(dirs, h);
  await h.tracker.refresh();
  if ((opts.view ?? 'inbox') === 'inbox') {
    // The worktree is watched once the checkouts of the Git project are loaded.
    const inWorktree = [...h.service.sessions.values()].filter((s) => s.directory === dirs.worktree);
    await until(() => inWorktree.every((s) => h.tracker.get(s.id) !== undefined), 3000, 'worktree sessions');
  }
  await h.settle();
  return { h, ...dirs };
}
