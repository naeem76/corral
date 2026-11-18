// Pull requests from Azure DevOps through the `az` CLI (Azure CLI + `azure-devops` extension).
//
// Starting `az` without a shell. On Windows `az` is `az.cmd`, a batch shim, and `cmd.exe` is
// disabled on the target machine. The shim of a standard MSI install
// (`...\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`) only runs `"%~dp0\..\python.exe" -IBm azure.cli %*`
// with AZ_INSTALLER=MSI, so we start that bundled Python directly. This is read from the shim of
// current Azure CLI releases; it NEEDS A CHECK on the real Windows machine (`doctor` reports it).
// We never fall back to `powershell.exe` or `cmd.exe`.
//
// `az` holds its own login. This module never sees or passes a token.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Project, PullRequest } from '../types.ts';
import type { PrProvider } from './pr.ts';
import { resolveExecutable, run as defaultRun, type ResolveResult, type Runner, type RunResult } from './exe.ts';
import { pathKey, type Env } from './paths.ts';

export interface AzurePrOptions {
  run?: Runner;
  env?: Env;
  platform?: NodeJS.Platform;
  /** How long a result stays valid, in milliseconds. Default 60 s. */
  cacheMs?: number;
  now?: () => number;
  /** Resolve a program on PATH. Default: `resolveExecutable` with `env` and `platform`. */
  resolve?: (name: string) => ResolveResult;
  /** True when a file exists. Used to find the Python bundled with the Azure CLI. */
  exists?: (p: string) => boolean;
  /** Remote URLs of the Git repository in `dir`. Null when unknown (then `az` decides). */
  remotes?: (dir: string) => Promise<string[] | null>;
  /** How long the answer of `available()` stays valid. Default 5 min. */
  availabilityMs?: number;
  /** How long a project without an Azure DevOps remote is not asked again. Default 10 min. */
  negativeMs?: number;
  /** Timeout of one `az` call. Default 30 s. */
  timeoutMs?: number;
  /** Errors of `list()`. `list()` itself never throws. */
  onError?: (err: Error, project: Project) => void;
}

/** How `az` is started. `args` go before the `az` arguments. */
export type AzLaunch =
  | { kind: 'exe'; file: string; args: string[]; env: Record<string, string> }
  | { kind: 'python'; file: string; args: string[]; env: Record<string, string>; shim: string };

export type AzLaunchResult = { ok: true; launch: AzLaunch } | { ok: false; reason: string };

export interface AzurePrProvider extends PrProvider {
  /** Why the provider is not available, after `available()` returned false. Null otherwise. */
  reason(): string | null;
  /** How `az` will be started on this machine (synchronous, no process is started). */
  launch(): AzLaunchResult;
  /** Run `az` with these arguments through the launch strategy. For `doctor`. */
  az(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
}

/** The fixed arguments of the list call. Nothing from the user or the repository goes in here. */
export const AZ_PR_LIST_ARGS: readonly string[] = ['repos', 'pr', 'list', '--detect', 'true', '--status', 'active', '--output', 'json'];

const AZURE_HOST = /(^|[@/.])(dev\.azure\.com|visualstudio\.com)([:/]|$)/i;

/** Decide how to start `az` without a shell. */
export function resolveAzLaunch(opts: {
  platform?: NodeJS.Platform;
  resolve?: (name: string) => ResolveResult;
  exists?: (p: string) => boolean;
  env?: Env;
}): AzLaunchResult {
  const platform = opts.platform ?? process.platform;
  const resolve = opts.resolve ?? ((n: string) => resolveExecutable(n, { env: opts.env, platform }));
  const exists = opts.exists ?? existsSync;
  const r = resolve('az');
  if (r.ok) return { ok: true, launch: { kind: 'exe', file: r.path, args: [], env: {} } };
  if (r.reason === 'not-found') return { ok: false, reason: 'az (Azure CLI) not found on PATH' };
  // A shim. The MSI layout keeps python.exe one folder above `wbin`.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const python = p.join(p.dirname(p.dirname(r.path)), platform === 'win32' ? 'python.exe' : 'python');
  if (exists(python)) {
    return {
      ok: true,
      launch: { kind: 'python', file: python, args: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' }, shim: r.path },
    };
  }
  return {
    ok: false,
    reason: `az is only a script shim (${r.path}) and no bundled Python was found at ${python}; a shim needs cmd.exe, which is disabled`,
  };
}

/** Web page of a pull request, or '' when no safe https URL can be built. */
export function pullRequestWebUrl(pr: AzPr): string {
  const id = pr.pullRequestId;
  if (typeof id !== 'number' && typeof id !== 'string') return '';
  const repo = pr.repository ?? {};
  let base = '';
  if (typeof repo.webUrl === 'string' && repo.webUrl) {
    base = repo.webUrl.replace(/\/+$/, '');
  } else if (typeof pr.url === 'string' && typeof repo.name === 'string' && typeof repo.project?.name === 'string') {
    // REST form: https://dev.azure.com/{org}/{projectId}/_apis/git/repositories/{repoId}/pullRequests/{id}
    //    legacy: https://{org}.visualstudio.com[/DefaultCollection]/{projectId}/_apis/...
    const cut = pr.url.indexOf('/_apis/');
    if (cut < 0) return '';
    let root = pr.url.slice(0, cut);
    const last = root.slice(root.lastIndexOf('/') + 1);
    const proj = repo.project;
    if (last && (last === proj.id || decodeURIComponent(last) === proj.name)) root = root.slice(0, root.lastIndexOf('/'));
    base = `${root}/${encodeURIComponent(proj.name as string)}/_git/${encodeURIComponent(repo.name)}`;
  }
  if (!base) return '';
  let u: URL;
  try {
    u = new URL(`${base}/pullrequest/${encodeURIComponent(String(id))}`);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || u.username || u.password) return '';
  return u.href;
}

/** The fields of one `az repos pr list` row that we read. */
export interface AzPr {
  pullRequestId?: number | string;
  title?: string;
  sourceRefName?: string;
  targetRefName?: string;
  status?: string;
  isDraft?: boolean;
  createdBy?: { displayName?: string; uniqueName?: string };
  url?: string;
  repository?: { id?: string; name?: string; url?: string; webUrl?: string; project?: { id?: string; name?: string } };
}

const branch = (ref: unknown) => (typeof ref === 'string' ? ref.replace(/^refs\/heads\//, '') : '');

export function mapPullRequest(pr: AzPr): PullRequest | null {
  if (pr == null || typeof pr !== 'object') return null;
  if (typeof pr.pullRequestId !== 'number' && typeof pr.pullRequestId !== 'string') return null;
  const s = typeof pr.status === 'string' ? pr.status.toLowerCase() : '';
  const status: PullRequest['status'] = pr.isDraft === true
    ? 'draft'
    : s === 'completed' || s === 'abandoned' ? s : 'active';
  return {
    id: String(pr.pullRequestId),
    title: typeof pr.title === 'string' ? pr.title : '',
    url: pullRequestWebUrl(pr),
    sourceBranch: branch(pr.sourceRefName),
    targetBranch: branch(pr.targetRefName),
    author: (typeof pr.createdBy?.displayName === 'string' && pr.createdBy.displayName) || '',
    status,
  };
}

/** Parse the JSON output of `az repos pr list`. Throws on malformed output. */
export function parsePrList(stdout: string): PullRequest[] {
  const v = JSON.parse(stdout) as unknown;
  if (!Array.isArray(v)) throw new Error('az repos pr list: expected a JSON array');
  const out: PullRequest[] = [];
  for (const row of v) {
    const m = mapPullRequest(row as AzPr);
    if (m) out.push(m);
  }
  return out;
}

/** True when `az` says the folder has no Azure DevOps repository it can detect. */
function isNoRepoError(stderr: string): boolean {
  return /must be specified|could not (be )?detect|not a git repository|unable to (auto-?)?detect|no git remote/i.test(stderr);
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Strip control characters: this text ends up on the screen.
  return (lines.pop() ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300);
}

function defaultRemotes(run: Runner, env: Env, platform: NodeJS.Platform): (dir: string) => Promise<string[] | null> {
  return async (dir) => {
    const git = resolveExecutable('git', { env, platform });
    if (!git.ok) return null;
    const r = await run(git.path, ['-C', dir, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeoutMs: 10_000 });
    if (r.code === 1) return []; // no match: no remote at all
    if (r.code !== 0) return null;
    return r.stdout.split(/\r?\n/).map((l) => l.slice(l.indexOf(' ') + 1).trim()).filter(Boolean);
  };
}

export function createAzurePrProvider(opts: AzurePrOptions = {}): AzurePrProvider {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const runner = opts.run ?? defaultRun;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 60_000;
  const availMs = opts.availabilityMs ?? 5 * 60_000;
  const negativeMs = opts.negativeMs ?? 10 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const remotes = opts.remotes ?? defaultRemotes(runner, env, platform);

  let launchMemo: AzLaunchResult | null = null;
  let avail: { at: number; ok: boolean; reason: string | null } | null = null;
  let availPending: Promise<boolean> | null = null;
  const cache = new Map<string, { at: number; list: PullRequest[] }>();
  const lastGood = new Map<string, PullRequest[]>();
  const negative = new Map<string, number>();
  const inflight = new Map<string, Promise<PullRequest[]>>();

  const launch = (): AzLaunchResult => {
    launchMemo ??= resolveAzLaunch({ platform, env, resolve: opts.resolve, exists: opts.exists });
    return launchMemo;
  };

  const az = async (args: string[], o: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> => {
    const l = launch();
    if (!l.ok) return { code: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: l.reason } };
    const childEnv: Env = { ...env, ...l.launch.env, AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_NO_COLOR: 'true' };
    return runner(l.launch.file, [...l.launch.args, ...args], { cwd: o.cwd, timeoutMs: o.timeoutMs ?? timeoutMs, env: childEnv });
  };

  const checkAvailable = async (): Promise<boolean> => {
    const set = (ok: boolean, reason: string | null) => {
      avail = { at: now(), ok, reason };
      return ok;
    };
    const l = launch();
    if (!l.ok) return set(false, l.reason);
    const r = await az(['version', '--output', 'json'], { timeoutMs: 20_000 });
    if (r.code !== 0) return set(false, `az version failed: ${r.error?.message ?? (lastLine(r.stderr) || `exit code ${r.code}`)}`);
    let v: { extensions?: Record<string, unknown> };
    try {
      v = JSON.parse(r.stdout) as typeof v;
    } catch {
      return set(false, 'az version: output is not JSON');
    }
    if (!v.extensions || typeof v.extensions['azure-devops'] !== 'string') {
      return set(false, 'the azure-devops extension is not installed (az extension add --name azure-devops)');
    }
    return set(true, null);
  };

  const provider: AzurePrProvider = {
    reason() {
      if (avail) return avail.ok ? null : avail.reason;
      const l = launch();
      return l.ok ? null : l.reason;
    },
    launch,
    az,

    available() {
      if (avail && now() - avail.at < availMs) return Promise.resolve(avail.ok);
      availPending ??= checkAvailable()
        .catch((err) => {
          avail = { at: now(), ok: false, reason: String((err as Error)?.message ?? err) };
          return false;
        })
        .finally(() => {
          availPending = null;
        });
      return availPending;
    },

    list(project) {
      if (project.kind !== 'git') return Promise.resolve([]);
      const key = pathKey(project.path, platform);
      const t = now();
      const neg = negative.get(key);
      if (neg !== undefined && t < neg) return Promise.resolve([]);
      const hit = cache.get(key);
      if (hit && t - hit.at < cacheMs) return Promise.resolve(hit.list);
      const running = inflight.get(key);
      if (running) return running;

      const fail = (message: string): PullRequest[] => {
        try {
          opts.onError?.(new Error(message), project);
        } catch {}
        const list = lastGood.get(key) ?? [];
        // Do not run az again for every redraw while it keeps failing.
        cache.set(key, { at: now(), list });
        return list;
      };

      const p = (async (): Promise<PullRequest[]> => {
        const urls = await remotes(project.path).catch(() => null);
        if (urls && !urls.some((u) => AZURE_HOST.test(u))) {
          negative.set(key, now() + negativeMs);
          return [];
        }
        if (!(await provider.available())) return [];
        const r = await az([...AZ_PR_LIST_ARGS], { cwd: project.path });
        if (r.code !== 0) {
          if (r.code !== null && isNoRepoError(r.stderr)) {
            negative.set(key, now() + negativeMs);
            return [];
          }
          return fail(`az repos pr list: ${r.error?.message ?? (lastLine(r.stderr) || `exit code ${r.code}`)}`);
        }
        let list: PullRequest[];
        try {
          list = parsePrList(r.stdout);
        } catch (err) {
          return fail(`az repos pr list: ${(err as Error).message}`);
        }
        cache.set(key, { at: now(), list });
        lastGood.set(key, list);
        negative.delete(key);
        return list;
      })()
        .catch((err) => fail(String((err as Error)?.message ?? err)))
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
  return provider;
}
