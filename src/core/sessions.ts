// Live session rows per directory, with a status for each top-level session.
//
// Status mapping (OpenCode 2.3.2):
//   needs-input  a pending permission request (`GET /api/permission/request`, events
//                `permission.asked` / `permission.replied`) or a pending form (`GET /api/form`,
//                `form.created` / `form.replied` / `form.cancelled`) of the session or of any
//                child session (`parentID`); a child's request marks its root.
//   working      the session or a child is in `GET /api/session/active`, or had
//                `session.execution.started` / `session.status {busy|retry}` without a later
//                `session.execution.{succeeded,failed,interrupted}` / `session.idle` /
//                `session.status {idle}`.
//   unseen       `time.idle` (end of the last execution) is later than both `time.viewed`
//                (OpenCode's own mark, set by any client through `session.view`) and our
//                `lastSeen` in the store.
//   idle         otherwise.
// The full state is read again after every event-stream (re)connect, because events
// during a disconnect are lost.

import type { AgentId, SessionCapabilities, SessionRow, SessionSource, SessionStatus } from '../types.ts';
import { locationQuery, type OpenCodeApi } from './opencode.ts';
import { subscribeEvents, type OcEvent, type Subscription } from './events.ts';
import { pathKey, trimTrailingSep } from './paths.ts';

/** Fields of `Session.Info` that the tracker uses. */
export interface SessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; busy?: number; idle?: number; viewed?: number; archived?: number };
  location: { directory: string };
}

export interface SessionMetaStore {
  sessionMeta(id: string): { lastSeen?: number } | undefined;
  setSessionMeta(id: string, patch: { lastSeen?: number }): void;
}

export interface EventHandlers {
  onEvent: (type: string, data: any, event: OcEvent) => void;
  onConnect: () => void;
  onDisconnect: (reason: string) => void;
  onError: (err: Error) => void;
}

export type EventSubscriber = (types: readonly string[], handlers: EventHandlers) => Subscription;

export interface TrackerOptions {
  client: OpenCodeApi;
  store?: SessionMetaStore;
  /** Default: `subscribeEvents` on the client. Replaced in tests. */
  subscribe?: EventSubscriber;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Minimum time between two `onChange` calls. */
  throttleMs?: number;
  /** Sessions read per directory (newest first). */
  listLimit?: number;
  /** Directories read at the same time in a refresh (each one is three requests). Default 8. */
  concurrency?: number;
  onError?: (err: Error) => void;
}

/** Event types the tracker needs. Text deltas and other frequent events stay out. */
export const TRACKED_EVENTS = [
  'session.created',
  'session.renamed',
  'session.archived',
  'session.unarchived',
  'session.deleted',
  'session.moved',
  'session.viewed',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
] as const;

const RANK: Record<SessionStatus, number> = { 'needs-input': 0, working: 1, unseen: 2, idle: 3 };

interface Pending {
  sessionID: string;
  dir: string | null;
}

const CAPABILITIES: SessionCapabilities = { rename: true, remove: true, archive: 'agent' };

/** The OpenCode `SessionSource`. */
export class SessionTracker implements SessionSource {
  readonly agent: AgentId = 'opencode';
  #client: OpenCodeApi;
  #store: SessionMetaStore | undefined;
  #platform: NodeJS.Platform;
  #now: () => number;
  #throttleMs: number;
  #limit: number;
  #concurrency: number;
  #onError: (err: Error) => void;

  /** Watched directories: key -> directory as given (trailing separator removed). */
  #dirs = new Map<string, string>();
  #sessions = new Map<string, SessionInfo>();
  #active = new Set<string>();
  #running = new Set<string>();
  #perms = new Map<string, Pending>();
  #forms = new Map<string, Pending>();

  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #refreshing = 0;
  #buffer: Array<[string, any, OcEvent]> = [];
  #sub: Subscription | null = null;
  #disposed = false;
  #connected = false;

  constructor(opts: TrackerOptions) {
    this.#client = opts.client;
    this.#store = opts.store;
    this.#platform = opts.platform ?? process.platform;
    this.#now = opts.now ?? Date.now;
    this.#throttleMs = opts.throttleMs ?? 50;
    this.#limit = opts.listLimit ?? 500;
    this.#concurrency = Math.max(1, opts.concurrency ?? 8);
    this.#onError = opts.onError ?? (() => {});
    const subscribe: EventSubscriber =
      opts.subscribe ?? ((types, h) => subscribeEvents(this.#client, { types, ...h }));
    this.#sub = subscribe(TRACKED_EVENTS, {
      onEvent: (type, data, ev) => this.#onEvent(type, data, ev),
      onConnect: () => {
        this.#connected = true;
        void this.refresh();
      },
      onDisconnect: () => {
        this.#connected = false;
        this.#notify();
      },
      onError: (err) => this.#onError(err),
    });
  }

  /** True while the event stream is connected. */
  get connected(): boolean {
    return this.#connected;
  }

  /** OpenCode sessions can be used only through the service. */
  get available(): boolean {
    return this.#connected;
  }

  get unavailableReason(): string | null {
    return this.#connected ? null : 'the OpenCode service is not connected';
  }

  capabilities(_agent: AgentId = 'opencode'): SessionCapabilities {
    return CAPABILITIES;
  }

  /** One row by id (child sessions too). */
  row(id: string): SessionRow | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#row(s) : undefined;
  }

  /** Start or end of the last execution (`max(time.busy, time.idle)`); 0 when unknown. */
  activity(id: string): number {
    const t = this.#sessions.get(id)?.time;
    return Math.max(t?.busy ?? 0, t?.idle ?? 0);
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Set the directories to follow. New ones are read at once; dropped ones are forgotten. */
  watch(directories: readonly string[]): Promise<void> {
    const next = new Map<string, string>();
    for (const d of directories) next.set(this.#key(d), trimTrailingSep(d, this.#platform));
    const added: string[] = [];
    for (const [k, d] of next) if (!this.#dirs.has(k)) added.push(d);
    let removed = false;
    for (const k of this.#dirs.keys()) {
      if (next.has(k)) continue;
      removed = true;
      this.#dropDir(k);
    }
    this.#dirs = next;
    if (removed) this.#notify();
    return added.length ? this.refresh(added) : Promise.resolve();
  }

  /** Top-level sessions of a directory, sorted by attention, then by `updated` (newest first). */
  rows(directory: string): SessionRow[] {
    const key = this.#key(directory);
    const out: SessionRow[] = [];
    for (const s of this.#sessions.values()) {
      if (s.parentID) continue;
      if (this.#key(s.location.directory) !== key) continue;
      out.push(this.#row(s));
    }
    out.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updated - a.updated || (a.id < b.id ? -1 : 1));
    return out;
  }

  /** Status of one session (the root of a child session). */
  status(id: string): SessionStatus {
    const s = this.#sessions.get(id);
    return s ? this.#status(this.#rootOf(id)) : 'idle';
  }

  get(id: string): SessionInfo | undefined {
    return this.#sessions.get(id);
  }

  /** The user looked at the session now. */
  markSeen(id: string): void {
    const now = this.#now();
    this.#store?.setSessionMeta(id, { lastSeen: now });
    const s = this.#sessions.get(id);
    if (s?.time.idle !== undefined && (s.time.viewed ?? 0) < s.time.idle) {
      const idle = s.time.idle;
      s.time.viewed = idle;
      // Tell OpenCode too, so its other clients agree. Failure is harmless.
      this.#client
        .request('POST', `/api/session/${encodeURIComponent(id)}/view`, { body: { idle } })
        .catch((err) => this.#onError(err as Error));
    }
    this.#notify();
  }

  async create(directory: string, title?: string): Promise<string> {
    const dir = trimTrailingSep(directory, this.#platform);
    const body: Record<string, unknown> = { location: { directory: dir } };
    if (title) body.title = title;
    const r = await this.#client.request<{ data: SessionInfo }>('POST', '/api/session', { body });
    const info = r.data;
    if (this.#dirs.has(this.#key(info.location?.directory ?? dir))) {
      this.#sessions.set(info.id, normalizeInfo(info));
      this.#notify();
    }
    return info.id;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.#client.request('PATCH', `/api/session/${encodeURIComponent(id)}`, { body: { title } });
    const s = this.#sessions.get(id);
    if (s) {
      s.title = title;
      this.#notify();
    }
  }

  async archive(id: string): Promise<void> {
    await this.#client.request('PATCH', `/api/session/${encodeURIComponent(id)}`, { body: { archived: true } });
    const s = this.#sessions.get(id);
    if (s && s.time.archived === undefined) {
      s.time.archived = this.#now();
      this.#notify();
    }
  }

  async unarchive(id: string): Promise<void> {
    await this.#client.request('PATCH', `/api/session/${encodeURIComponent(id)}`, { body: { archived: false } });
    const s = this.#sessions.get(id);
    if (s && s.time.archived !== undefined) {
      delete s.time.archived;
      this.#notify();
    }
  }

  /** Delete the session and its child sessions in OpenCode. */
  async remove(id: string): Promise<void> {
    await this.#client.request('DELETE', `/api/session/${encodeURIComponent(id)}`);
    this.#forget(id);
    this.#notify();
  }

  dispose(): void {
    this.#disposed = true;
    this.#sub?.close();
    this.#sub = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  /** Read the full state of the given directories (default: all watched) again. */
  async refresh(directories?: readonly string[]): Promise<void> {
    if (this.#disposed) return;
    const dirs = directories ? [...directories] : [...this.#dirs.values()];
    if (dirs.length === 0) return;
    this.#refreshing++;
    try {
      const [active, perDir] = await Promise.all([
        this.#client.request<{ data: Record<string, unknown> }>('GET', '/api/session/active').then(
          (r) => r,
          (err) => {
            this.#onError(err as Error);
            return null;
          },
        ),
        // Many projects with worktrees would otherwise send hundreds of requests at once.
        mapLimit(dirs, this.#concurrency, (d) => this.#readDir(d)),
      ]);
      if (this.#disposed) return;
      if (active) {
        this.#active = new Set(Object.keys(active.data ?? {}));
        // `active` is the truth now; events about older executions may have been lost.
        this.#running.clear();
      }
      for (const r of perDir) {
        if (!r || !this.#dirs.has(r.key)) continue;
        this.#dropDir(r.key);
        for (const s of r.sessions) this.#sessions.set(s.id, s);
        for (const p of r.perms) this.#perms.set(p.id, { sessionID: p.sessionID, dir: r.key });
        for (const f of r.forms) this.#forms.set(f.id, { sessionID: f.sessionID, dir: r.key });
      }
      // Apply again the events that came while the snapshot was in transit.
      for (const [type, data, ev] of this.#buffer) this.#apply(type, data, ev);
    } finally {
      this.#refreshing--;
      if (this.#refreshing === 0) this.#buffer = [];
    }
    this.#notify();
  }

  async #readDir(dir: string): Promise<{
    key: string;
    sessions: SessionInfo[];
    perms: Array<{ id: string; sessionID: string }>;
    forms: Array<{ id: string; sessionID: string }>;
  } | null> {
    try {
      const [list, perms, forms] = await Promise.all([
        this.#client.request<{ data: SessionInfo[] }>('GET', '/api/session', {
          query: { directory: dir, limit: String(this.#limit), order: 'desc' },
        }),
        this.#client.request<{ data: Array<{ id: string; sessionID: string }> }>('GET', '/api/permission/request', {
          query: locationQuery(dir),
        }),
        this.#client.request<{ data: Array<{ id: string; sessionID: string }> }>('GET', '/api/form', {
          query: locationQuery(dir),
        }),
      ]);
      return {
        key: this.#key(dir),
        sessions: (list.data ?? []).map(normalizeInfo),
        perms: perms.data ?? [],
        forms: forms.data ?? [],
      };
    } catch (err) {
      this.#onError(err as Error);
      return null;
    }
  }

  #onEvent(type: string, data: any, ev: OcEvent): void {
    if (this.#disposed) return;
    if (this.#refreshing > 0) this.#buffer.push([type, data, ev]);
    if (this.#apply(type, data, ev)) this.#notify();
  }

  /** Apply one event. Returns true when something visible may have changed. */
  #apply(type: string, data: any, ev: OcEvent): boolean {
    if (!data || typeof data !== 'object') return false;
    const at = typeof ev.created === 'number' ? ev.created : this.#now();
    const sid: string | undefined = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    const s = sid ? this.#sessions.get(sid) : undefined;
    switch (type) {
      case 'session.created': {
        const dir = data.location?.directory ?? ev.location?.directory;
        if (!sid || typeof dir !== 'string' || !this.#dirs.has(this.#key(dir))) return false;
        if (s) return false;
        this.#sessions.set(sid, {
          id: sid,
          parentID: data.parentID,
          title: data.title,
          time: { created: at, updated: at },
          location: { directory: dir },
        });
        return true;
      }
      case 'session.moved': {
        const dir = data.location?.directory;
        if (!sid || typeof dir !== 'string') return false;
        if (s) {
          if (this.#dirs.has(this.#key(dir))) s.location = { directory: dir };
          else this.#forget(sid);
          return true;
        }
        if (this.#dirs.has(this.#key(dir))) void this.refresh([this.#dirs.get(this.#key(dir)) as string]);
        return false;
      }
      case 'session.renamed':
        if (!s || typeof data.title !== 'string') return false;
        s.title = data.title;
        return true;
      case 'session.archived':
        if (!s) return false;
        s.time.archived = at;
        return true;
      case 'session.unarchived':
        if (!s) return false;
        delete s.time.archived;
        return true;
      case 'session.deleted':
        if (!sid || !s) return false;
        this.#forget(sid);
        return true;
      case 'session.viewed':
        if (!s || typeof data.idle !== 'number') return false;
        s.time.viewed = Math.max(s.time.viewed ?? 0, data.idle);
        return true;
      case 'session.execution.started':
        if (!sid) return false;
        this.#running.add(sid);
        if (s) {
          s.time.busy = at;
          s.time.updated = Math.max(s.time.updated, at);
          delete s.outcome;
        }
        return true;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (!sid) return false;
        this.#running.delete(sid);
        this.#active.delete(sid);
        if (s) {
          s.outcome = type.slice('session.execution.'.length) as SessionInfo['outcome'];
          s.time.idle = Math.max(s.time.idle ?? 0, at);
          s.time.updated = Math.max(s.time.updated, at);
        }
        return true;
      case 'session.idle':
        if (!sid) return false;
        this.#running.delete(sid);
        this.#active.delete(sid);
        return true;
      case 'session.status': {
        if (!sid) return false;
        const t = data.status?.type;
        if (t === 'busy' || t === 'retry') this.#running.add(sid);
        else if (t === 'idle') {
          this.#running.delete(sid);
          this.#active.delete(sid);
        } else return false;
        return true;
      }
      case 'permission.asked':
        if (!sid || typeof data.id !== 'string') return false;
        this.#perms.set(data.id, { sessionID: sid, dir: this.#dirOf(sid, ev) });
        return true;
      case 'permission.replied':
        return typeof data.requestID === 'string' && this.#perms.delete(data.requestID);
      case 'form.created': {
        const f = data.form;
        if (!f || typeof f.id !== 'string' || typeof f.sessionID !== 'string') return false;
        this.#forms.set(f.id, { sessionID: f.sessionID, dir: this.#dirOf(f.sessionID, ev) });
        return true;
      }
      case 'form.replied':
      case 'form.cancelled':
        return typeof data.id === 'string' && this.#forms.delete(data.id);
      default:
        return false;
    }
  }

  #dirOf(sessionID: string, ev: OcEvent): string | null {
    const s = this.#sessions.get(sessionID);
    const d = s?.location.directory ?? ev.location?.directory;
    return typeof d === 'string' ? this.#key(d) : null;
  }

  #forget(id: string): void {
    this.#sessions.delete(id);
    this.#running.delete(id);
    this.#active.delete(id);
    for (const [k, p] of this.#perms) if (p.sessionID === id) this.#perms.delete(k);
    for (const [k, f] of this.#forms) if (f.sessionID === id) this.#forms.delete(k);
    // OpenCode deletes child sessions with their parent.
    for (const s of [...this.#sessions.values()]) if (s.parentID === id) this.#forget(s.id);
  }

  #dropDir(key: string): void {
    for (const [id, s] of this.#sessions) if (this.#key(s.location.directory) === key) this.#sessions.delete(id);
    for (const [k, p] of this.#perms) if (p.dir === key) this.#perms.delete(k);
    for (const [k, f] of this.#forms) if (f.dir === key) this.#forms.delete(k);
  }

  #rootOf(id: string): string {
    let cur = id;
    for (let i = 0; i < 64; i++) {
      const p = this.#sessions.get(cur)?.parentID;
      if (!p || !this.#sessions.has(p)) return cur;
      cur = p;
    }
    return cur;
  }

  #status(rootId: string): SessionStatus {
    for (const p of this.#perms.values()) if (this.#rootOf(p.sessionID) === rootId) return 'needs-input';
    for (const f of this.#forms.values()) if (this.#rootOf(f.sessionID) === rootId) return 'needs-input';
    for (const id of this.#running) if (this.#rootOf(id) === rootId) return 'working';
    for (const id of this.#active) if (this.#rootOf(id) === rootId) return 'working';
    const s = this.#sessions.get(rootId);
    const idle = s?.time.idle;
    if (idle !== undefined) {
      const seen = Math.max(s?.time.viewed ?? 0, this.#store?.sessionMeta(rootId)?.lastSeen ?? 0);
      if (idle > seen) return 'unseen';
    }
    return 'idle';
  }

  #row(s: SessionInfo): SessionRow {
    const row: SessionRow = {
      id: s.id,
      agent: 'opencode',
      title: s.title ?? '',
      directory: s.location.directory,
      created: s.time.created,
      updated: s.time.updated,
      status: this.#status(s.id),
      archived: s.time.archived !== undefined,
    };
    if (s.outcome) row.outcome = s.outcome;
    return row;
  }

  #key(dir: string): string {
    return pathKey(dir, this.#platform);
  }

  #notify(): void {
    if (this.#disposed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      for (const cb of this.#listeners) {
        try {
          cb();
        } catch (err) {
          this.#onError(err as Error);
        }
      }
    }, this.#throttleMs);
  }
}

/** `Promise.all(items.map(fn))` with at most `limit` calls running at a time. Order is kept. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function normalizeInfo(raw: SessionInfo): SessionInfo {
  const t = raw.time ?? { created: 0, updated: 0 };
  return {
    id: raw.id,
    parentID: raw.parentID,
    title: raw.title,
    outcome: raw.outcome,
    time: { ...t, created: t.created ?? 0, updated: t.updated ?? t.created ?? 0 },
    location: { directory: raw.location?.directory ?? '' },
  };
}
