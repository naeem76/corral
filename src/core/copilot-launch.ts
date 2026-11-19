// How to start the GitHub Copilot CLI without a shell.
//
// Linux/macOS: `copilot` on PATH (the npm loader script has a `#!/usr/bin/env node` line and is
// executable, so it can start without a shell).
// Windows: a WinGet install puts a real `copilot.exe` on PATH. An npm install puts only the
// shim `copilot.cmd`, which needs cmd.exe (disabled on the target machine). The npm package
// `@github/copilot` is a loader plus one native package per platform, so we look for the native
// `copilot.exe` next to the shim, and as the last resort start the loader with our own Node.
// The Windows layout is read from the npm package; it is NOT verified on Windows (`doctor`
// reports which branch was taken).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { envGet, type Env } from './paths.ts';
import { resolveExecutable, type ResolveResult } from './exe.ts';

export type CopilotLaunch =
  /** `kind` tells `doctor` which branch was taken. `args` go before the Copilot arguments. */
  | { ok: true; kind: 'override' | 'exe' | 'native' | 'loader'; command: string; args: string[]; shim?: string }
  | { ok: false; reason: string };

export interface CopilotLaunchOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Path of the Node executable for the loader fallback. Default: `process.execPath`. */
  execPath?: string;
  /** Resolve a program on PATH. Default: `resolveExecutable` with `env` and `platform`. */
  resolve?: (name: string) => ResolveResult;
  /** True when a file exists. */
  exists?: (p: string) => boolean;
}

/** Decide how to start `copilot`. Synchronous, starts nothing. */
export function resolveCopilotLaunch(opts: CopilotLaunchOptions = {}): CopilotLaunch {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const resolve = opts.resolve ?? ((n: string) => resolveExecutable(n, { env, platform }));
  const p = platform === 'win32' ? path.win32 : path.posix;

  const override = envGet(env, 'CORRAL_COPILOT_BIN', platform);
  if (override) {
    const file = p.resolve(override);
    if (!exists(file)) return { ok: false, reason: `CORRAL_COPILOT_BIN points to a missing file: ${file}` };
    const ext = p.extname(file).toLowerCase();
    if (platform === 'win32' && ext !== '.exe' && ext !== '.com') {
      return { ok: false, reason: `CORRAL_COPILOT_BIN must name a .exe on Windows (a script needs a shell): ${file}` };
    }
    return { ok: true, kind: 'override', command: file, args: [] };
  }

  const r = resolve('copilot');
  if (r.ok) return { ok: true, kind: 'exe', command: r.path, args: [] };
  if (r.reason === 'not-found') return { ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' };

  // Only a script shim (npm on Windows). The npm global layout keeps the package in
  // `<shim dir>/node_modules/@github/copilot`.
  const arch = (opts.arch ?? process.arch) === 'arm64' ? 'arm64' : 'x64';
  const exeName = platform === 'win32' ? 'copilot.exe' : 'copilot';
  const native = `copilot-${platform === 'win32' ? 'win32' : platform}-${arch}`;
  const modules = p.join(p.dirname(r.path), 'node_modules');
  const pkg = p.join(modules, '@github', 'copilot');
  const candidates = [
    p.join(pkg, 'node_modules', '@github', native, exeName),
    p.join(modules, '@github', native, exeName),
  ];
  for (const c of candidates) if (exists(c)) return { ok: true, kind: 'native', command: c, args: [], shim: r.path };
  const loader = p.join(pkg, 'npm-loader.js');
  if (exists(loader)) {
    return { ok: true, kind: 'loader', command: opts.execPath ?? process.execPath, args: [loader], shim: r.path };
  }
  return {
    ok: false,
    reason: `copilot is only a script shim (${r.path}), and neither the native ${exeName} nor npm-loader.js was found under ${pkg}; a shim needs cmd.exe, which is disabled`,
  };
}

/** Arguments that resume a session, or start a new one with this id. */
export function copilotSessionArgs(id: string): string[] {
  return ['--session-id', id];
}
