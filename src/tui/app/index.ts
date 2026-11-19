// Composition root: build the real parts, open the terminal, run the App until it quits.

import os from 'node:os';
import path from 'node:path';
import type { AgentId } from '../../types.ts';
import {
  copilotHome, createGit, discoverService, ensureService, envGet, OpenCodeClient, openPty, resolveExecutable, run,
  SessionTracker, stateDir, Store, type ServiceInfo,
} from '../../core/index.ts';
import { CopilotSource } from '../../core/copilot.ts';
import { resolveCopilotLaunch } from '../../core/copilot-launch.ts';
import { SessionHub } from '../../core/session-hub.ts';
import { createAzurePrProvider } from '../../core/pr-azure.ts';
import { createEmulator } from '../../term/index.ts';
import { detectColorDepth } from '../style.ts';
import { NotATerminalError, openTerminal, type ProcessLike } from '../terminal.ts';
import { App, type AppDeps } from './app.ts';
import { createNodeBrowserFs } from './browser.ts';
import { runInheritedChild } from './handoff.ts';
import { createLauncher } from './launcher.ts';
import { createLogger, makeRedactor } from './log.ts';
import { openUrl } from './open-url.ts';
import { defaultIsAlive } from './stale.ts';

export { App, createApp } from './app.ts';
export type { AppDeps, AppSessions, AppStore, TerminalLike } from './app.ts';

export async function runApp(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write(`nebula-enterprise: unknown argument: ${argv[0]}\nRun with --help for the usage.\n`);
    return 2;
  }
  const env = process.env;
  const platform = process.platform;
  const homedir = os.homedir();

  // The password lives only here and in the client; the redactor removes it from every text.
  let password: string | undefined;
  const discover = async (): Promise<ServiceInfo | null> => {
    const info = await discoverService();
    if (info) password = info.password;
    return info;
  };
  const client = new OpenCodeClient({ discover });
  const redact = ((r1: (t: string) => string) => (t: string) => client.redact(r1(t)))(makeRedactor(() => [password]));
  const log = createLogger({ file: envGet(env, 'NEBULA_LOG', platform), redact });

  const git = createGit();
  const store = new Store({
    dir: stateDir(env, platform, homedir),
    detectKind: (p) => git.detectKind(p),
    onError: (err) => log(`store: ${err.message}`),
  });
  try {
    await store.load();
  } catch (err) {
    process.stderr.write(`nebula-enterprise: cannot read ${store.file}: ${(err as Error).message}\n`);
    return 1;
  }
  if (store.recoveredFrom) log(`state.json was corrupt; moved to ${store.recoveredFrom}`);

  let app: App | null = null;
  let exiting = false;
  // The terminal calls this after it restored the screen (signal, crash). Clean up with a
  // short limit, then leave.
  const emergencyExit = (code?: number): void => {
    if (exiting) return;
    exiting = true;
    const c = code ?? 1;
    setTimeout(() => process.exit(c), 2500).unref();
    void (app ? app.shutdown(c) : Promise.resolve()).finally(() => process.exit(c));
  };
  const proc: ProcessLike = {
    on: (event, cb) => process.on(event as NodeJS.Signals, cb),
    removeListener: (event, cb) => process.removeListener(event as NodeJS.Signals, cb),
    exit: (code?: number) => emergencyExit(code),
    get exitCode() {
      return process.exitCode;
    },
  };

  let terminal;
  try {
    terminal = openTerminal({ stdin: process.stdin, stdout: process.stdout, proc });
  } catch (err) {
    if (err instanceof NotATerminalError) {
      process.stderr.write(`nebula-enterprise: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const tracker = new SessionTracker({ client, store, onError: (err) => log(`tracker: ${err.message}`) });
  // Copilot has no "viewed" mark: turns that ended before the first run with Copilot count as seen.
  if (typeof store.ui.copilotSeenSince !== 'number') store.setUi({ copilotSeenSince: Date.now() });
  const cpHome = copilotHome(env, platform, homedir);
  const copilotLaunch = () => resolveCopilotLaunch({ env, platform });
  const copilot = new CopilotSource({
    home: cpHome,
    store,
    launch: copilotLaunch,
    seenSince: () => (typeof store.ui.copilotSeenSince === 'number' ? store.ui.copilotSeenSince : 0),
    onError: (err) => log(`copilot: ${err.message}`),
  });
  // A program in the service PTY does not see our environment: name the home when it is not the default.
  const copilotEnv = (): Record<string, string> =>
    path.resolve(cpHome) === path.resolve(homedir, '.copilot') ? {} : { COPILOT_HOME: cpHome };
  const saved = store.ui.defaultAgent;
  const hub = new SessionHub(
    [
      { agent: 'opencode', source: tracker },
      { agent: 'copilot', source: copilot },
    ],
    { defaultAgent: saved === 'copilot' || saved === 'opencode' ? saved : undefined, onError: (err) => log(`sessions: ${err.message}`) },
  );
  const installedAt = new Map<AgentId, { at: number; yes: boolean }>();
  const agentInstalled = (agent: AgentId): boolean => {
    const c = installedAt.get(agent);
    if (c && Date.now() - c.at < 60_000) return c.yes;
    let yes: boolean;
    if (agent === 'copilot') yes = copilot.programFound;
    else {
      const r = resolveExecutable('opencode');
      // A shim counts: the user may start the service by hand, so its absence is an error.
      yes = r.ok || r.reason === 'shim' || !!envGet(env, 'NEBULA_OPENCODE_URL', platform);
    }
    installedAt.set(agent, { at: Date.now(), yes });
    return yes;
  };
  const deps: AppDeps = {
    terminal,
    store,
    git,
    hub,
    agentInstalled,
    client,
    prs: createAzurePrProvider(),
    launcher: createLauncher({
      resolve: (n) => resolveExecutable(n),
      run,
      serviceVersion: async () => (await discover())?.version,
      copilot: copilotLaunch,
      copilotEnv,
    }),
    openPty: (spawn) => openPty(client, spawn, { onError: (err) => log(`pty: ${err.message}`) }),
    createEmulator: (cols, rows) => createEmulator(cols, rows),
    ensureService: async () => {
      const info = await ensureService({ isAlive: defaultIsAlive });
      password = info.password;
    },
    runChild: runInheritedChild,
    openUrl: (url) => openUrl(url),
    fs: createNodeBrowserFs(),
    now: Date.now,
    pid: process.pid,
    isAlive: defaultIsAlive,
    platform,
    homedir,
    log,
    redact,
    depth: detectColorDepth(env),
  };
  app = new App(deps);
  app.start();
  const code = await app.done;
  // Keep-alive sockets of fetch must not hold the process open after quit.
  setTimeout(() => process.exit(code), 500).unref();
  return code;
}
