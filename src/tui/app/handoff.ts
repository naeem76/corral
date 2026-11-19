// Full-window fallback: give the whole terminal to the agent program (`opencode --session <id>`,
// `copilot --session-id <id>`) as a child process with inherited stdio, then take it back.
// No shell.

import { spawn } from 'node:child_process';

export interface HandoffTerminal {
  suspend(): void;
  resume(): void;
}

/** `env`: variables added to this process's environment for the child. */
export type ChildRunner = (file: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<{ code: number | null; error?: string }>;

export const runInheritedChild: ChildRunner = (file, args, cwd, env) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: 'inherit', shell: false, windowsHide: false, env: env ? { ...process.env, ...env } : process.env });
    } catch (err) {
      resolve({ code: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.once('error', (err) => resolve({ code: null, error: err.message }));
    child.once('exit', (code) => resolve({ code }));
  });

export async function handoff(
  terminal: HandoffTerminal,
  runner: ChildRunner,
  file: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number | null; error?: string }> {
  terminal.suspend();
  try {
    return await runner(file, args, cwd, env);
  } finally {
    terminal.resume();
  }
}
