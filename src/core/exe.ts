// Find and run programs without a shell. On Windows `cmd.exe` is disabled on the target
// machine, so a `.cmd`/`.bat`/`.ps1` shim cannot run: we report it instead of starting it.

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { envGet, type Env } from './paths.ts';

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-found' }
  /** A script shim was found, but no real executable. `path` is the shim. */
  | { ok: false; reason: 'shim'; path: string };

export interface ResolveOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  /** True when `p` is a file this process can execute. Replaced in tests. */
  isExecutable?: (p: string, platform: NodeJS.Platform) => boolean;
}

const RUNNABLE_WIN = ['.exe', '.com'];
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export function defaultIsExecutable(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a program name (or path) to an absolute executable path. */
export function resolveExecutable(name: string, opts: ResolveOptions = {}): ResolveResult {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isExe = opts.isExecutable ?? defaultIsExecutable;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const win = platform === 'win32';

  const pathext = win
    ? (envGet(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.startsWith('.'))
    : [];
  // A shim on PATH ranks after a real executable anywhere on PATH.
  let shim: string | null = null;

  const tryFile = (file: string): string | null => {
    if (!isExe(file, platform)) return null;
    if (!win) return file;
    const ext = p.extname(file).toLowerCase();
    if (RUNNABLE_WIN.includes(ext)) return file;
    if (shim === null) shim = file;
    return null;
  };

  const tryBase = (base: string): string | null => {
    if (win) {
      const ext = p.extname(base).toLowerCase();
      if (ext && (pathext.includes(ext) || RUNNABLE_WIN.includes(ext) || ext === '.ps1')) {
        const hit = tryFile(base);
        if (hit) return hit;
      }
      for (const e of pathext) {
        const hit = tryFile(base + e);
        if (hit) return hit;
      }
      // PowerShell scripts are not in PATHEXT, but npm installs them next to `.cmd` shims.
      if (shim === null && isExe(base + '.ps1', platform)) shim = base + '.ps1';
      return null;
    }
    return tryFile(base);
  };

  const hasDir = name.includes('/') || (win && name.includes('\\'));
  if (hasDir || p.isAbsolute(name)) {
    const hit = tryBase(p.resolve(name));
    if (hit) return { ok: true, path: hit };
  } else {
    const pathVar = envGet(env, 'PATH', platform) ?? '';
    for (const raw of pathVar.split(p.delimiter)) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      if (!dir || !p.isAbsolute(dir)) continue;
      const hit = tryBase(p.join(dir, name));
      if (hit) return { ok: true, path: hit };
    }
  }
  if (shim !== null) return { ok: false, reason: 'shim', path: shim };
  return { ok: false, reason: 'not-found' };
}

/** Text that explains a failed resolve to the user. */
export function describeResolveFailure(name: string, r: ResolveResult): string {
  if (r.ok) return '';
  if (r.reason === 'shim') {
    return `${name}: found only a script shim (${r.path}). It needs a shell, which is not permitted. Install a real ${name}.exe or put its folder on PATH.`;
  }
  return `${name}: not found on PATH`;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Env;
  /** Text written to stdin, then stdin is closed. */
  input?: string;
}

export interface RunResult {
  /** Exit code. Null when the process did not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process did not start, timed out or produced too much output. */
  error?: { code: string; message: string };
}

export type Runner = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Run a program with an argument array. Never uses a shell and never throws. */
export const run: Runner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        file,
        args,
        {
          cwd: opts.cwd,
          env: opts.env as NodeJS.ProcessEnv | undefined,
          timeout: opts.timeoutMs ?? 30_000,
          maxBuffer: opts.maxBytes ?? 16 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
          if (typeof e.code === 'number') {
            resolve({ code: e.code, stdout, stderr });
            return;
          }
          let code = typeof e.code === 'string' ? e.code : 'ERROR';
          if (e.killed && code === 'ERROR') code = 'ETIMEDOUT';
          resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: { code, message: messageOf(file, code, e) } });
        },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({ code: null, stdout: '', stderr: '', error: { code: e.code ?? 'ERROR', message: String(e.message) } });
      return;
    }
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

function messageOf(file: string, code: string, e: Error): string {
  if (code === 'ENOENT') return `${file}: program not found`;
  if (code === 'ETIMEDOUT') return `${file}: timed out`;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `${file}: too much output`;
  return `${file}: ${e.message}`;
}
