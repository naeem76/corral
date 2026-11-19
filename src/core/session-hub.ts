// One `SessionSource` over the sources of all agents (OpenCode service, Copilot CLI files).
// The app talks only to the hub. Ids of the agents cannot collide ("ses_..." against UUIDs),
// so an id alone finds its source.

import type { AgentId, SessionCapabilities, SessionRow, SessionSource, SessionStatus } from '../types.ts';

export interface HubEntry {
  agent: AgentId;
  source: SessionSource;
}

/** Optional methods of a source that wants to know when its session runs (Copilot). */
interface RunAware {
  opened?(id: string): void;
  closed?(id: string): Promise<void>;
}

export interface AgentInfo {
  agent: AgentId;
  available: boolean;
  reason: string | null;
}

export interface SessionHubOptions {
  /** Agent of `create()` without an agent, when it is available. */
  defaultAgent?: AgentId;
  onError?: (err: Error, agent: AgentId) => void;
}

const RANK: Record<SessionStatus, number> = { 'needs-input': 0, working: 1, unseen: 2, idle: 3 };
const NONE: SessionCapabilities = { rename: false, remove: false, archive: 'local' };

export class SessionHub implements SessionSource {
  #entries: HubEntry[];
  #byAgent = new Map<AgentId, SessionSource>();
  #owner = new Map<string, AgentId>();
  #dirs: string[] = [];
  #default: AgentId | undefined;
  #onError: (err: Error, agent: AgentId) => void;
  #listeners = new Set<() => void>();
  #unsubs: Array<() => void> = [];
  #withRows: Set<AgentId> | null = null;

  constructor(entries: readonly HubEntry[], opts: SessionHubOptions = {}) {
    this.#entries = [...entries];
    for (const e of entries) this.#byAgent.set(e.agent, e.source);
    this.#default = opts.defaultAgent;
    this.#onError = opts.onError ?? (() => {});
    for (const e of entries) {
      this.#unsubs.push(
        e.source.onChange(() => {
          this.#withRows = null;
          for (const cb of this.#listeners) cb();
        }),
      );
    }
  }

  // ---- agents --------------------------------------------------------------

  source(agent: AgentId): SessionSource | undefined {
    return this.#byAgent.get(agent);
  }

  agents(): AgentInfo[] {
    return this.#entries.map((e) => ({ agent: e.agent, available: e.source.available, reason: e.source.unavailableReason }));
  }

  get defaultAgent(): AgentId | undefined {
    return this.#default;
  }

  set defaultAgent(agent: AgentId | undefined) {
    this.#default = agent;
  }

  /** The agent of a session id, when a source knows it. */
  agentOf(id: string): AgentId | undefined {
    const known = this.#owner.get(id);
    if (known) return known;
    for (const e of this.#entries) {
      if (e.source.row(id)) {
        this.#owner.set(id, e.agent);
        return e.agent;
      }
    }
    return undefined;
  }

  /** Agents that have rows in the watched folders (cached until the next change). */
  agentsWithRows(): Set<AgentId> {
    if (this.#withRows) return this.#withRows;
    const out = new Set<AgentId>();
    for (const e of this.#entries) if (this.#dirs.some((d) => e.source.rows(d).length > 0)) out.add(e.agent);
    this.#withRows = out;
    return out;
  }

  capabilitiesOf(id: string): SessionCapabilities {
    const a = this.agentOf(id);
    return a ? this.capabilities(a) : NONE;
  }

  // ---- SessionSource -------------------------------------------------------

  get available(): boolean {
    return this.#entries.some((e) => e.source.available);
  }

  get unavailableReason(): string | null {
    if (this.available) return null;
    return this.#entries.map((e) => e.source.unavailableReason).filter(Boolean).join('; ') || 'no agent';
  }

  capabilities(agent: AgentId): SessionCapabilities {
    return this.#byAgent.get(agent)?.capabilities(agent) ?? NONE;
  }

  async watch(directories: readonly string[]): Promise<void> {
    this.#dirs = [...directories];
    this.#withRows = null;
    await this.#all('watch', (s) => s.watch(directories));
  }

  rows(directory: string): SessionRow[] {
    const out: SessionRow[] = [];
    for (const e of this.#entries) {
      for (const r of e.source.rows(directory)) {
        this.#owner.set(r.id, e.agent);
        out.push(r);
      }
    }
    if (this.#entries.length > 1) out.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updated - a.updated || (a.id < b.id ? -1 : 1));
    return out;
  }

  row(id: string): SessionRow | undefined {
    return this.#of(id)?.row(id);
  }

  activity(id: string): number {
    return this.#of(id)?.activity(id) ?? 0;
  }

  status(id: string): SessionStatus {
    return this.#of(id)?.status(id) ?? 'idle';
  }

  markSeen(id: string): void {
    this.#of(id)?.markSeen(id);
  }

  /** New session of the default agent, else of the first available one. */
  create(directory: string, title?: string): Promise<string> {
    const avail = this.#entries.filter((e) => e.source.available);
    const pick = avail.find((e) => e.agent === this.#default) ?? avail[0];
    if (!pick) return Promise.reject(new Error(`No agent can start a session: ${this.unavailableReason}`));
    return this.createWith(pick.agent, directory, title);
  }

  async createWith(agent: AgentId, directory: string, title?: string): Promise<string> {
    const s = this.#byAgent.get(agent);
    if (!s) throw new Error(`unknown agent: ${agent}`);
    const id = await s.create(directory, title);
    this.#owner.set(id, agent);
    this.#withRows = null;
    return id;
  }

  rename(id: string, title: string): Promise<void> {
    return this.#call(id, (s) => s.rename(id, title));
  }

  archive(id: string): Promise<void> {
    return this.#call(id, (s) => s.archive(id));
  }

  unarchive(id: string): Promise<void> {
    return this.#call(id, (s) => s.unarchive(id));
  }

  remove(id: string): Promise<void> {
    return this.#call(id, (s) => s.remove(id));
  }

  /** The program of the session started (a pane or the full window). */
  opened(id: string): void {
    (this.#of(id) as (SessionSource & RunAware) | undefined)?.opened?.(id);
  }

  /** The program of the session ended: the source reads its state again. */
  async closed(id: string): Promise<void> {
    const s = this.#of(id) as (SessionSource & RunAware) | undefined;
    if (s?.closed) await s.closed(id);
    else await s?.refresh();
  }

  async refresh(directories?: readonly string[]): Promise<void> {
    await this.#all('refresh', (s) => s.refresh(directories));
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  dispose(): void {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    this.#listeners.clear();
    for (const e of this.#entries) {
      try {
        e.source.dispose();
      } catch (err) {
        this.#onError(err as Error, e.agent);
      }
    }
  }

  // ---- helpers -------------------------------------------------------------

  #of(id: string): SessionSource | undefined {
    const a = this.agentOf(id);
    return a ? this.#byAgent.get(a) : undefined;
  }

  #call(id: string, fn: (s: SessionSource) => Promise<void>): Promise<void> {
    const s = this.#of(id);
    if (!s) return Promise.reject(new Error(`unknown session: ${id}`));
    return fn(s);
  }

  /** Run on every source; one failing source does not stop the others. */
  async #all(what: string, fn: (s: SessionSource) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.#entries.map((e) => Promise.resolve().then(() => fn(e.source))));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const e = this.#entries[i] as HubEntry;
        const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        this.#onError(new Error(`${e.agent} ${what}: ${err.message}`), e.agent);
      }
    });
  }
}
