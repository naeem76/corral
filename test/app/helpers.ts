// Fakes for headless application tests: a terminal fed with key bytes, an in-memory
// OpenCode service (sessions, permissions, PTY list), scripted events, and fake PTYs.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Emulator, InputEvent, PtyHandle, PtySpawn } from '../../src/types.ts';
import { createInputDecoder } from '../../src/tui/input.ts';
import { OpenCodeError, type Connection, type OpenCodeApi, type RequestOptions } from '../../src/core/opencode.ts';
import { SessionTracker, type EventHandlers } from '../../src/core/sessions.ts';
import { Store } from '../../src/core/store.ts';
import { createGit, type Git } from '../../src/core/git.ts';
import { run } from '../../src/core/exe.ts';
import { createEmulator } from '../../src/term/index.ts';
import { App, type AppDeps, type Modal, type TerminalLike } from '../../src/tui/app/app.ts';
import { createNodeBrowserFs } from '../../src/tui/app/browser.ts';
import type { Launcher } from '../../src/tui/app/launcher.ts';
import type { PrProvider } from '../../src/core/pr.ts';

export const PASSWORD = 'pw-Very-Secret-12345';

export class FakeTerminal implements TerminalLike {
  cols: number;
  rows: number;
  out: string[] = [];
  closed = false;
  suspended = false;
  suspendCount = 0;
  #input = new Set<(e: InputEvent[]) => void>();
  #resize = new Set<(s: { cols: number; rows: number }) => void>();
  #redraw = new Set<() => void>();
  #decoder = createInputDecoder();

  constructor(cols = 160, rows = 40) {
    this.cols = cols;
    this.rows = rows;
  }
  size() {
    return { cols: this.cols, rows: this.rows };
  }
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.#resize.add(cb);
    return () => void this.#resize.delete(cb);
  }
  onInput(cb: (e: InputEvent[]) => void) {
    this.#input.add(cb);
    return () => void this.#input.delete(cb);
  }
  onRedraw(cb: () => void) {
    this.#redraw.add(cb);
    return () => void this.#redraw.delete(cb);
  }
  write(data: string) {
    if (!this.closed && !this.suspended) this.out.push(data);
  }
  suspend() {
    this.suspended = true;
    this.suspendCount++;
  }
  resume() {
    this.suspended = false;
    for (const cb of this.#redraw) cb();
  }
  close() {
    this.closed = true;
  }
  /** Feed raw bytes as typed by the user. */
  type(bytes: string): void {
    const evs = [...this.#decoder.feed(bytes), ...this.#decoder.flush()];
    for (const cb of this.#input) cb(evs);
  }
  events(evs: InputEvent[]): void {
    for (const cb of this.#input) cb(evs);
  }
  resizeTo(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const cb of this.#resize) cb({ cols, rows });
  }
}

export interface FakeSession {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  idle?: number;
  archived?: number;
  parentID?: string;
}

/** In-memory OpenCode service behind the OpenCodeApi interface. */
export class FakeService implements OpenCodeApi {
  sessions = new Map<string, FakeSession>();
  active = new Set<string>();
  perms: Array<{ id: string; sessionID: string; dir: string }> = [];
  ptys: Array<{ id: string; title: string; dir: string }> = [];
  requests: Array<{ method: string; path: string; query?: Record<string, unknown>; body?: unknown }> = [];
  down = false;
  #n = 0;

  connection(): Promise<Connection> {
    if (this.down) return Promise.reject(new OpenCodeError(0, 'ServiceNotFound', 'OpenCode service is not running'));
    return Promise.resolve({ url: 'http://fake', authorization: 'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64') });
  }

  redact(t: string): string {
    return t.split(PASSWORD).join('***');
  }

  addSession(s: Partial<FakeSession> & { directory: string; title: string }): FakeSession {
    const now = Date.now();
    const full: FakeSession = { id: s.id ?? `ses_${++this.#n}`, created: now, updated: now, ...s };
    this.sessions.set(full.id, full);
    return full;
  }

  #info(s: FakeSession) {
    return {
      id: s.id,
      parentID: s.parentID,
      title: s.title,
      time: { created: s.created, updated: s.updated, idle: s.idle, archived: s.archived },
      location: { directory: s.directory },
    };
  }

  async request<T = unknown>(method: string, p: string, opts: RequestOptions = {}): Promise<T> {
    this.requests.push({ method, path: p, query: opts.query as Record<string, unknown>, body: opts.body });
    if (this.down) throw new OpenCodeError(0, 'ConnectionError', `${method} ${p}: cannot connect`);
    const q = (opts.query ?? {}) as Record<string, string>;
    const loc = q['location[directory]'];
    const r = (v: unknown) => v as T;
    if (method === 'GET' && p === '/api/session') {
      const dir = q.directory;
      return r({ data: [...this.sessions.values()].filter((s) => s.directory === dir).map((s) => this.#info(s)) });
    }
    if (method === 'GET' && p === '/api/session/active') return r({ data: Object.fromEntries([...this.active].map((id) => [id, {}])) });
    if (method === 'GET' && p === '/api/permission/request') return r({ data: this.perms.filter((x) => x.dir === loc).map(({ id, sessionID }) => ({ id, sessionID })) });
    if (method === 'GET' && p === '/api/form') return r({ data: [] });
    if (method === 'POST' && p === '/api/session') {
      const body = opts.body as { location: { directory: string }; title?: string };
      const s = this.addSession({ directory: body.location.directory, title: body.title ?? 'New session' });
      return r({ data: this.#info(s) });
    }
    const m = /^\/api\/session\/([^/]+)(\/view)?$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1] as string);
      const s = this.sessions.get(id);
      if (!s) throw new OpenCodeError(404, 'SessionNotFoundError', 'not found');
      if (m[2]) return r({});
      if (method === 'PATCH') {
        const b = opts.body as { title?: string; archived?: boolean };
        if (b.title !== undefined) s.title = b.title;
        if (b.archived === true) s.archived = Date.now();
        if (b.archived === false) delete s.archived;
        return r({ data: this.#info(s) });
      }
      if (method === 'DELETE') {
        this.sessions.delete(id);
        return r({});
      }
    }
    if (method === 'GET' && p === '/api/pty') {
      return r({ location: { directory: loc }, data: this.ptys.filter((x) => x.dir === loc).map((x) => ({ id: x.id, title: x.title })) });
    }
    const pm = /^\/api\/pty\/([^/]+)$/.exec(p);
    if (pm && method === 'DELETE') {
      const id = decodeURIComponent(pm[1] as string);
      this.ptys = this.ptys.filter((x) => x.id !== id);
      return r(undefined);
    }
    throw new OpenCodeError(404, 'NotFound', `${method} ${p}: not in the fake`);
  }
}

/** Event stream for the tracker, driven by the test. */
export class FakeEvents {
  handlers: EventHandlers | null = null;
  subscribe = (_types: readonly string[], h: EventHandlers) => {
    this.handlers = h;
    return { close: () => (this.handlers = null) };
  };
  connect(): void {
    this.handlers?.onConnect();
  }
  emit(type: string, data: unknown, directory?: string): void {
    this.handlers?.onEvent(type, data, { type, data, created: Date.now(), location: directory ? { directory } : undefined });
  }
}

export class FakePty implements PtyHandle {
  static count = 0;
  readonly id: string;
  readonly spawn: PtySpawn;
  onData: ((data: string) => void) | null = null;
  onExit: PtyHandle['onExit'] = null;
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  closed = false;
  constructor(spawn: PtySpawn) {
    this.id = `pty_${++FakePty.count}`;
    this.spawn = spawn;
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.onExit?.({ exitCode: null, reason: 'closed' });
  }
  emit(data: string) {
    this.onData?.(data);
  }
  exit(code: number) {
    this.onExit?.({ exitCode: code, reason: 'exited' });
  }
}

export const okLauncher: Launcher = {
  prepare: async () => ({ ok: true, command: '/usr/bin/opencode', shimNote: null, runnableHere: true }),
};

export interface Harness {
  app: App;
  term: FakeTerminal;
  service: FakeService;
  events: FakeEvents;
  store: Store;
  tracker: SessionTracker;
  ptys: FakePty[];
  logs: string[];
  dir: string;
  stateDir: string;
  deps: AppDeps;
  screen(): string[];
  text(): string;
  settle(ms?: number): Promise<void>;
  type(bytes: string, ms?: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  cols?: number;
  rows?: number;
  git?: Git;
  launcher?: Launcher;
  prs?: PrProvider;
  openPty?: (spawn: PtySpawn) => Promise<PtyHandle>;
  ensureService?: () => Promise<void>;
  setupState?: (store: Store, dir: string) => Promise<void>;
  deps?: Partial<AppDeps>;
  service?: FakeService;
  connect?: boolean;
}

export async function tempDir(prefix = 'neb-app-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const g = (args: string[]) => run('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  await g(['init', '-q', '-b', 'main']);
  await g(['config', 'user.email', 'test@example.invalid']);
  await g(['config', 'user.name', 'Test']);
  await g(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await g(['add', '.']);
  await g(['commit', '-q', '-m', 'init']);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await tempDir();
  const stateDir = path.join(dir, 'state');
  const git = opts.git ?? createGit();
  const store = new Store({ dir: stateDir, debounceMs: 5, detectKind: (p) => git.detectKind(p) });
  await store.load();
  if (opts.setupState) await opts.setupState(store, dir);
  const term = new FakeTerminal(opts.cols ?? 160, opts.rows ?? 40);
  const service = opts.service ?? new FakeService();
  const events = new FakeEvents();
  const logs: string[] = [];
  const tracker = new SessionTracker({ client: service, store, subscribe: events.subscribe, throttleMs: 1 });
  const ptys: FakePty[] = [];
  const deps: AppDeps = {
    terminal: term,
    store,
    git,
    tracker,
    client: service,
    prs: opts.prs ?? { available: async () => false, list: async () => [] },
    launcher: opts.launcher ?? okLauncher,
    openPty:
      opts.openPty ??
      (async (spawn) => {
        const p = new FakePty(spawn);
        ptys.push(p);
        return p;
      }),
    createEmulator: (c, r): Emulator => createEmulator(c, r),
    ensureService: opts.ensureService ?? (async () => {}),
    runChild: async () => ({ code: 0 }),
    openUrl: async () => {},
    fs: createNodeBrowserFs(),
    now: Date.now,
    pid: 4242,
    isAlive: () => false,
    platform: process.platform,
    homedir: dir,
    log: (l) => logs.push(l),
    redact: (t) => service.redact(t),
    resizeDebounceMs: 10,
    ...opts.deps,
  };
  const app = new App(deps);
  app.start();
  if (opts.connect !== false) events.connect();
  const h: Harness = {
    app, term, service, events, store, tracker, ptys, logs, dir, stateDir, deps,
    screen() {
      const f = app.draw();
      const out: string[] = [];
      for (let y = 0; y < f.rows; y++) out.push(f.rowText(y));
      return out;
    },
    text() {
      return h.screen().join('\n');
    },
    async settle(ms = 40) {
      await sleep(ms);
    },
    async type(bytes, ms = 40) {
      term.type(bytes);
      await sleep(ms);
    },
    async dispose() {
      if (!app.quitting) await app.shutdown(0);
      await rm(dir, { recursive: true, force: true });
    },
  };
  await h.settle(60);
  return h;
}

/** Wait until `cond` is true (polling), or fail after `ms`. */
export async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The open modal. A function call, so TypeScript does not narrow it between assertions. */
export function modal(h: { app: App }): Modal | null {
  return h.app.modal;
}

export function browserState(h: { app: App }) {
  const m = h.app.modal;
  return m?.kind === 'browser' ? m.state : null;
}

export function confirmState(h: { app: App }) {
  const m = h.app.modal;
  return m?.kind === 'confirm' ? m.state : null;
}
