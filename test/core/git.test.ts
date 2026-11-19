import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGit, parseStatus, parseWorktreeList, worktreeDir } from '../../src/core/git.ts';
import { resolveExecutable, run } from '../../src/core/exe.ts';
import type { Project } from '../../src/types.ts';

const gitExe = resolveExecutable('git');
const skip = gitExe.ok ? false : 'git not on PATH';
const made: string[] = [];
after(() => Promise.all(made.map((d) => rm(d, { recursive: true, force: true }))));

test('parse worktree list: Windows paths, spaces, detached, locked, prunable, unborn', () => {
  const out = [
    'worktree C:/Users/Ann Lee/src/my repo', 'HEAD 1234567890abcdef1234567890abcdef12345678', 'branch refs/heads/main', '',
    'worktree C:/Users/Ann Lee/src/my repo-worktrees/feat-x', 'HEAD abcdef1234567890abcdef1234567890abcdef12', 'branch refs/heads/feat/x', 'locked reason here', '',
    'worktree C:/Users/Ann Lee/src/my repo-worktrees/détaché', 'HEAD fedcba9876543210fedcba9876543210fedcba98', 'detached', 'prunable gitdir file points to non-existent location', '',
    'worktree C:/Users/Ann Lee/src/new', 'HEAD 0000000000000000000000000000000000000000', 'branch refs/heads/empty', '',
  ].join('\0');
  assert.deepEqual(parseWorktreeList(out, 'win32'), [
    { path: 'C:\\Users\\Ann Lee\\src\\my repo', branch: 'main', isRoot: true, head: '1234567' },
    { path: 'C:\\Users\\Ann Lee\\src\\my repo-worktrees\\feat-x', branch: 'feat/x', isRoot: false, head: 'abcdef1', locked: true },
    { path: 'C:\\Users\\Ann Lee\\src\\my repo-worktrees\\détaché', branch: null, isRoot: false, head: 'fedcba9', prunable: true },
    { path: 'C:\\Users\\Ann Lee\\src\\new', branch: 'empty', isRoot: false, head: null },
  ]);
  assert.deepEqual(parseWorktreeList('worktree /a\0bare\0\0', 'linux'), [{ path: '/a', branch: null, isRoot: true, head: null }]);
});

test('parse status v2', () => {
  const clean = '# branch.oid abcdef1234\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0';
  assert.deepEqual(parseStatus(clean), { dirty: false, branch: 'main', head: 'abcdef1', upstream: 'origin/main', ahead: 2, behind: 1 });
  const dirty = '# branch.oid (initial)\0# branch.head (detached)\0? new file.txt\0';
  assert.deepEqual(parseStatus(dirty), { dirty: true, branch: null, head: null, upstream: null });
  const renamed = '# branch.oid abcdef1\0# branch.head x\x002 R. N... 100644 100644 100644 a b R100 new\0old\0';
  assert.equal(parseStatus(renamed).dirty, true);
});

test('worktreeDir convention', () => {
  assert.equal(worktreeDir('/src/repo', 'feat/x', 'linux'), '/src/repo-worktrees/feat-x');
  assert.equal(worktreeDir('C:\\src\\repo\\', 'a/b:c', 'win32'), 'C:\\src\\repo-worktrees\\a-b_c');
});

test('missing git: projects act as plain folders', async () => {
  const g = createGit({ gitPath: null });
  assert.equal(g.available, false);
  assert.ok(g.unavailableReason);
  assert.equal(await g.detectKind(os.tmpdir()), 'dir');
  const rows = await g.listCheckouts({ id: '1', path: '/x', name: 'x', kind: 'git' });
  assert.deepEqual(rows, [{ path: '/x', branch: null, isRoot: true, head: null }]);
  await assert.rejects(g.checkoutStatus('/x'), (e: { code: string }) => e.code === 'missing');
  const vanished = createGit({ gitPath: '/no/such/git' });
  await assert.rejects(vanished.checkoutStatus(os.tmpdir()), (e: { code: string }) => e.code === 'missing');
});

async function makeRepo(): Promise<{ root: string; repo: string; git: (...a: string[]) => Promise<string> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'corral-git-')));
  made.push(root);
  const repo = path.join(root, 'my repo');
  await mkdir(repo);
  const exe = (gitExe as { path: string }).path;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  const git = async (...a: string[]) => {
    const r = await run(exe, ['-C', repo, ...a], { env });
    if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  await git('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'first');
  return { root, repo, git };
}

test('real git: detectKind, list, create, status, detached, remove', { skip }, async () => {
  const { root, repo, git } = await makeRepo();
  const g = createGit();
  assert.equal(await g.detectKind(repo), 'git');
  assert.equal(await g.detectKind(repo + path.sep), 'git');
  await mkdir(path.join(repo, 'sub'));
  assert.equal(await g.detectKind(path.join(repo, 'sub')), 'dir');
  assert.equal(await g.detectKind(root), 'dir');
  const project: Project = { id: 'p', path: repo, name: 'my repo', kind: 'git' };

  assert.equal(await g.defaultBranch(repo), 'main');
  const wt = await g.createWorktree(project, 'feat/ünï', { newBranch: true, base: 'main' });
  assert.equal(wt, path.join(root, 'my repo-worktrees', 'feat-ünï'));
  assert.equal(await g.detectKind(wt), 'dir', 'a linked worktree is not a main checkout');
  await git('worktree', 'add', '-q', '--detach', path.join(root, 'det'), 'HEAD');

  const rows = await g.listCheckouts(project);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0] && [rows[0].path, rows[0].branch, rows[0].isRoot], [repo, 'main', true]);
  // Git orders linked worktrees by path.
  const linked = rows.slice(1).map((r) => [r.path, r.branch, r.isRoot]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(linked, [
    [path.join(root, 'det'), null, false],
    [wt, 'feat/ünï', false],
  ]);
  const featRow = rows.find((r) => r.path === wt);
  assert.match(rows[0]?.head ?? '', /^[0-9a-f]{7}$/);

  assert.deepEqual(await g.checkoutStatus(wt), { dirty: false, branch: 'feat/ünï', head: featRow?.head, upstream: null });
  await writeFile(path.join(wt, 'new file.txt'), 'x');
  assert.equal((await g.checkoutStatus(wt)).dirty, true);

  const branches = await g.listBranches(repo);
  assert.deepEqual(branches.map((b) => b.name).sort(), ['feat/ünï', 'main']);

  await assert.rejects(g.removeWorktree(project, wt), /git worktree/);
  await g.removeWorktree(project, wt, { force: true });
  await assert.rejects(g.removeWorktree(project, repo), /main checkout/);
  await assert.rejects(g.createWorktree(project, 'bad..name', { newBranch: true }), /invalid branch/);
  const after = await g.listCheckouts(project);
  assert.equal(after.length, 2);

  // existing branch, not new
  await git('branch', 'other');
  const wt2 = await g.createWorktree(project, 'other');
  assert.equal((await g.checkoutStatus(wt2)).branch, 'other');
});

test('real git: a dir project has one root row', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'corral-dir-'));
  made.push(dir);
  const g = createGit();
  assert.equal(await g.detectKind(dir), 'dir');
  assert.deepEqual(await g.listCheckouts({ id: 'd', path: dir, name: 'd', kind: 'dir' }), [{ path: dir, branch: null, isRoot: true, head: null }]);
});
