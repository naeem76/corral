// The program's own state: one JSON file, `state.json`, in the state directory.
// Sessions stay in OpenCode; only per-session marks (seen, snoozed) are kept here.

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Project, SessionMarks } from '../types.ts';
import { samePath } from './paths.ts';

export interface UiState {
  view: string;
  selectedProjectId: string | null;
  selectedCheckoutPath: string | null;
  selectedSessionId: string | null;
  columnWidths?: number[];
  [key: string]: unknown;
}

/** The marks of one session (see `SessionMarks`), plus unknown keys from other versions. */
export interface SessionMeta extends SessionMarks {
  [key: string]: unknown;
}

export interface StateData {
  version: 1;
  projects: Project[];
  ui: UiState;
  sessions: Record<string, SessionMeta>;
  [key: string]: unknown;
}

export function defaultState(): StateData {
  return {
    version: 1,
    projects: [],
    ui: { view: 'main', selectedProjectId: null, selectedCheckoutPath: null, selectedSessionId: null },
    sessions: {},
  };
}

export interface StoreOptions {
  /** Directory that holds `state.json`. Created on the first save. */
  dir: string;
  debounceMs?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Detects 'git' or 'dir' for a new project. */
  detectKind?: (p: string) => Promise<'git' | 'dir'>;
  onError?: (err: Error) => void;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export class Store {
  readonly file: string;
  #dir: string;
  #data: StateData = defaultState();
  #debounceMs: number;
  #platform: NodeJS.Platform;
  #now: () => number;
  #detectKind: (p: string) => Promise<'git' | 'dir'>;
  #onError: (err: Error) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;
  #listeners = new Set<() => void>();
  /** Set when the last load found a corrupt file; holds the name it was moved to. */
  recoveredFrom: string | null = null;

  constructor(opts: StoreOptions) {
    this.#dir = opts.dir;
    this.file = path.join(opts.dir, 'state.json');
    this.#debounceMs = opts.debounceMs ?? 300;
    this.#platform = opts.platform ?? process.platform;
    this.#now = opts.now ?? Date.now;
    this.#detectKind = opts.detectKind ?? (async () => 'dir');
    this.#onError = opts.onError ?? (() => {});
  }

  get data(): Readonly<StateData> {
    return this.#data;
  }

  get projects(): readonly Project[] {
    return this.#data.projects;
  }

  get ui(): Readonly<UiState> {
    return this.#data.ui;
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#data = defaultState();
        return;
      }
      throw err;
    }
    const parsed = parseState(text);
    if (parsed) {
      this.#data = parsed;
      return;
    }
    const target = `${this.file}.corrupt-${this.#now()}`;
    try {
      await fsp.rename(this.file, target);
      this.recoveredFrom = target;
    } catch (err) {
      this.#onError(err as Error);
    }
    this.#data = defaultState();
  }

  // ---- projects ----------------------------------------------------------

  findProject(id: string): Project | undefined {
    return this.#data.projects.find((p) => p.id === id);
  }

  async addProject(dir: string, name?: string): Promise<Project> {
    const abs = path.resolve(dir);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new StoreError('ENOENT', `folder does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new StoreError('ENOTDIR', `not a folder: ${abs}`);
    if (this.#data.projects.some((p) => samePath(p.path, abs, this.#platform))) {
      throw new StoreError('EEXIST', `already in the list: ${abs}`);
    }
    const kind = await this.#detectKind(abs);
    // A second check: the list can change while detectKind runs.
    if (this.#data.projects.some((p) => samePath(p.path, abs, this.#platform))) {
      throw new StoreError('EEXIST', `already in the list: ${abs}`);
    }
    const project: Project = {
      id: randomUUID().slice(0, 8),
      path: abs,
      name: name?.trim() || path.basename(abs) || abs,
      kind,
    };
    this.#data.projects.push(project);
    this.#changed();
    return project;
  }

  removeProject(id: string): boolean {
    const i = this.#data.projects.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.#data.projects.splice(i, 1);
    if (this.#data.ui.selectedProjectId === id) this.#data.ui.selectedProjectId = null;
    this.#changed();
    return true;
  }

  renameProject(id: string, name: string): boolean {
    const p = this.findProject(id);
    const n = name.trim();
    if (!p || !n) return false;
    p.name = n;
    this.#changed();
    return true;
  }

  /** Move a project one place up (-1) or down (+1). False at the edge. */
  moveProject(id: string, delta: -1 | 1): boolean {
    const list = this.#data.projects;
    const i = list.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const a = list[i] as Project;
    list[i] = list[j] as Project;
    list[j] = a;
    this.#changed();
    return true;
  }

  /** Store a new kind after a check (a folder became a Git repository, or stopped being one). */
  setProjectKind(id: string, kind: 'git' | 'dir'): void {
    const p = this.findProject(id);
    if (!p || p.kind === kind) return;
    p.kind = kind;
    this.#changed();
  }

  // ---- ui and sessions ---------------------------------------------------

  setUi(patch: Partial<UiState>): void {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.#data.ui[k] !== v) {
        this.#data.ui[k] = v;
        changed = true;
      }
    }
    if (changed) this.#changed();
  }

  sessionMeta(id: string): Readonly<SessionMeta> | undefined {
    return this.#data.sessions[id];
  }

  setSessionMeta(id: string, patch: Partial<SessionMeta>): void {
    const cur = { ...(this.#data.sessions[id] ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    }
    if (Object.keys(cur).length === 0) delete this.#data.sessions[id];
    else this.#data.sessions[id] = cur;
    this.#changed();
  }

  forgetSession(id: string): void {
    if (!(id in this.#data.sessions)) return;
    delete this.#data.sessions[id];
    this.#changed();
  }

  // ---- saving ------------------------------------------------------------

  /** Mark the state as changed and save after the debounce delay. */
  #changed(): void {
    this.#dirty = true;
    for (const cb of this.#listeners) {
      try {
        cb();
      } catch {}
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((err) => this.#onError(err as Error));
    }, this.#debounceMs);
  }

  /** Write pending changes now. Call before exit. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Writes run one after another, so an older snapshot never replaces a newer one.
    const next = this.#writing.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      try {
        await this.#write(JSON.stringify(this.#data, null, 2) + '\n');
      } catch (err) {
        this.#dirty = true;
        throw err;
      }
    });
    this.#writing = next.catch(() => {});
    return next;
  }

  async #write(text: string): Promise<void> {
    await fsp.mkdir(this.#dir, { recursive: true });
    const tmp = path.join(this.#dir, `.state.json.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    await fsp.writeFile(tmp, text, 'utf8');
    // On Windows a rename can fail for a short time when another process (an antivirus,
    // an indexer) has the target open. Retry a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, this.file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
  }
}

/** Parse and repair a state file. Null when it is not usable. Unknown keys are kept. */
export function parseState(text: string): StateData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== undefined && r.version !== 1) return null;
  const base = defaultState();
  const projects: Project[] = [];
  if (Array.isArray(r.projects)) {
    for (const p of r.projects) {
      if (!p || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.path !== 'string') continue;
      projects.push({
        ...o,
        id: o.id,
        path: o.path,
        name: typeof o.name === 'string' && o.name ? o.name : path.basename(o.path),
        kind: o.kind === 'git' ? 'git' : 'dir',
      } as Project);
    }
  }
  const ui: UiState = { ...base.ui };
  if (r.ui && typeof r.ui === 'object' && !Array.isArray(r.ui)) Object.assign(ui, r.ui);
  const sessions: Record<string, SessionMeta> = {};
  if (r.sessions && typeof r.sessions === 'object' && !Array.isArray(r.sessions)) {
    for (const [k, v] of Object.entries(r.sessions as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) sessions[k] = { ...(v as SessionMeta) };
    }
  }
  return { ...r, version: 1, projects, ui, sessions };
}
