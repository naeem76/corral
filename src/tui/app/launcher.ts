// Decides how to start the OpenCode TUI, and whether it is safe to start it at all.
//
// Verified hazard: when the `opencode` CLI version differs from the running service version,
// starting the OpenCode TUI makes the service stop or restart, which ends the user's running
// sessions. So before every first spawn we compare `opencode --version` with the version in
// `service.json`, and refuse on a mismatch.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeResolveFailure, type ResolveResult, type Runner } from '../../core/exe.ts';

export type LaunchPlan =
  | {
      ok: true;
      /** Absolute path when found, else the plain name (the service resolves it on its PATH). */
      command: string;
      /** Set when only a script shim was found: the text that explains it. */
      shimNote: string | null;
      /** True when `command` is a real executable this process can start (hand-off). */
      runnableHere: boolean;
      /** Set when the CLI version could not be compared with the service. */
      warning?: string;
    }
  | { ok: false; message: string };

export interface LauncherDeps {
  resolve: (name: string) => ResolveResult;
  run: Runner;
  /** Version of the running service, from service.json. Undefined when unknown. */
  serviceVersion: () => Promise<string | undefined>;
  /** Reads package.json next to a script shim. Default: fs.readFile. */
  readFile?: (p: string) => Promise<string>;
  platform?: NodeJS.Platform;
}

/**
 * Version of an npm-installed opencode, read from the package next to its shim
 * (`<dir>/opencode.cmd` -> `<dir>/node_modules/opencode-ai/package.json`). A shim cannot run
 * without a shell, so `opencode --version` is not possible.
 */
export async function shimVersion(shim: string, read: (p: string) => Promise<string>, platform: NodeJS.Platform): Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(shim);
  for (const pkg of ['opencode-ai', 'opencode']) {
    try {
      const v = JSON.parse(await read(p.join(dir, 'node_modules', pkg, 'package.json'))) as { version?: unknown };
      if (typeof v.version === 'string') return parseVersion(v.version);
    } catch {}
  }
  return null;
}

export interface Launcher {
  prepare(): Promise<LaunchPlan>;
}

/** "opencode v2.3.2" / "2.3.2" -> "2.3.2". */
export function parseVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return m ? (m[1] as string) : null;
}

export function createLauncher(deps: LauncherDeps): Launcher {
  let cliVersion: string | null = null;
  return {
    async prepare(): Promise<LaunchPlan> {
      const r = deps.resolve('opencode');
      const command = r.ok ? r.path : 'opencode';
      const shimNote = !r.ok && r.reason === 'shim' ? describeResolveFailure('opencode', r) : null;
      const service = await deps.serviceVersion().catch(() => undefined);
      if (service === undefined) {
        // Nothing to compare with (for example NEBULA_OPENCODE_URL is set). Allow it.
        return { ok: true, command, shimNote, runnableHere: r.ok };
      }
      if (!r.ok) {
        // The service starts the program itself, so a missing or shim-only CLI here does not
        // stop the pane. Compare what we can; start without a check only as the last resort.
        const v = r.reason === 'shim' ? await shimVersion(r.path, deps.readFile ?? ((f) => readFile(f, 'utf8')), deps.platform ?? process.platform) : null;
        const svc = parseVersion(service) ?? service;
        if (v && v !== svc) return { ok: false, message: mismatch(v, svc) };
        const warning = v ? undefined : `The opencode CLI version was not checked (${describeResolveFailure('opencode', r)}). If it differs from the service (${svc}), the service restarts.`;
        return { ok: true, command, shimNote, runnableHere: false, warning };
      }
      if (cliVersion === null) {
        const out = await deps.run(r.path, ['--version'], { timeoutMs: 15_000 });
        const v = out.code === 0 ? parseVersion(out.stdout + ' ' + out.stderr) : null;
        if (!v) {
          const why = out.error?.message ?? (out.stderr.trim() || `exit code ${out.code}`);
          return { ok: false, message: `Cannot check the OpenCode version (opencode --version: ${why.slice(0, 200)}). Nothing was started.` };
        }
        cliVersion = v;
      }
      const svc = parseVersion(service) ?? service;
      if (svc !== cliVersion) {
        // Check again next time: the user may upgrade the CLI without restarting this program.
        const cli = cliVersion;
        cliVersion = null;
        return { ok: false, message: mismatch(cli, svc) };
      }
      return { ok: true, command, shimNote, runnableHere: true };
    },
  };
}

function mismatch(cli: string, svc: string): string {
  return `Version mismatch: the opencode CLI is ${cli}, the OpenCode service runs ${svc}. Starting the TUI now would restart the service. Run "opencode service restart" yourself when your sessions are idle, then try again.`;
}
