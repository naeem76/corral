// Git through the `git` program (never a shell). Every call has a timeout.
// When `git` is missing, every project behaves as a plain folder ('dir').
//
// Worktree folders follow Nebula: `<repo-parent>/<repo-name>-worktrees/<branch>`, where
// each `/` in the branch name becomes `-` (one flat folder per branch, no nesting that
// could collide with another branch such as `feat` and `feat/x`).

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Checkout, Project } from '../types.ts';
import { resolveExecutable, run as defaultRun, type Runner, type RunResult } from './exe.ts';
import { samePath } from './paths.ts';

export class GitError extends Error {
  /** 'missing' = git not found; 'failed' = git reported an error; 'timeout'. */
  readonly code: 'missing' | 'failed' | 'timeout';
  readonly stderr: string;
  constructor(code: 'missing' | 'failed' | 'timeout', message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface CheckoutStatus {
  dirty: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead?: number;
  behind?: number;
}

export interface Branch {
  /** Short name: `main`, or `origin/main` for a remote branch. */
  name: string;
  remote: boolean;
}

export interface GitOptions {
  /** Absolute path of git. Undefined: resolve from PATH. Null: git is not available. */
  gitPath?: string | null;
  run?: Runner;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  realpath?: (p: string) => Promise<string>;
}

export interface Git {
  /** False when `git` was not found. */
  readonly available: boolean;
  /** Why git is not available, for the user. Null when it is. */
  readonly unavailableReason: string | null;
  detectKind(dir: string): Promise<'git' | 'dir'>;
  listCheckouts(project: Project): Promise<Checkout[]>;
  checkoutStatus(dir: string): Promise<CheckoutStatus>;
  listBranches(repo: string): Promise<Branch[]>;
  defaultBranch(repo: string): Promise<string | null>;
  worktreeDir(repo: string, branch: string): string;
  createWorktree(project: Project, branch: string, opts?: { base?: string; newBranch?: boolean }): Promise<string>;
  removeWorktree(project: Project, worktreePath: string, opts?: { force?: boolean }): Promise<void>;
}

export function createGit(opts: GitOptions = {}): Git {
  const platform = opts.platform ?? process.platform;
  const runner = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const real = opts.realpath ?? ((p: string) => realpath(p));
  let gitPath: string | null;
  let reason: string | null = null;
  if (opts.gitPath !== undefined) {
    gitPath = opts.gitPath;
    if (gitPath === null) reason = 'git not found on PATH';
  } else {
    const r = resolveExecutable('git');
    gitPath = r.ok ? r.path : null;
    if (!r.ok) reason = r.reason === 'shim' ? `git: only a script shim was found (${r.path})` : 'git not found on PATH';
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Status must not take locks that block the user's own Git commands.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };

  const git = async (cwd: string, args: string[], t = timeoutMs): Promise<RunResult> => {
    if (!gitPath) throw new GitError('missing', reason ?? 'git not found');
    const r = await runner(gitPath, ['-C', cwd, ...args], { timeoutMs: t, env });
    // The folder goes in `-C`, not in the process cwd, so ENOENT means git itself is gone.
    if (r.error?.code === 'ENOENT' && r.code === null) throw new GitError('missing', `git not found: ${gitPath}`);
    if (r.error && r.code === null && r.error.code !== 'ETIMEDOUT') throw new GitError('failed', r.error.message, r.stderr);
    if (r.error?.code === 'ETIMEDOUT') throw new GitError('timeout', `git ${args[0]}: timed out`);
    return r;
  };
  const gitOk = async (cwd: string, args: string[], t?: number): Promise<string> => {
    const r = await git(cwd, args, t);
    if (r.code !== 0) {
      const msg = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit code ${r.code}`;
      throw new GitError('failed', `git ${args[0]}: ${msg}`, r.stderr);
    }
    return r.stdout;
  };
  const native = (s: string) => (platform === 'win32' ? p.normalize(s) : s);

  const api: Git = {
    available: gitPath !== null,
    unavailableReason: reason,

    async detectKind(dir) {
      if (!gitPath) return 'dir';
      let out: string;
      try {
        out = await gitOk(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
      } catch {
        return 'dir';
      }
      const [top, gitDir, common] = out.split(/\r?\n/);
      if (!top || !gitDir || !common) return 'dir';
      // A linked worktree has its own git dir inside the common one.
      if (!samePath(gitDir, common, platform)) return 'dir';
      if (samePath(top, dir, platform)) return 'git';
      try {
        if (samePath(top, await real(dir), platform)) return 'git';
      } catch {}
      return 'dir';
    },

    async listCheckouts(project) {
      const plain: Checkout[] = [{ path: project.path, branch: null, isRoot: true, head: null }];
      if (project.kind !== 'git' || !gitPath) return plain;
      const out = await gitOk(project.path, ['worktree', 'list', '--porcelain', '-z']);
      const list = parseWorktreeList(out, platform);
      if (list.length === 0) return plain;
      // Keep the path form of the project for the root row, so it matches the store.
      const first = list[0] as Checkout;
      first.path = project.path;
      return list;
    },

    async checkoutStatus(dir) {
      const out = await gitOk(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
      return parseStatus(out);
    },

    async listBranches(repo) {
      const out = await gitOk(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
      const list: Branch[] = [];
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('refs/heads/')) list.push({ name: line.slice(11), remote: false });
        else if (line.startsWith('refs/remotes/') && !line.endsWith('/HEAD')) list.push({ name: line.slice(13), remote: true });
      }
      return list;
    },

    async defaultBranch(repo) {
      const head = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
      if (head.code === 0 && head.stdout.trim().startsWith('refs/remotes/')) return head.stdout.trim().slice(13);
      for (const name of ['main', 'master']) {
        const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
        if (r.code === 0) return name;
      }
      const cur = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return cur.code === 0 && cur.stdout.trim() ? cur.stdout.trim() : null;
    },

    worktreeDir(repo, branch) {
      return worktreeDir(repo, branch, platform);
    },

    async createWorktree(project, branch, o = {}) {
      if (project.kind !== 'git') throw new GitError('failed', 'not a Git repository');
      const name = branch.trim();
      const check = await git(project.path, ['check-ref-format', '--branch', name]);
      if (!name || check.code !== 0) throw new GitError('failed', `invalid branch name: ${name}`);
      const dest = worktreeDir(project.path, name, platform);
      const args = ['worktree', 'add'];
      if (o.newBranch) {
        args.push('-b', name, '--', dest);
        if (o.base) args.push(o.base);
      } else {
        args.push('--', dest, name);
      }
      await gitOk(project.path, args, Math.max(timeoutMs, 120_000));
      return dest;
    },

    async removeWorktree(project, worktreePath, o = {}) {
      if (samePath(worktreePath, project.path, platform)) throw new GitError('failed', 'cannot remove the main checkout');
      // Run from the main checkout: on Windows a process inside the folder blocks its removal.
      const args = ['worktree', 'remove'];
      if (o.force) args.push('--force');
      args.push('--', native(worktreePath));
      await gitOk(project.path, args, Math.max(timeoutMs, 60_000));
    },
  };
  return api;
}

export function worktreeDir(repo: string, branch: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = p.resolve(repo);
  const safe = branch.replace(/[\\/]/g, '-').replace(platform === 'win32' ? /[<>:"|?*]/g : /\0/g, '_');
  return p.join(p.dirname(root), `${p.basename(root)}-worktrees`, safe);
}

/** Parse `git worktree list --porcelain -z`. The main checkout comes first. */
export function parseWorktreeList(out: string, platform: NodeJS.Platform = process.platform): Checkout[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const result: Checkout[] = [];
  let cur: Checkout | null = null;
  let sha: string | null = null;
  const close = () => {
    if (cur) {
      cur.head = sha && !/^0+$/.test(sha) ? sha.slice(0, 7) : null;
      result.push(cur);
    }
    cur = null;
    sha = null;
  };
  for (const field of out.split('\0')) {
    if (field === '') {
      close();
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      close();
      cur = { path: platform === 'win32' ? p.normalize(val) : val, branch: null, isRoot: result.length === 0, head: null };
      continue;
    }
    if (!cur) continue;
    const c: Checkout = cur;
    if (key === 'HEAD') sha = val;
    else if (key === 'branch') c.branch = val.startsWith('refs/heads/') ? val.slice(11) : val;
    else if (key === 'detached') c.branch = null;
    else if (key === 'locked') c.locked = true;
    else if (key === 'prunable') c.prunable = true;
  }
  close();
  return result;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): CheckoutStatus {
  const st: CheckoutStatus = { dirty: false, branch: null, head: null, upstream: null };
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string;
    if (!f) continue;
    if (f.startsWith('# ')) {
      const [, key, ...rest] = f.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') st.head = val === '(initial)' ? null : val.slice(0, 7);
      else if (key === 'branch.head') st.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') st.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      }
      continue;
    }
    st.dirty = true;
    // A rename/copy entry is followed by one more field: the original path.
    if (f.startsWith('2 ')) i++;
  }
  return st;
}
