// GitHub Copilot CLI sessions, read from the files in the Copilot home (see AGENTS.md,
// "Copilot CLI: verified facts"). Copilot has no service and no event stream, so this source
// polls: a cheap stat of the files of the sessions in watched folders, and a slower listing
// of `session-state` for new and removed sessions. We never write Copilot's files and never
// read `session-store.db`.
//
// Status from the tail of `events.jsonl` (`copilotStatus`):
//   needs-input  a `*.requested` (permission, user input, elicitation, plan exit) without its
//                `*.completed`, and no later shutdown, abort or new start
//   working      the latest user prompt has no end yet: the last turn event is a turn start
//                (one prompt has several turn_start/turn_end pairs, with tools between them)
//   unseen       the last turn ended after our `lastSeen` mark
//   idle         otherwise
// A killed terminal leaves no `session.shutdown`, so a working or waiting state that did not
// change for a long time falls back to idle/unseen (`staleMs`, `longStaleMs`).

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentId, SessionCapabilities, SessionMarks, SessionRow, SessionSource, SessionStatus } from '../types.ts';
import type { CopilotLaunch } from './copilot-launch.ts';
import { pathKey, trimTrailingSep } from './paths.ts';

// ---------------------------------------------------------------------------
// workspace.yaml
// ---------------------------------------------------------------------------

/**
 * Parse the flat `key: value` lines of `workspace.yaml`. Values may be quoted with `"` or `'`.
 * Lines that are not of this form (nested YAML, comments, lists) are ignored. Never throws.
 */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || /^\s/.test(raw) || raw.startsWith('#') || raw.startsWith('-')) continue;
    const m = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else {
      // A plain scalar ends at " #" (a comment).
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trimEnd();
    }
    out[m[1] as string] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// events.jsonl
// ---------------------------------------------------------------------------

/** The parts of one event that the status needs. */
export interface CopilotEvent {
  type: string;
  /** Milliseconds since epoch; 0 when the line has no valid time. */
  at: number;
  requestId?: string;
}

const REQUEST_KINDS = new Set(['permission', 'user_input', 'elicitation', 'exit_plan_mode']);
/** A new process or the end of one: every open question of the old one is gone. */
const RESET = new Set(['session.shutdown', 'abort', 'session.start', 'session.resume']);
/** Events that decide whether the latest prompt is still in progress. */
const TURN = new Set(['assistant.turn_start', 'assistant.turn_end', 'abort', 'session.error', 'session.shutdown', 'session.start', 'session.resume']);

/** Parse JSONL text. `partialFirst`: the text starts inside a line, so its first line is dropped. */
export function parseEventLines(text: string, partialFirst: boolean): CopilotEvent[] {
  const lines = text.split('\n');
  if (partialFirst) lines.shift();
  const out: CopilotEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let j: { type?: unknown; timestamp?: unknown; data?: { requestId?: unknown } };
    try {
      j = JSON.parse(line);
    } catch {
      continue; // a line in the middle of a write
    }
    if (!j || typeof j.type !== 'string') continue;
    const at = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
    const e: CopilotEvent = { type: j.type, at: Number.isFinite(at) ? at : 0 };
    const rid = j.data && typeof j.data === 'object' ? j.data.requestId : undefined;
    if (typeof rid === 'string') e.requestId = rid;
    out.push(e);
  }
  return out;
}

/** What the status rules need from an event list; computed once per file change. */
export interface EventSummary {
  /** Number of questions that wait for the user. */
  pending: number;
  /** The latest prompt is in progress (before the stale guard). */
  inTurn: boolean;
  /** End of the last turn (turn end, abort or error after the latest prompt); 0 when none. */
  turnEnd: number;
  /** Time of the latest user prompt; 0 when not in the events read. */
  prompt: number;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  lastType: string;
  lastAt: number;
}

export function summarizeEvents(events: readonly CopilotEvent[]): EventSummary {
  const pending = new Map<string, CopilotEvent>();
  let anchor = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as CopilotEvent;
    const dot = e.type.lastIndexOf('.');
    const kind = dot > 0 ? e.type.slice(0, dot) : '';
    const verb = dot > 0 ? e.type.slice(dot + 1) : '';
    if (REQUEST_KINDS.has(kind) && e.requestId) {
      if (verb === 'requested') pending.set(e.requestId, e);
      else if (verb === 'completed') pending.delete(e.requestId);
    } else if (RESET.has(e.type)) pending.clear();
    if (e.type === 'user.message') anchor = i;
  }
  // The last event that decides the turn state, after the latest prompt.
  let decider: CopilotEvent | null = null;
  let ending: CopilotEvent | null = null;
  for (let i = anchor + 1; i < events.length; i++) {
    const e = events[i] as CopilotEvent;
    if (TURN.has(e.type)) decider = e;
    if (e.type === 'assistant.turn_start' || e.type === 'assistant.turn_end' || e.type === 'abort' || e.type === 'session.error') ending = e;
  }
  // No turn event after a prompt: it was just sent. No prompt and no turn event: nothing runs.
  const inTurn = decider ? decider.type === 'assistant.turn_start' : anchor >= 0;
  const last = events[events.length - 1];
  const s: EventSummary = {
    pending: pending.size,
    inTurn,
    turnEnd: !inTurn && ending && ending.type !== 'assistant.turn_start' ? ending.at : 0,
    prompt: anchor >= 0 ? (events[anchor] as CopilotEvent).at : 0,
    lastType: last?.type ?? '',
    lastAt: last?.at ?? 0,
  };
  if (!inTurn && ending) {
    if (ending.type === 'assistant.turn_end') s.outcome = 'succeeded';
    else if (ending.type === 'abort') s.outcome = 'interrupted';
    else if (ending.type === 'session.error') s.outcome = 'failed';
  }
  return s;
}

export interface StatusOptions {
  now: number;
  /** Our "seen" mark: the user looked at the session at this time. */
  lastSeen?: number;
  /** Last change of `events.jsonl` (its mtime). Default: the time of the last event. */
  changedAt?: number;
  /** A working session without a change for this long is taken as gone. Default 30 min. */
  staleMs?: number;
  /** The same for a running tool or a waiting question, which can take long. Default 4 h. */
  longStaleMs?: number;
}

export interface CopilotStatus {
  status: SessionStatus;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  /** Start or end of the last turn; 0 when unknown. */
  activity: number;
}

export const DEFAULT_STALE_MS = 30 * 60_000;
export const DEFAULT_LONG_STALE_MS = 4 * 60 * 60_000;

/** The status rules (see the top of this file). Pure. */
export function statusFromSummary(s: EventSummary, o: StatusOptions): CopilotStatus {
  const long = s.pending > 0 || s.lastType === 'tool.execution_start';
  const limit = long ? (o.longStaleMs ?? DEFAULT_LONG_STALE_MS) : (o.staleMs ?? DEFAULT_STALE_MS);
  const changed = Math.max(o.changedAt ?? 0, s.lastAt);
  const stale = changed > 0 && o.now - changed > limit;
  const activity = Math.max(s.prompt, s.turnEnd);
  const out: CopilotStatus = { status: 'idle', activity };
  if (s.outcome) out.outcome = s.outcome;
  if (!stale && s.pending > 0) out.status = 'needs-input';
  else if (!stale && s.inTurn) out.status = 'working';
  else if (s.turnEnd > 0 && s.turnEnd > (o.lastSeen ?? 0)) out.status = 'unseen';
  if (out.status === 'working' || out.status === 'needs-input') delete out.outcome;
  return out;
}

export function copilotStatus(events: readonly CopilotEvent[], o: StatusOptions): CopilotStatus {
  return statusFromSummary(summarizeEvents(events), o);
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

export interface FileStat {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
}

/** The file system calls of the source. Tests count or replace them. */
export interface CopilotFs {
  readdir(dir: string): Promise<string[]>;
  /** Null when the path does not exist. */
  stat(p: string): Promise<FileStat | null>;
  readFile(p: string): Promise<string>;
  /** `length` bytes from `position`, as UTF-8 text. */
  readRange(p: string, position: number, length: number): Promise<string>;
}

export const nodeCopilotFs: CopilotFs = {
  readdir: (dir) => fsp.readdir(dir),
  async stat(p) {
    try {
      const s = await fsp.stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  },
  readFile: (p) => fsp.readFile(p, 'utf8'),
  async readRange(p, position, length) {
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  },
};

export const TAIL_SMALL = 64 * 1024;
export const TAIL_LARGE = 512 * 1024;

/**
 * The events at the end of `events.jsonl`, never the whole file (it grows by tens of KB per
 * prompt). The last 64 KB first; when no prompt and no session start is in them, one larger
 * window of 512 KB.
 */
export async function readEventsTail(
  fs: CopilotFs,
  file: string,
  size: number,
  windows: { small?: number; large?: number } = {},
): Promise<CopilotEvent[]> {
  const small = windows.small ?? TAIL_SMALL;
  const large = windows.large ?? TAIL_LARGE;
  const read = async (n: number) => {
    const start = Math.max(0, size - n);
    return parseEventLines(await fs.readRange(file, start, size - start), start > 0);
  };
  const first = await read(small);
  if (size <= small || first.some((e) => e.type === 'user.message' || e.type === 'session.start')) return first;
  return read(large);
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export interface CopilotMetaStore {
  sessionMeta(id: string): Readonly<SessionMarks> | undefined;
  setSessionMeta(id: string, patch: Partial<SessionMarks>): void;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface CopilotSourceOptions {
  /** The Copilot home (`copilotHome()` in paths.ts). */
  home: string;
  store?: CopilotMetaStore;
  /** How to start `copilot`. Only `ok` is used here (for `available`). */
  launch?: () => CopilotLaunch;
  fs?: CopilotFs;
  now?: () => number;
  timers?: Timers;
  platform?: NodeJS.Platform;
  /** Stat interval of the files of watched sessions. Default 2 s. */
  pollMs?: number;
  /** Listing interval of `session-state`. Default 5 s. */
  scanMs?: number;
  staleMs?: number;
  longStaleMs?: number;
  /** A new session that was never opened is dropped after this long. Default 10 min. */
  pendingMs?: number;
  /**
   * Turns that ended before this time count as seen. Copilot has no "viewed" mark, so without
   * it every old session would be "unseen" on the first start.
   */
  seenSince?: () => number;
  /** Tail windows (tests use small ones). */
  tailSmall?: number;
  tailLarge?: number;
  onError?: (err: Error) => void;
}

interface Stamp {
  mtimeMs: number;
  size: number;
}

interface Entry {
  id: string;
  folder: string;
  ws: Stamp | null;
  cwd: string | null;
  title: string;
  created: number;
  updated: number;
  ev: Stamp | null;
  summary: EventSummary | null;
}

interface Pending {
  directory: string;
  created: number;
  opened: boolean;
}

const RANK: Record<SessionStatus, number> = { 'needs-input': 0, working: 1, unseen: 2, idle: 3 };
const CAPABILITIES: SessionCapabilities = { rename: false, remove: false, archive: 'local' };
const sameStamp = (a: Stamp | null, b: Stamp | null) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

export class CopilotSource implements SessionSource {
  readonly agent: AgentId = 'copilot';
  readonly home: string;
  readonly stateDir: string;
  #store: CopilotMetaStore | undefined;
  #launch: () => CopilotLaunch;
  #fs: CopilotFs;
  #now: () => number;
  #timers: Timers;
  #platform: NodeJS.Platform;
  #o: CopilotSourceOptions;
  #onError: (err: Error) => void;

  #dirs = new Map<string, string>();
  #entries = new Map<string, Entry>();
  #pending = new Map<string, Pending>();
  #homeExists: boolean | null = null;
  #launchCache: { at: number; value: CopilotLaunch } | null = null;
  #listeners = new Set<() => void>();
  #pollTimer: unknown = null;
  #scanTimer: unknown = null;
  #chain: Promise<void> = Promise.resolve();
  #sig = '';
  #notifyQueued = false;
  #disposed = false;
  /** File reads (not stats) since the start; tests check the caches with it. */
  reads = 0;

  constructor(o: CopilotSourceOptions) {
    this.#o = o;
    this.home = o.home;
    this.#platform = o.platform ?? process.platform;
    const p = this.#platform === 'win32' ? path.win32 : path.posix;
    this.stateDir = p.join(o.home, 'session-state');
    this.#store = o.store;
    this.#launch = o.launch ?? (() => ({ ok: false, reason: 'copilot: no launcher configured' }));
    this.#fs = o.fs ?? nodeCopilotFs;
    this.#now = o.now ?? Date.now;
    this.#timers = o.timers ?? realTimers;
    this.#onError = o.onError ?? (() => {});
  }

  // ---- availability --------------------------------------------------------

  /** How to start `copilot` now (cached for 30 s: it stats files on PATH). */
  launch(): CopilotLaunch {
    const now = this.#now();
    if (!this.#launchCache || now - this.#launchCache.at > 30_000) this.#launchCache = { at: now, value: this.#launch() };
    return this.#launchCache.value;
  }

  /** The `copilot` program can be started. */
  get programFound(): boolean {
    return this.launch().ok;
  }

  /** `session-state` existed at the last look (null before the first look). */
  get homeExists(): boolean | null {
    return this.#homeExists;
  }

  get available(): boolean {
    return this.programFound || this.#homeExists === true;
  }

  get unavailableReason(): string | null {
    if (this.available) return null;
    const l = this.launch();
    return `${l.ok ? 'copilot found' : l.reason}; no Copilot sessions at ${this.stateDir}`;
  }

  capabilities(_agent: AgentId = 'copilot'): SessionCapabilities {
    return CAPABILITIES;
  }

  // ---- reading -------------------------------------------------------------

  /** Rows of a watched folder (other folders: none, their events are not read). */
  rows(directory: string): SessionRow[] {
    const key = this.#key(directory);
    const out: SessionRow[] = [];
    if (!this.#dirs.has(key)) return out;
    for (const e of this.#entries.values()) if (e.cwd !== null && this.#key(e.cwd) === key) out.push(this.#row(e));
    for (const [id, p] of this.#pending) if (!this.#entries.get(id)?.cwd && this.#key(p.directory) === key) out.push(this.#pendingRow(id, p));
    out.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updated - a.updated || (a.id < b.id ? -1 : 1));
    return out;
  }

  row(id: string): SessionRow | undefined {
    const e = this.#entries.get(id);
    if (e?.cwd) return this.#row(e);
    const p = this.#pending.get(id);
    return p ? this.#pendingRow(id, p) : undefined;
  }

  status(id: string): SessionStatus {
    return this.row(id)?.status ?? 'idle';
  }

  activity(id: string): number {
    const e = this.#entries.get(id);
    return e?.summary ? this.#status(e).activity : 0;
  }

  /** True while the id is a new session whose folder Copilot has not made yet. */
  isPending(id: string): boolean {
    return this.#pending.has(id) && !this.#entries.get(id)?.cwd;
  }

  #status(e: Entry): CopilotStatus {
    if (!e.summary) return { status: 'idle', activity: 0 };
    const marks = this.#store?.sessionMeta(e.id);
    const seen = Math.max(marks?.lastSeen ?? 0, this.#o.seenSince?.() ?? 0);
    return statusFromSummary(e.summary, {
      now: this.#now(),
      lastSeen: seen,
      changedAt: e.ev?.mtimeMs,
      staleMs: this.#o.staleMs,
      longStaleMs: this.#o.longStaleMs,
    });
  }

  #row(e: Entry): SessionRow {
    const st = this.#status(e);
    const row: SessionRow = {
      id: e.id,
      agent: 'copilot',
      title: e.title,
      directory: e.cwd as string,
      created: e.created,
      updated: Math.max(e.updated, e.ev?.mtimeMs ?? 0),
      status: st.status,
      archived: this.#store?.sessionMeta(e.id)?.archivedAt !== undefined,
    };
    if (st.outcome) row.outcome = st.outcome;
    return row;
  }

  #pendingRow(id: string, p: Pending): SessionRow {
    return {
      id,
      agent: 'copilot',
      title: 'New Copilot session',
      directory: p.directory,
      created: p.created,
      updated: p.created,
      status: 'idle',
      archived: false,
    };
  }

  // ---- actions -------------------------------------------------------------

  markSeen(id: string): void {
    if (!this.#entries.has(id) && !this.#pending.has(id)) return;
    this.#store?.setSessionMeta(id, { lastSeen: this.#now() });
    this.#changed();
  }

  /**
   * Nothing is written: `copilot --session-id <id>` makes the session when it starts. Until
   * its folder appears, the source shows a pending row, so the UI can select and open it.
   */
  async create(directory: string, _title?: string): Promise<string> {
    const id = randomUUID();
    this.#pending.set(id, { directory: trimTrailingSep(directory, this.#platform), created: this.#now(), opened: false });
    this.#changed();
    return id;
  }

  /** The session runs now (a pane or the full window): keep its pending row. */
  opened(id: string): void {
    const p = this.#pending.get(id);
    if (p) p.opened = true;
  }

  /** The program of the session ended: read the files again; drop a pending row without a folder. */
  async closed(id: string): Promise<void> {
    await this.refresh();
    if (this.#pending.has(id) && !this.#entries.get(id)?.cwd) {
      this.#pending.delete(id);
      this.#changed();
    }
  }

  rename(_id: string, _title: string): Promise<void> {
    return Promise.reject(new Error('Copilot sessions cannot be renamed here. Rename it in Copilot with /rename.'));
  }

  remove(_id: string): Promise<void> {
    return Promise.reject(new Error('Copilot sessions cannot be deleted here. Delete it in Copilot with /session delete.'));
  }

  async archive(id: string): Promise<void> {
    if (!this.#entries.has(id) && !this.#pending.has(id)) throw new Error(`unknown Copilot session: ${id}`);
    if (this.#store?.sessionMeta(id)?.archivedAt === undefined) this.#store?.setSessionMeta(id, { archivedAt: this.#now() });
    this.#changed();
  }

  async unarchive(id: string): Promise<void> {
    if (!this.#entries.has(id) && !this.#pending.has(id)) throw new Error(`unknown Copilot session: ${id}`);
    this.#store?.setSessionMeta(id, { archivedAt: undefined });
    this.#changed();
  }

  // ---- watching ------------------------------------------------------------

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  watch(directories: readonly string[]): Promise<void> {
    const next = new Map<string, string>();
    for (const d of directories) next.set(this.#key(d), trimTrailingSep(d, this.#platform));
    const added = [...next.keys()].some((k) => !this.#dirs.has(k));
    const removed = [...this.#dirs.keys()].some((k) => !next.has(k));
    this.#dirs = next;
    this.#timersFor(next.size > 0);
    if (removed) this.#changed();
    return added ? this.refresh() : Promise.resolve();
  }

  /** List `session-state` and read the changed files of watched sessions. */
  refresh(_directories?: readonly string[]): Promise<void> {
    return this.#serial(async () => {
      await this.#scan();
      await this.#poll();
    });
  }

  /** One poll tick (tests call it through the fake timers). */
  poll(): Promise<void> {
    return this.#serial(() => this.#poll());
  }

  scan(): Promise<void> {
    return this.#serial(() => this.#scan());
  }

  dispose(): void {
    this.#disposed = true;
    this.#timersFor(false);
    this.#listeners.clear();
  }

  #timersFor(on: boolean): void {
    if (on && !this.#disposed) {
      this.#pollTimer ??= this.#timers.setInterval(() => void this.poll(), this.#o.pollMs ?? 2000);
      this.#scanTimer ??= this.#timers.setInterval(() => void this.scan(), this.#o.scanMs ?? 5000);
      return;
    }
    if (this.#pollTimer !== null) this.#timers.clearInterval(this.#pollTimer);
    if (this.#scanTimer !== null) this.#timers.clearInterval(this.#scanTimer);
    this.#pollTimer = null;
    this.#scanTimer = null;
  }

  /** One file pass at a time: a slow network drive must not pile up passes. */
  #serial(fn: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#disposed) return;
      try {
        await fn();
      } catch (err) {
        this.#onError(err as Error);
      }
      this.#check();
    });
    this.#chain = run;
    return run;
  }

  async #scan(): Promise<void> {
    if (this.#dirs.size === 0 && this.#homeExists !== null) return;
    const st = await this.#fs.stat(this.stateDir).catch((err) => (this.#onError(err as Error), null));
    this.#homeExists = !!st?.isDirectory;
    if (!this.#homeExists) {
      if (this.#entries.size) this.#entries.clear();
      return;
    }
    if (this.#dirs.size === 0) return;
    const names = (await this.#fs.readdir(this.stateDir)).filter((n) => !n.startsWith('.'));
    const present = new Set(names);
    for (const id of [...this.#entries.keys()]) if (!present.has(id)) this.#entries.delete(id);
    // New sessions, and sessions whose workspace.yaml was not complete at the last look.
    const todo = names.filter((n) => !this.#entries.get(n)?.cwd);
    await mapLimit(todo, 16, (id) => this.#readWorkspace(id));
    for (const id of [...this.#pending.keys()]) if (this.#entries.get(id)?.cwd) this.#pending.delete(id);
  }

  async #poll(): Promise<void> {
    const now = this.#now();
    for (const [id, p] of this.#pending) {
      if (!p.opened && now - p.created > (this.#o.pendingMs ?? 10 * 60_000)) this.#pending.delete(id);
    }
    if (this.#dirs.size === 0 || !this.#homeExists) return;
    const watched = [...this.#entries.values()].filter((e) => e.cwd !== null && this.#dirs.has(this.#key(e.cwd)));
    await mapLimit(watched, 16, async (e) => {
      await this.#readWorkspace(e.id);
      await this.#readEvents(e);
    });
  }

  async #readWorkspace(id: string): Promise<void> {
    const p = this.#platform === 'win32' ? path.win32 : path.posix;
    const folder = p.join(this.stateDir, id);
    const file = p.join(folder, 'workspace.yaml');
    let st: FileStat | null;
    try {
      st = await this.#fs.stat(file);
    } catch (err) {
      this.#onError(err as Error);
      return;
    }
    const prev = this.#entries.get(id);
    if (!st) {
      // The folder is there, the file not yet: a session that is starting.
      if (!prev) this.#entries.set(id, { id, folder, ws: null, cwd: null, title: '', created: 0, updated: 0, ev: null, summary: null });
      return;
    }
    const stamp = { mtimeMs: st.mtimeMs, size: st.size };
    if (prev && sameStamp(prev.ws, stamp)) return;
    let text: string;
    try {
      this.reads++;
      text = await this.#fs.readFile(file);
    } catch (err) {
      this.#onError(err as Error);
      return;
    }
    const y = parseWorkspaceYaml(text);
    const time = (v: string | undefined) => {
      const t = v ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : st.mtimeMs;
    };
    this.#entries.set(id, {
      id,
      folder,
      ws: stamp,
      cwd: y.cwd ? y.cwd : null,
      title: y.name ?? '',
      created: time(y.created_at),
      updated: time(y.updated_at),
      ev: prev?.ev ?? null,
      summary: prev?.summary ?? null,
    });
  }

  async #readEvents(e0: Entry): Promise<void> {
    const p = this.#platform === 'win32' ? path.win32 : path.posix;
    const file = p.join(e0.folder, 'events.jsonl');
    const e = this.#entries.get(e0.id) ?? e0;
    try {
      const st = await this.#fs.stat(file);
      if (!st) {
        e.ev = null;
        e.summary = null;
        return;
      }
      const stamp = { mtimeMs: st.mtimeMs, size: st.size };
      if (sameStamp(e.ev, stamp)) return;
      this.reads++;
      const events = await readEventsTail(this.#fs, file, st.size, { small: this.#o.tailSmall, large: this.#o.tailLarge });
      e.ev = stamp;
      e.summary = summarizeEvents(events);
    } catch (err) {
      this.#onError(err as Error);
    }
  }

  // ---- change notification -------------------------------------------------

  /** Call the listeners when a row of a watched folder changed since the last check. */
  #check(): void {
    const parts: string[] = [];
    for (const d of this.#dirs.values()) {
      for (const r of this.rows(d)) parts.push(`${r.id}|${r.status}|${r.title}|${r.updated}|${r.archived}|${r.outcome ?? ''}|${r.directory}`);
    }
    parts.push(`home:${this.#homeExists}`);
    const sig = parts.join('\n');
    if (sig === this.#sig) return;
    this.#sig = sig;
    this.#emit();
  }

  #changed(): void {
    this.#sig = '';
    this.#check();
  }

  #emit(): void {
    if (this.#notifyQueued || this.#disposed) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const cb of this.#listeners) {
        try {
          cb();
        } catch (err) {
          this.#onError(err as Error);
        }
      }
    });
  }

  #key(dir: string): string {
    return pathKey(dir, this.#platform);
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
