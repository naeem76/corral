// Live panes: one OpenCode TUI per session, each a PTY in the service plus an emulator here.
// Independent of any view: the projects view and a later inbox view both show panes from it.
//
// At most `max` panes stay alive (LRU). A pane whose session is working or needs input is
// evicted only when every other candidate is busy too.

import type { Emulator, PtyHandle, PtySpawn, SessionStatus } from '../../types.ts';
import { OpenCodeError } from '../../core/opencode.ts';
import type { Launcher } from './launcher.ts';
import { ptyTitle } from './stale.ts';

export interface Pane {
  readonly sessionId: string;
  readonly directory: string;
  readonly emulator: Emulator;
  readonly pty: PtyHandle;
  cols: number;
  rows: number;
  lastUsed: number;
  readonly startedAt: number;
  gotOutput: boolean;
}

export type OpenResult =
  | { ok: true; pane: Pane; warning?: string }
  /** The version check or the executable lookup refused: nothing was started. */
  | { ok: false; kind: 'blocked'; message: string }
  /** The service has no usable PTY API (404/405/501): use the full-window hand-off. */
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };

export interface PaneManagerDeps {
  openPty: (spawn: PtySpawn) => Promise<PtyHandle>;
  createEmulator: (cols: number, rows: number) => Emulator;
  launcher: Launcher;
  pid: number;
  now: () => number;
  statusOf: (sessionId: string) => SessionStatus;
  /** Something visible changed (output, exit). */
  onChange: () => void;
  /** A pane ended on its own; `reason` is text for the information panel. */
  onExit: (sessionId: string, reason: string) => void;
  onError: (message: string) => void;
  max?: number;
  /** An exit this soon after the start, with no output, counts as "did not start". */
  quickExitMs?: number;
}

export class PaneManager {
  #deps: PaneManagerDeps;
  #panes = new Map<string, Pane>();
  #opening = new Map<string, Promise<OpenResult>>();
  #exitReasons = new Map<string, string>();
  #closed = false;

  constructor(deps: PaneManagerDeps) {
    this.#deps = deps;
  }

  get max(): number {
    return this.#deps.max ?? 8;
  }

  get(id: string): Pane | undefined {
    return this.#panes.get(id);
  }

  has(id: string): boolean {
    return this.#panes.has(id);
  }

  isOpening(id: string): boolean {
    return this.#opening.has(id);
  }

  list(): Pane[] {
    return [...this.#panes.values()];
  }

  /** Why the last pane of this session ended, until the next open. */
  exitReason(id: string): string | undefined {
    return this.#exitReasons.get(id);
  }

  touch(id: string): void {
    const p = this.#panes.get(id);
    if (p) p.lastUsed = this.#deps.now();
  }

  open(sessionId: string, directory: string, cols: number, rows: number): Promise<OpenResult> {
    const live = this.#panes.get(sessionId);
    if (live) {
      live.lastUsed = this.#deps.now();
      return Promise.resolve({ ok: true, pane: live });
    }
    const pending = this.#opening.get(sessionId);
    if (pending) return pending;
    const p = this.#open(sessionId, directory, Math.max(1, cols), Math.max(1, rows)).finally(() => this.#opening.delete(sessionId));
    this.#opening.set(sessionId, p);
    return p;
  }

  async #open(sessionId: string, directory: string, cols: number, rows: number): Promise<OpenResult> {
    const plan = await this.#deps.launcher.prepare();
    if (!plan.ok) return { ok: false, kind: 'blocked', message: plan.message };
    if (this.#closed) return { ok: false, kind: 'error', message: 'closing' };
    const emulator = this.#deps.createEmulator(cols, rows);
    let pty: PtyHandle;
    try {
      pty = await this.#deps.openPty({
        command: plan.command,
        args: ['--session', sessionId],
        cwd: directory,
        cols,
        rows,
        title: ptyTitle(this.#deps.pid, sessionId),
      });
    } catch (err) {
      const e = err as OpenCodeError;
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenCodeError && (e.status === 404 || e.status === 405 || e.status === 501)) {
        return { ok: false, kind: 'unsupported', message: msg };
      }
      return { ok: false, kind: 'error', message: msg };
    }
    if (this.#closed) {
      void pty.close();
      return { ok: false, kind: 'error', message: 'closing' };
    }
    const now = this.#deps.now();
    const pane: Pane = { sessionId, directory, emulator, pty, cols, rows, lastUsed: now, startedAt: now, gotOutput: false };
    this.#exitReasons.delete(sessionId);
    pty.onData = (data) => {
      pane.gotOutput = true;
      emulator.write(data);
      this.#deps.onChange();
    };
    emulator.onReply = (data) => pty.write(data);
    pty.onExit = (info) => {
      if (this.#panes.get(sessionId) !== pane) return;
      this.#panes.delete(sessionId);
      if (info.reason === 'closed') return;
      let reason =
        info.reason === 'disconnected'
          ? 'The connection to the OpenCode service was lost.'
          : `OpenCode exited${info.exitCode !== null ? ` with code ${info.exitCode}` : ''}.`;
      const quick = this.#deps.now() - pane.startedAt < (this.#deps.quickExitMs ?? 3000) && !pane.gotOutput;
      if (quick && plan.shimNote) reason += ' ' + plan.shimNote;
      else if (quick && info.reason === 'exited') reason += ' It exited at once: check that the service can run opencode (node src/main.ts doctor).';
      this.#exitReasons.set(sessionId, reason);
      // The service keeps an exited PTY until it is deleted.
      void pty.close();
      this.#deps.onExit(sessionId, reason);
      this.#deps.onChange();
    };
    this.#panes.set(sessionId, pane);
    this.#evict(sessionId);
    return plan.warning ? { ok: true, pane, warning: plan.warning } : { ok: true, pane };
  }

  /** Close panes beyond the limit. `keep` is never evicted. */
  #evict(keep: string): void {
    while (this.#panes.size > this.max) {
      const others = [...this.#panes.values()].filter((p) => p.sessionId !== keep);
      if (others.length === 0) return;
      const busy = (p: Pane) => {
        const s = this.#deps.statusOf(p.sessionId);
        return s === 'working' || s === 'needs-input';
      };
      const idle = others.filter((p) => !busy(p));
      const pool = idle.length > 0 ? idle : others;
      pool.sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = pool[0] as Pane;
      this.#panes.delete(victim.sessionId);
      void victim.pty.close();
    }
  }

  /** Make the pane `cols`×`rows` (the emulator now, the PTY through the service). */
  fit(id: string, cols: number, rows: number): boolean {
    const p = this.#panes.get(id);
    if (!p) return false;
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    if (p.cols === c && p.rows === r) return false;
    p.cols = c;
    p.rows = r;
    p.emulator.resize(c, r);
    p.pty.resize(c, r);
    return true;
  }

  write(id: string, data: string): void {
    if (!data) return;
    this.#panes.get(id)?.pty.write(data);
  }

  async close(id: string): Promise<void> {
    const p = this.#panes.get(id);
    if (!p) return;
    this.#panes.delete(id);
    await p.pty.close();
  }

  /** Close every pane (deletes the PTYs in the service). Never waits longer than `timeoutMs`. */
  async closeAll(timeoutMs = 1500): Promise<void> {
    this.#closed = true;
    const all = [...this.#panes.values()];
    this.#panes.clear();
    const work = Promise.allSettled(all.map((p) => p.pty.close()));
    await Promise.race([work, new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())]);
  }
}
