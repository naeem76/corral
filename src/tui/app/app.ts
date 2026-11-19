// The application controller: state, event handling, background loads, shutdown.
// Every side effect comes in through `AppDeps`, so the whole program runs headless in tests.
//
// Two views share this controller: the projects view (three columns) and the inbox view (one
// list, see inbox-view.ts). Pane management lives in PaneManager; a view only decides which
// session `selectedSession()` returns, and the pane follows it.

import path from 'node:path';
import type { Checkout, Emulator, InputEvent, Project, PtyHandle, PtySpawn, PullRequest, SessionRow, SessionStatus } from '../../types.ts';
import type { Git, CheckoutStatus } from '../../core/git.ts';
import type { OpenCodeApi } from '../../core/opencode.ts';
import type { PrProvider } from '../../core/pr.ts';
import type { SessionMeta, UiState } from '../../core/store.ts';
import type { SessionInfo } from '../../core/sessions.ts';
import { pathKey, samePath } from '../../core/paths.ts';
import { createFrame, renderDiff, type Frame, type Rect } from '../frame.ts';
import { matches } from '../keys.ts';
import type { ColorDepth } from '../style.ts';
import { encodeFocusForPty, encodeKeyForPty, encodeMouseForPty, encodePasteForPty } from '../input.ts';
import { inset, rectContains } from '../widgets/layout.ts';
import {
  createListState, handleListInput, moveSelection, reconcileList, selectKey, viewRows,
  type ListItem, type ListState,
} from '../widgets/list.ts';
import { createConfirm, handleConfirm, type ConfirmState } from '../widgets/modal.ts';
import { handleMenu, type MenuState } from '../widgets/menu.ts';
import { createTextInput, handleTextInput, type TextInputState } from '../widgets/textinput.ts';
import { fuzzyFilter } from '../widgets/fuzzy.ts';
import { buildBindings, findAction, listContexts, validLeaveKey, type ActionId, type BindingDef, type Context } from './bindings.ts';
import {
  createBrowser, handleBrowserInput, loadDir, loadGitMarks, refilter, resolveSubmit,
  type BrowserFs, type BrowserState,
} from './browser.ts';
import { errorText } from './format.ts';
import { handoff, type ChildRunner } from './handoff.ts';
import type { Launcher } from './launcher.ts';
import { InboxView } from './inbox-view.ts';
import { computeInboxLayout, computeLayout, type AppLayout } from './layout.ts';
import type { Logger } from './log.ts';
import { PaneManager } from './pane-manager.ts';
import { cleanupStalePtys } from './stale.ts';
import { renderApp } from './view.ts';
import { renderInbox } from './view-inbox.ts';

// ---------------------------------------------------------------------------
// Injected parts
// ---------------------------------------------------------------------------

export interface TerminalLike {
  size(): { cols: number; rows: number };
  onResize(cb: (size: { cols: number; rows: number }) => void): () => void;
  onInput(cb: (events: InputEvent[]) => void): () => void;
  onRedraw(cb: () => void): () => void;
  write(data: string): void;
  suspend(): void;
  resume(): void;
  close(): void;
  readonly closed: boolean;
  readonly suspended: boolean;
}

export interface AppStore {
  readonly projects: readonly Project[];
  readonly ui: Readonly<UiState>;
  onChange(cb: () => void): () => void;
  findProject(id: string): Project | undefined;
  addProject(dir: string, name?: string): Promise<Project>;
  removeProject(id: string): boolean;
  renameProject(id: string, name: string): boolean;
  moveProject(id: string, delta: -1 | 1): boolean;
  setProjectKind(id: string, kind: 'git' | 'dir'): void;
  setUi(patch: Partial<UiState>): void;
  sessionMeta(id: string): Readonly<SessionMeta> | undefined;
  setSessionMeta(id: string, patch: Partial<SessionMeta>): void;
  forgetSession(id: string): void;
  flush(): Promise<void>;
}

export interface AppTracker {
  readonly connected: boolean;
  onChange(cb: () => void): () => void;
  watch(directories: readonly string[]): Promise<void>;
  rows(directory: string): SessionRow[];
  status(id: string): SessionStatus;
  get(id: string): SessionInfo | undefined;
  markSeen(id: string): void;
  create(directory: string, title?: string): Promise<string>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  refresh(directories?: readonly string[]): Promise<void>;
  dispose(): void;
}

export interface AppDeps {
  terminal: TerminalLike;
  store: AppStore;
  git: Git;
  tracker: AppTracker;
  client: OpenCodeApi;
  prs: PrProvider;
  launcher: Launcher;
  openPty: (spawn: PtySpawn) => Promise<PtyHandle>;
  createEmulator: (cols: number, rows: number) => Emulator;
  /** Find or start the service. Rejects with a user-facing message. */
  ensureService: () => Promise<void>;
  /** Runs `opencode --session` with inherited stdio for the full-window hand-off. */
  runChild: ChildRunner;
  openUrl: (url: string) => Promise<void>;
  fs: BrowserFs;
  now: () => number;
  pid: number;
  isAlive: (pid: number) => boolean;
  platform: NodeJS.Platform;
  homedir: string;
  log: Logger;
  redact: (text: string) => string;
  depth?: ColorDepth;
  maxPanes?: number;
  /** Interval of the slow Git refresh. Default 30 s. */
  slowRefreshMs?: number;
  /** Debounce of the PTY resize after a layout change. Default 60 ms. */
  resizeDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** 'inbox' is the list of the inbox view; the other list foci belong to the projects view. */
export type Focus = 'projects' | 'git' | 'sessions' | 'inbox' | 'pane';
const COLUMNS: Focus[] = ['projects', 'git', 'sessions'];
/** Longest pause between the two clicks of a double click. */
const DOUBLE_CLICK_MS = 400;

export type GitRow =
  | { kind: 'checkout'; checkout: Checkout }
  | { kind: 'pr-header'; count: number }
  | { kind: 'pr'; pr: PullRequest };

export type Modal =
  | { kind: 'browser'; state: BrowserState }
  | {
      kind: 'prompt';
      title: string;
      label: string;
      input: TextInputState;
      /** A string keeps the prompt open and shows it as the error. */
      submit: (value: string) => string | void;
      error?: string;
    }
  | { kind: 'confirm'; state: ConfirmState; yes: () => void; no?: () => void }
  | { kind: 'menu'; state: MenuState; choose: (index: number) => void }
  | { kind: 'help'; scroll: number };

interface CheckoutCache {
  list: Checkout[];
  loading: boolean;
  error: string | null;
  at: number;
}

export interface Message {
  text: string;
  error: boolean;
  at: number;
}

const RANK: Record<SessionStatus, number> = { 'needs-input': 0, working: 1, unseen: 2, idle: 3 };

export function worstStatus(list: Iterable<SessionStatus>): SessionStatus | null {
  let best: SessionStatus | null = null;
  for (const s of list) if (best === null || RANK[s] < RANK[best]) best = s;
  return best;
}

export class App {
  readonly deps: AppDeps;
  readonly panes: PaneManager;
  readonly inbox: InboxView;
  bindings: BindingDef[];
  leaveKey: string;

  focus: Focus = 'projects';
  lists: Record<'projects' | 'git' | 'sessions', ListState>;
  modal: Modal | null = null;
  message: Message | null = null;
  /** Projects filter text; `filterEditing` while the field has the keyboard. */
  filter = '';
  filterInput: TextInputState = createTextInput();
  filterEditing = false;
  showArchived: boolean;
  zoom: boolean;
  view: 'projects' | 'inbox' = 'projects';

  checkouts = new Map<string, CheckoutCache>();
  statuses = new Map<string, CheckoutStatus>();
  prsAvailable = false;
  prs = new Map<string, PullRequest[]>();
  /** Checkout whose sessions the Sessions column shows. */
  checkoutPath: string | null = null;

  service: 'starting' | 'ok' | 'down' = 'starting';
  serviceError: string | null = null;
  /** Per-session note for the information panel (a blocked start, an error). */
  notes = new Map<string, string>();
  quitting = false;
  handingOff = false;

  #want: { checkout: string | null; session: string | null };
  /** Focus of the projects view while the inbox view is shown. */
  #projectsFocus: Focus = 'projects';
  #watchKey = '';
  #prev: Frame | null = null;
  #frame: Frame | null = null;
  #drawTimer: ReturnType<typeof setTimeout> | null = null;
  #lastDraw = 0;
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #slowTimer: ReturnType<typeof setInterval> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  #loadTimer: ReturnType<typeof setTimeout> | null = null;
  #tickState = '';
  #unsubs: Array<() => void> = [];
  #done!: (code: number) => void;
  readonly done: Promise<number>;
  #startedAt: number;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.done = new Promise((r) => (this.#done = r));
    const ui = deps.store.ui;
    this.leaveKey = validLeaveKey(ui.leaveKey);
    this.bindings = buildBindings(this.leaveKey);
    this.showArchived = ui.showArchived === true;
    this.zoom = ui.zoom === true;
    this.lists = {
      projects: createListState(ui.selectedProjectId ?? null),
      git: createListState(null),
      sessions: createListState(null),
    };
    this.#want = { checkout: ui.selectedCheckoutPath ?? null, session: ui.selectedSessionId ?? null };
    this.#startedAt = deps.now();
    if (ui.view === 'inbox') {
      this.view = 'inbox';
      this.focus = 'inbox';
    }
    this.inbox = new InboxView(this);
    this.panes = new PaneManager({
      openPty: deps.openPty,
      createEmulator: deps.createEmulator,
      launcher: deps.launcher,
      pid: deps.pid,
      now: deps.now,
      statusOf: (id) => deps.tracker.status(id),
      onChange: () => this.invalidate(),
      onExit: (id, reason) => {
        this.notes.set(id, this.deps.redact(reason));
        if (this.focus === 'pane' && this.selectedSession()?.id === id) this.focus = this.listFocus();
        this.updateWatch();
      },
      onError: (m) => this.error(m),
      max: deps.maxPanes,
    });
  }

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    const { terminal, store, tracker } = this.deps;
    if (store.ui.view !== 'projects' && store.ui.view !== 'inbox') store.setUi({ view: 'projects' });
    this.#unsubs.push(
      terminal.onInput((events) => {
        for (const ev of events) {
          try {
            this.handleEvent(ev);
          } catch (err) {
            this.error(`internal error: ${errorText(err)}`);
          }
        }
        this.invalidate();
      }),
      terminal.onResize(() => {
        this.#prev = null;
        this.invalidate();
      }),
      terminal.onRedraw(() => {
        this.#prev = null;
        this.invalidate();
      }),
      store.onChange(() => {
        this.inbox.changed();
        this.updateWatch();
        this.invalidate();
      }),
      tracker.onChange(() => this.onTrackerChange()),
    );
    // Restore the project selection, then load what it needs.
    this.lists.projects = reconcileList(this.lists.projects, this.projectItems(), this.listRows('projects'));
    this.onProjectChanged();
    if (this.view === 'inbox') void this.loadAllCheckouts();
    this.updateWatch();
    void this.connectService();
    void this.deps.prs.available().then(
      (yes) => {
        this.prsAvailable = yes;
        const p = this.selectedProject();
        if (yes && p) void this.loadPrs(p);
      },
      (err) => this.log(`pr provider: ${errorText(err)}`),
    );
    const every = this.deps.slowRefreshMs ?? 30_000;
    this.#slowTimer = setInterval(() => {
      const p = this.selectedProject();
      if (p && !this.handingOff) void this.loadCheckouts(p, true);
      this.invalidate();
    }, every);
    this.#slowTimer.unref?.();
    // Redraw when something changes that sends no event: the connection badge, an expired
    // footer message, the minute of the relative times, the end of a snooze (the inbox list
    // computes the next end; when it passes, the list is built again and the value changes).
    this.#tick = setInterval(() => {
      const m = this.message;
      const expired = m ? this.deps.now() - m.at > (m.error ? 12_000 : 5_000) : false;
      const wake = this.inbox.nextWake();
      const state = `${this.deps.tracker.connected}|${this.service}|${expired}|${Math.floor(this.deps.now() / 60_000)}|${wake}`;
      if (expired) this.message = null;
      if (state !== this.#tickState || expired) {
        this.#tickState = state;
        this.invalidate();
      }
    }, 1000);
    this.#tick.unref?.();
    this.draw();
  }

  #needing: Promise<boolean> | null = null;
  #lastClick: { col: Focus; key: string | null; at: number } | null = null;

  async connectService(): Promise<void> {
    try {
      await this.deps.ensureService();
      this.service = 'ok';
      this.serviceError = null;
      void this.cleanupStale();
    } catch (err) {
      this.service = 'down';
      this.serviceError = this.deps.redact(errorText(err));
      this.error(`OpenCode service not available: ${this.serviceError}. Run "node src/main.ts doctor" for details.`);
    }
    this.invalidate();
  }

  /**
   * Before a user action that needs the service: when the service is gone (stopped, killed,
   * restarted on another port), find it or start it again. Background reconnects never start
   * it, so a service that the user stopped on purpose stays stopped until the user acts.
   */
  async needService(): Promise<boolean> {
    if (this.service === 'ok' && this.deps.tracker.connected) return true;
    this.#needing ??= (async () => {
      try {
        await this.connectService();
        if (this.service !== 'ok') return false;
        // The service can be back with a new URL and password.
        await this.deps.client.connection(true).catch(() => {});
        return true;
      } finally {
        this.#needing = null;
      }
    })();
    return this.#needing;
  }

  async cleanupStale(): Promise<void> {
    const dirs = new Map<string, string>();
    const add = (d: string) => dirs.set(pathKey(d, this.deps.platform), d);
    for (const p of this.deps.store.projects) add(p.path);
    const recorded = this.deps.store.ui.ptyDirs;
    if (Array.isArray(recorded)) for (const d of recorded) if (typeof d === 'string') add(d);
    try {
      const r = await cleanupStalePtys(this.deps.client, [...dirs.values()], { pid: this.deps.pid, isAlive: this.deps.isAlive });
      if (r.removed.length) this.log(`removed ${r.removed.length} stale PTY(s): ${r.removed.join(', ')}`);
      for (const e of r.errors) this.log(`stale PTY cleanup: ${e}`);
      // Keep only folders that still hold PTYs of another live instance, plus the ones in use now.
      this.recordPtyDirs(r.busyDirs);
    } catch (err) {
      this.log(`stale PTY cleanup: ${errorText(err)}`);
    }
  }

  recordPtyDirs(extra: readonly string[] = []): void {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const d of [...extra, ...this.panes.list().map((p) => p.directory)]) {
      const k = pathKey(d, this.deps.platform);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
    const before = this.deps.store.ui.ptyDirs;
    const same = Array.isArray(before) && before.length === out.length && before.every((d, i) => d === out[i]);
    if (!same) this.deps.store.setUi({ ptyDirs: out.slice(0, 50) });
  }

  /** Close every PTY, flush the store, give the terminal back. Never hangs. */
  async shutdown(code = 0): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    if (this.#drawTimer) clearTimeout(this.#drawTimer);
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    if (this.#slowTimer) clearInterval(this.#slowTimer);
    if (this.#tick) clearInterval(this.#tick);
    if (this.#loadTimer) clearTimeout(this.#loadTimer);
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    const sel = this.projectSession();
    this.deps.store.setUi({
      selectedProjectId: this.selectedProject()?.id ?? null,
      selectedCheckoutPath: this.checkoutPath,
      selectedSessionId: sel?.id ?? this.deps.store.ui.selectedSessionId ?? null,
    });
    await this.panes.closeAll(1500);
    this.deps.store.setUi({ ptyDirs: [] });
    try {
      this.deps.tracker.dispose();
    } catch {}
    await Promise.race([this.deps.store.flush().catch((e) => this.log(`store flush: ${errorText(e)}`)), sleep(1000)]);
    this.deps.terminal.close();
    this.#done(code);
  }

  // ---- messages and logging ----------------------------------------------

  log(line: string): void {
    this.deps.log(line);
  }

  flash(text: string): void {
    this.message = { text: this.deps.redact(text), error: false, at: this.deps.now() };
    this.invalidate();
  }

  error(text: string): void {
    const t = this.deps.redact(text);
    this.message = { text: t, error: true, at: this.deps.now() };
    this.log(`error: ${t}`);
    this.invalidate();
  }

  // ---- derived data ------------------------------------------------------

  layout(): AppLayout {
    const { cols, rows } = this.deps.terminal.size();
    if (this.view === 'inbox') {
      return computeInboxLayout({ cols, rows, width: this.deps.store.ui.inboxWidth, paneFocused: this.focus === 'pane', zoom: this.zoom });
    }
    return computeLayout({
      cols,
      rows,
      widths: Array.isArray(this.deps.store.ui.columnWidths) ? this.deps.store.ui.columnWidths : undefined,
      paneFocused: this.focus === 'pane',
      zoom: this.zoom,
    });
  }

  /** The list rectangle inside a column. */
  listRect(col: 'projects' | 'git' | 'sessions', lay: AppLayout = this.layout()): Rect {
    const i = COLUMNS.indexOf(col);
    const outer = lay.columns?.[i];
    if (!outer) return { x: 0, y: 0, w: 0, h: 0 };
    const inner = inset(outer, 1);
    if (col === 'projects' && (this.filterEditing || this.filter)) return { ...inner, h: Math.max(0, inner.h - 1) };
    return inner;
  }

  rowHeight(col: 'projects' | 'git' | 'sessions'): number {
    return col === 'git' ? 2 : 1;
  }

  listRows(col: 'projects' | 'git' | 'sessions'): number {
    return viewRows(this.listRect(col).h, this.rowHeight(col));
  }

  projectItems(): ListItem<{ project: Project; positions: number[] }>[] {
    const all = this.deps.store.projects;
    if (!this.filter.trim()) return all.map((p) => ({ key: p.id, data: { project: p, positions: [] } }));
    return fuzzyFilter(this.filter, all, (p) => p.name).map(({ item, match }) => ({
      key: item.id,
      data: { project: item, positions: match.positions },
    }));
  }

  selectedProject(): Project | undefined {
    const id = this.lists.projects.selectedKey;
    return id ? this.deps.store.findProject(id) : undefined;
  }

  checkoutsOf(p: Project): Checkout[] {
    const c = this.checkouts.get(p.id);
    // A plain folder has exactly one row; no need to wait for the load.
    if (!c || (c.list.length === 0 && c.loading)) return p.kind === 'dir' ? [{ path: p.path, branch: null, isRoot: true, head: null }] : [];
    return c.list.map((co) => {
      const st = this.statuses.get(pathKey(co.path, this.deps.platform));
      if (!st) return co;
      return { ...co, dirty: st.dirty, ahead: st.ahead, behind: st.behind, branch: co.branch ?? st.branch };
    });
  }

  gitItems(p: Project | undefined = this.selectedProject()): ListItem<GitRow>[] {
    if (!p) return [];
    const out: ListItem<GitRow>[] = this.checkoutsOf(p).map((co) => ({
      key: 'co:' + pathKey(co.path, this.deps.platform),
      data: { kind: 'checkout', checkout: co },
    }));
    const prs = this.prsAvailable ? (this.prs.get(p.id) ?? []) : [];
    if (prs.length > 0) {
      out.push({ key: 'pr-header', data: { kind: 'pr-header', count: prs.length }, header: true });
      for (const pr of prs) out.push({ key: 'pr:' + pr.id, data: { kind: 'pr', pr } });
    }
    return out;
  }

  selectedGitRow(): GitRow | undefined {
    const key = this.lists.git.selectedKey;
    return key ? this.gitItems().find((it) => it.key === key)?.data : undefined;
  }

  selectedCheckout(): Checkout | undefined {
    const p = this.selectedProject();
    if (!p || !this.checkoutPath) return undefined;
    return this.checkoutsOf(p).find((c) => samePath(c.path, this.checkoutPath as string, this.deps.platform));
  }

  sessionRows(): SessionRow[] {
    if (!this.checkoutPath) return [];
    const rows = this.deps.tracker.rows(this.checkoutPath);
    return this.showArchived ? rows : rows.filter((r) => !r.archived);
  }

  sessionItems(): ListItem<SessionRow>[] {
    return this.sessionRows().map((r) => ({ key: r.id, data: r }));
  }

  /** The session of the current view: the pane, zoom and the session actions follow it. */
  selectedSession(): SessionRow | undefined {
    if (this.view === 'inbox') return this.inbox.selected()?.row;
    return this.projectSession();
  }

  /** The session selected in the Sessions column of the projects view. */
  projectSession(): SessionRow | undefined {
    const id = this.lists.sessions.selectedKey;
    return id ? this.sessionRows().find((r) => r.id === id) : undefined;
  }

  /** The list focus of the current view (where the leave key and a closed pane return). */
  listFocus(): Focus {
    return this.view === 'inbox' ? 'inbox' : 'sessions';
  }

  /** Directories of a project the tracker can know: the root and the loaded checkouts. */
  projectDirs(p: Project): string[] {
    const dirs = [p.path];
    for (const c of this.checkouts.get(p.id)?.list ?? []) if (!samePath(c.path, p.path, this.deps.platform)) dirs.push(c.path);
    return dirs;
  }

  statusOfDir(dir: string): SessionStatus | null {
    return worstStatus(this.deps.tracker.rows(dir).filter((r) => !r.archived).map((r) => r.status));
  }

  statusOfProject(p: Project): SessionStatus | null {
    const all: SessionStatus[] = [];
    for (const d of this.projectDirs(p)) for (const r of this.deps.tracker.rows(d)) if (!r.archived) all.push(r.status);
    return worstStatus(all);
  }

  /** Every non-archived session the tracker knows, in attention order. */
  attentionList(): Array<{ project: Project; dir: string; row: SessionRow }> {
    const out: Array<{ project: Project; dir: string; row: SessionRow }> = [];
    const seen = new Set<string>();
    for (const p of this.deps.store.projects) {
      for (const d of this.projectDirs(p)) {
        for (const row of this.deps.tracker.rows(d)) {
          if (row.archived || seen.has(row.id)) continue;
          seen.add(row.id);
          out.push({ project: p, dir: d, row });
        }
      }
    }
    out.sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || b.row.updated - a.row.updated);
    return out;
  }

  /**
   * Watch the roots of all projects, the checkouts of the selected one, and live pane folders.
   * The inbox view watches the loaded checkouts of every project.
   */
  updateWatch(): void {
    const dirs = new Map<string, string>();
    const add = (d: string) => dirs.set(pathKey(d, this.deps.platform), d);
    for (const p of this.deps.store.projects) add(p.path);
    if (this.view === 'inbox') for (const p of this.deps.store.projects) for (const d of this.projectDirs(p)) add(d);
    const sel = this.selectedProject();
    if (sel) for (const d of this.projectDirs(sel)) add(d);
    for (const pane of this.panes.list()) add(pane.directory);
    const key = [...dirs.keys()].sort().join('\0');
    if (key === this.#watchKey) return;
    this.#watchKey = key;
    this.deps.tracker.watch([...dirs.values()]).catch((err) => this.log(`watch: ${errorText(err)}`));
  }

  // ---- background loads --------------------------------------------------

  /** Load the checkouts of every project, a few at a time (the inbox view needs all folders). */
  async loadAllCheckouts(force = false): Promise<void> {
    const list = [...this.deps.store.projects];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < list.length && !this.quitting) {
        const p = list[next++] as Project;
        await this.loadCheckouts(p, force).catch((err) => this.log(`checkouts ${p.path}: ${errorText(err)}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  }

  async loadCheckouts(p: Project, force = false): Promise<void> {
    const cur = this.checkouts.get(p.id);
    if (cur?.loading) return;
    if (cur && !force && this.deps.now() - cur.at < 30_000) return;
    const entry: CheckoutCache = cur ? { ...cur, loading: true } : { list: [], loading: true, error: null, at: 0 };
    this.checkouts.set(p.id, entry);
    let list: Checkout[];
    try {
      if (p.kind === 'dir' && this.deps.git.available && (await this.deps.git.detectKind(p.path)) === 'git') {
        this.deps.store.setProjectKind(p.id, 'git');
      }
      const fresh = this.deps.store.findProject(p.id) ?? p;
      list = await this.deps.git.listCheckouts(fresh);
      entry.error = null;
    } catch (err) {
      // The folder may have stopped being a Git repository.
      if (p.kind === 'git' && (await this.deps.git.detectKind(p.path).catch(() => 'git')) === 'dir') {
        this.deps.store.setProjectKind(p.id, 'dir');
        list = [{ path: p.path, branch: null, isRoot: true, head: null }];
        entry.error = null;
      } else {
        list = entry.list.length ? entry.list : [{ path: p.path, branch: null, isRoot: true, head: null }];
        entry.error = errorText(err);
        this.log(`git worktree list ${p.path}: ${entry.error}`);
      }
    }
    entry.list = list;
    entry.loading = false;
    entry.at = this.deps.now();
    this.checkouts.set(p.id, entry);
    this.inbox.changed();
    this.afterCheckoutsLoaded(p);
    this.updateWatch();
    this.invalidate();
    const fresh = this.deps.store.findProject(p.id) ?? p;
    if (fresh.kind === 'git') {
      await Promise.all(
        list.map(async (co) => {
          try {
            const st = await this.deps.git.checkoutStatus(co.path);
            this.statuses.set(pathKey(co.path, this.deps.platform), st);
          } catch (err) {
            this.log(`git status ${co.path}: ${errorText(err)}`);
          }
        }),
      );
      this.invalidate();
    }
  }

  async loadPrs(p: Project): Promise<void> {
    try {
      const list = await this.deps.prs.list(p);
      this.prs.set(p.id, list);
    } catch (err) {
      this.log(`pull requests: ${errorText(err)}`);
    }
    this.invalidate();
  }

  /** Apply a wanted checkout selection once the list is there. */
  afterCheckoutsLoaded(p: Project): void {
    if (this.selectedProject()?.id !== p.id) return;
    const items = this.gitItems(p);
    const want = this.#want.checkout;
    let key = this.lists.git.selectedKey;
    if (want) {
      const k = 'co:' + pathKey(want, this.deps.platform);
      if (items.some((it) => it.key === k)) {
        key = k;
        this.#want.checkout = null;
      } else {
        // Give up only after a finished load that does not have it.
        const c = this.checkouts.get(p.id);
        if (c && !c.loading && c.at > 0) this.#want.checkout = null;
      }
    }
    this.lists.git = reconcileList({ ...this.lists.git, selectedKey: key }, items, this.listRows('git'));
    this.onGitChanged(false);
  }

  onTrackerChange(): void {
    this.inbox.changed();
    this.inbox.applyMarkRules();
    // Apply a wanted session selection once its row exists.
    const want = this.#want.session;
    if (want && this.sessionRows().some((r) => r.id === want)) {
      this.lists.sessions = selectKey(this.lists.sessions, this.sessionItems(), want, this.listRows('sessions'));
      this.#want.session = null;
    }
    if (this.view === 'inbox') this.inbox.reconcile();
    // A session shown in the focused pane that turns unseen is seen at once.
    const s = this.selectedSession();
    if (this.focus === 'pane' && s && s.status === 'unseen') this.deps.tracker.markSeen(s.id);
    this.invalidate();
  }

  // ---- selection changes -------------------------------------------------

  onProjectChanged(): void {
    const p = this.selectedProject();
    this.deps.store.setUi({ selectedProjectId: p?.id ?? null });
    if (!p) {
      this.checkoutPath = null;
      this.invalidate();
      return;
    }
    const items = this.gitItems(p);
    if (!this.#want.checkout) {
      // Fresh project: the root checkout first.
      this.lists.git = reconcileList(createListState(items[0]?.key ?? null), items, this.listRows('git'));
    } else this.afterCheckoutsLoaded(p);
    this.onGitChanged(false);
    // Debounced: holding j over many projects must not start a git process for each one.
    if (this.#loadTimer) clearTimeout(this.#loadTimer);
    this.#loadTimer = setTimeout(() => {
      this.#loadTimer = null;
      if (this.selectedProject()?.id !== p.id) return;
      void this.loadCheckouts(p);
      if (this.prsAvailable) void this.loadPrs(p);
    }, this.checkouts.has(p.id) ? 150 : 40);
    this.updateWatch();
  }

  onGitChanged(userMoved = true): void {
    const row = this.selectedGitRow();
    const p = this.selectedProject();
    const cur = this.checkoutPath;
    let next: string | null;
    if (!p) next = null;
    else if (row?.kind === 'checkout') next = row.checkout.path;
    // A pull-request row keeps the checkout the Sessions column showed before.
    else if (row && cur && this.projectDirs(p).some((d) => samePath(d, cur, this.deps.platform))) next = cur;
    else next = p.path;
    const changed = (next ?? '') !== (this.checkoutPath ?? '');
    this.checkoutPath = next;
    if (row?.kind === 'checkout' || !row) this.deps.store.setUi({ selectedCheckoutPath: next });
    if (changed || userMoved) {
      const items = this.sessionItems();
      const want = this.#want.session;
      if (want && items.some((it) => it.key === want)) {
        this.lists.sessions = selectKey(createListState(), items, want, this.listRows('sessions'));
        this.#want.session = null;
      } else if (changed) {
        this.lists.sessions = reconcileList(createListState(items[0]?.key ?? null), items, this.listRows('sessions'));
      }
      this.onSessionChanged();
    }
  }

  onSessionChanged(): void {
    // Background loads call this in the inbox view too: only the projects view state changes then.
    const s = this.projectSession();
    if (s && this.view === 'projects') this.panes.touch(s.id);
    if (s || !this.#want.session) this.deps.store.setUi({ selectedSessionId: s?.id ?? this.#want.session ?? null });
    if (this.view === 'projects' && this.focus === 'pane' && (!s || !this.panes.has(s.id))) this.focus = 'sessions';
  }

  // ---- input -------------------------------------------------------------

  handleEvent(ev: InputEvent): void {
    if (this.quitting || this.handingOff) return;
    if (this.modal) {
      this.handleModal(ev);
      return;
    }
    if (this.focus === 'pane') {
      this.handlePaneEvent(ev);
      return;
    }
    if (this.view === 'inbox') {
      this.focus = 'inbox';
      this.inbox.handleEvent(ev);
      return;
    }
    if (ev.type === 'mouse') {
      this.handleMouse(ev);
      return;
    }
    if (ev.type === 'focus') return;
    if (this.filterEditing) {
      this.handleFilter(ev);
      return;
    }
    if (ev.type === 'paste') return;
    const col = this.focus as 'projects' | 'git' | 'sessions';
    const action = findAction(this.bindings, listContexts(col), ev);
    if (action) {
      this.run(action);
      return;
    }
    if (col === 'projects' && this.filter && ev.type === 'key' && ev.key === 'escape') {
      this.setFilter('');
      return;
    }
    this.listInput(col, ev);
  }

  listInput(col: 'projects' | 'git' | 'sessions', ev: InputEvent, rect: Rect = this.listRect(col)): { activated: boolean } {
    const items = this.itemsOf(col);
    const before = this.lists[col].selectedKey;
    const r = handleListInput(this.lists[col], items as ListItem<unknown>[], ev, rect, { rowHeight: this.rowHeight(col) });
    this.lists[col] = r.state;
    if (r.state.selectedKey !== before) this.selectionMoved(col);
    return { activated: r.activated };
  }

  itemsOf(col: 'projects' | 'git' | 'sessions'): ListItem<unknown>[] {
    if (col === 'projects') return this.projectItems();
    if (col === 'git') return this.gitItems();
    return this.sessionItems();
  }

  selectionMoved(col: 'projects' | 'git' | 'sessions'): void {
    if (col === 'projects') {
      this.#want.checkout = null;
      this.#want.session = null;
      this.onProjectChanged();
    } else if (col === 'git') {
      this.#want.session = null;
      this.onGitChanged();
    } else {
      this.#want.session = null;
      this.onSessionChanged();
    }
  }

  handleFilter(ev: InputEvent): void {
    if (ev.type === 'key' && !ev.ctrl && !ev.alt && (ev.key === 'up' || ev.key === 'down')) {
      this.listInput('projects', ev);
      return;
    }
    if (ev.type === 'key' && ev.key === 'enter') {
      this.filterEditing = false;
      return;
    }
    const r = handleTextInput(this.filterInput, ev);
    if (r.action === 'cancel') {
      this.filterEditing = false;
      this.setFilter('');
      return;
    }
    if (!r.handled) return;
    this.filterInput = r.state;
    if (r.state.value !== this.filter) this.setFilter(r.state.value, true);
  }

  setFilter(text: string, keepEditing = false): void {
    const before = this.lists.projects.selectedKey;
    this.filter = text;
    if (!keepEditing) this.filterInput = createTextInput(text);
    const items = this.projectItems();
    // While typing, the best match is selected.
    const next = text.trim() && items[0] ? createListState(items[0].key) : this.lists.projects;
    this.lists.projects = reconcileList(next, items, this.listRows('projects'));
    if (this.lists.projects.selectedKey !== before) this.selectionMoved('projects');
  }

  handleMouse(ev: Extract<InputEvent, { type: 'mouse' }>): void {
    if (this.view === 'inbox') {
      this.inbox.handleMouse(ev);
      return;
    }
    const lay = this.layout();
    if (lay.columns) {
      for (let i = 0; i < 3; i++) {
        const outer = lay.columns[i] as Rect;
        if (!rectContains(outer, ev.x, ev.y)) continue;
        const col = COLUMNS[i] as 'projects' | 'git' | 'sessions';
        if (ev.action === 'down' && this.focus !== col) {
          this.focus = col;
          this.onFocusChanged();
        }
        const before = this.lists[col].selectedKey;
        const r = this.listInput(col, ev, this.listRect(col, lay));
        if (ev.action !== 'down' || ev.button !== 'left') return;
        // One click selects and focuses. Only a second click on the same row acts as Enter:
        // Enter on a project moves the focus to the next column, which a single click must not do.
        const key = this.lists[col].selectedKey;
        const onRow = r.activated || key !== before;
        const now = this.deps.now();
        const last = this.#lastClick;
        const double = r.activated && last !== null && last.col === col && last.key === key && now - last.at <= DOUBLE_CLICK_MS;
        this.#lastClick = onRow && !double ? { col, key, at: now } : null;
        if (double) this.run('enter');
        return;
      }
    }
    if (lay.pane && rectContains(lay.pane, ev.x, ev.y) && ev.action === 'down' && ev.button === 'left') {
      const s = this.selectedSession();
      if (s && this.panes.has(s.id)) this.enterPane();
    }
  }

  handlePaneEvent(ev: InputEvent): void {
    const s = this.selectedSession();
    const pane = s ? this.panes.get(s.id) : undefined;
    if (!s || !pane) {
      this.focus = this.listFocus();
      return;
    }
    switch (ev.type) {
      case 'key':
        if (matches(ev, this.leaveKey)) {
          this.leavePane();
          return;
        }
        this.panes.write(s.id, encodeKeyForPty(ev, pane.emulator.modes));
        return;
      case 'paste':
        this.panes.write(s.id, encodePasteForPty(ev.text, pane.emulator.modes));
        return;
      case 'focus': {
        const seq = encodeFocusForPty(ev.focused, pane.emulator.modes);
        if (seq) this.panes.write(s.id, seq);
        return;
      }
      case 'mouse': {
        const lay = this.layout();
        const inner = lay.paneInner;
        if (inner && rectContains(inner, ev.x, ev.y)) {
          const seq = encodeMouseForPty(ev, inner.x, inner.y, pane.emulator.modes);
          if (seq) this.panes.write(s.id, seq);
          return;
        }
        const onList = lay.columns?.some((r) => rectContains(r, ev.x, ev.y)) || (lay.list !== null && rectContains(lay.list, ev.x, ev.y));
        if (ev.action === 'down' && onList) {
          this.leavePane();
          this.handleMouse(ev);
        }
        return;
      }
    }
  }

  enterPane(): void {
    const s = this.selectedSession();
    if (!s) return;
    const pane = this.panes.get(s.id);
    if (!pane) return;
    this.focus = 'pane';
    this.panes.touch(s.id);
    this.deps.tracker.markSeen(s.id);
    this.inbox.opened(s.id);
    const seq = encodeFocusForPty(true, pane.emulator.modes);
    if (seq) this.panes.write(s.id, seq);
    this.#prev = null;
  }

  leavePane(): void {
    const s = this.selectedSession();
    const pane = s ? this.panes.get(s.id) : undefined;
    if (s && pane) {
      const seq = encodeFocusForPty(false, pane.emulator.modes);
      if (seq) this.panes.write(s.id, seq);
    }
    this.focus = this.listFocus();
    this.#prev = null;
  }

  handleModal(ev: InputEvent): void {
    const m = this.modal;
    if (!m) return;
    switch (m.kind) {
      case 'help': {
        if (ev.type === 'key') {
          if (ev.key === 'down' || ev.key === 'j') m.scroll++;
          else if (ev.key === 'up' || ev.key === 'k') m.scroll = Math.max(0, m.scroll - 1);
          else if (ev.key === 'pagedown' || ev.key === 'space') m.scroll += 10;
          else if (ev.key === 'pageup') m.scroll = Math.max(0, m.scroll - 10);
          else this.modal = null;
        } else if (ev.type === 'mouse') {
          if (ev.action === 'wheel-down') m.scroll += 3;
          else if (ev.action === 'wheel-up') m.scroll = Math.max(0, m.scroll - 3);
          else if (ev.action === 'down') this.modal = null;
        }
        return;
      }
      case 'menu': {
        const r = handleMenu(m.state, ev);
        m.state = r.state;
        if (r.result === 'cancel') this.modal = null;
        else if (r.result !== null) {
          this.modal = null;
          m.choose(r.result);
        }
        return;
      }
      case 'confirm': {
        const r = handleConfirm(m.state, ev);
        m.state = r.state;
        if (r.result === 'yes') {
          this.modal = null;
          m.yes();
        } else if (r.result === 'no') {
          this.modal = null;
          m.no?.();
        }
        return;
      }
      case 'prompt': {
        const r = handleTextInput(m.input, ev);
        if (r.action === 'cancel') this.modal = null;
        else if (r.action === 'submit') {
          this.modal = null;
          const error = m.submit(m.input.value);
          if (typeof error === 'string' && this.modal === null) {
            m.error = error;
            this.modal = m;
          }
        } else {
          if (r.state.value !== m.input.value) delete m.error;
          m.input = r.state;
        }
        return;
      }
      case 'browser': {
        const env = { platform: this.deps.platform, homedir: this.deps.homedir };
        const r = handleBrowserInput(m.state, ev, env, this.browserRows());
        m.state = r.state;
        if (r.action.kind === 'cancel') this.modal = null;
        else if (r.action.kind === 'submit') void this.submitBrowser(m, r.action.path);
        else if (r.action.kind === 'changed') void this.refreshBrowser(m);
        return;
      }
    }
  }

  browserRows(): number {
    const { rows } = this.deps.terminal.size();
    return Math.max(3, Math.min(20, rows - 12));
  }

  async refreshBrowser(m: Extract<Modal, { kind: 'browser' }>): Promise<void> {
    const env = { platform: this.deps.platform, homedir: this.deps.homedir };
    const dir = m.state.dir;
    if (!m.state.cache.has(dir)) {
      await loadDir(m.state, this.deps.fs);
      if (this.modal !== m) return;
      m.state = refilter(m.state, env);
      this.invalidate();
    }
    if (await loadGitMarks(m.state, this.deps.fs, env)) this.invalidate();
  }

  async submitBrowser(m: Extract<Modal, { kind: 'browser' }>, typed: string): Promise<void> {
    const env = { platform: this.deps.platform, homedir: this.deps.homedir };
    const target = await resolveSubmit(m.state, typed, this.deps.fs, env);
    if (this.modal !== m) return;
    if (!target) {
      m.state = { ...m.state, notice: `not a folder: ${typed}` };
      this.invalidate();
      return;
    }
    try {
      const p = await this.deps.store.addProject(target);
      if (this.modal === m) this.modal = null;
      this.setFilter('');
      this.lists.projects = selectKey(this.lists.projects, this.projectItems(), p.id, this.listRows('projects'));
      this.focus = 'projects';
      this.selectionMoved('projects');
      this.flash(`Added ${p.kind === 'git' ? 'Git repository' : 'folder'} ${p.path}`);
    } catch (err) {
      if (this.modal === m) m.state = { ...m.state, notice: errorText(err) };
      this.invalidate();
    }
  }

  // ---- actions -----------------------------------------------------------

  run(action: ActionId): void {
    if (this.view === 'inbox' && this.inbox.run(action)) return;
    const col = this.focus as 'projects' | 'git' | 'sessions';
    switch (action) {
      case 'focus-next':
        if (col === 'sessions') this.tryEnterPane();
        else this.focus = COLUMNS[COLUMNS.indexOf(col) + 1] as Focus;
        this.onFocusChanged();
        return;
      case 'focus-prev':
      case 'focus-left':
        if (col !== 'projects') this.focus = COLUMNS[COLUMNS.indexOf(col) - 1] as Focus;
        this.onFocusChanged();
        return;
      case 'focus-right':
        if (col === 'sessions') this.tryEnterPane();
        else this.focus = COLUMNS[COLUMNS.indexOf(col) + 1] as Focus;
        this.onFocusChanged();
        return;
      case 'half-down':
      case 'half-up': {
        const rows = this.listRows(col);
        const d = Math.max(1, Math.floor(rows / 2)) * (action === 'half-down' ? 1 : -1);
        const before = this.lists[col].selectedKey;
        this.lists[col] = moveSelection(this.lists[col], this.itemsOf(col), d, rows);
        if (this.lists[col].selectedKey !== before) this.selectionMoved(col);
        return;
      }
      case 'enter':
        this.activate(col);
        return;
      case 'add-project':
      case 'project-add':
        this.openBrowser();
        return;
      case 'next-attention':
      case 'prev-attention':
        this.jumpAttention(action === 'next-attention' ? 1 : -1);
        return;
      case 'zoom':
        this.zoom = !this.zoom;
        this.deps.store.setUi({ zoom: this.zoom });
        if (this.zoom) {
          const s = this.selectedSession();
          if (s && this.panes.has(s.id)) this.enterPane();
          else this.flash('Zoom on: an open pane takes the whole window while it has focus.');
        } else this.flash('Zoom off.');
        return;
      case 'refresh':
        this.refreshAll();
        return;
      case 'switch-view':
        this.switchView(this.view === 'inbox' ? 'projects' : 'inbox');
        return;
      case 'session-snooze':
      case 'session-settle':
      case 'session-unmark': {
        const s = this.selectedSession();
        if (!s) return;
        if (action === 'session-snooze') this.inbox.snoozeMenu(s);
        else if (action === 'session-settle') this.inbox.toggleSettle(s);
        else this.inbox.unmark(s);
        return;
      }
      case 'help':
        this.modal = { kind: 'help', scroll: 0 };
        return;
      case 'quit':
        this.modal = {
          kind: 'confirm',
          state: createConfirm({
            title: 'Quit',
            message: 'Leave nebula-enterprise? Sessions keep running in the OpenCode service.',
            yesLabel: 'Quit',
            noLabel: 'Stay',
            choice: 'yes',
          }),
          yes: () => void this.shutdown(0),
        };
        return;
      case 'project-remove':
        this.removeProject();
        return;
      case 'project-rename':
        this.renameProject();
        return;
      case 'project-down':
      case 'project-up': {
        const p = this.selectedProject();
        if (!p) return;
        if (this.filter) {
          this.flash('Clear the filter (Esc) to change the order.');
          return;
        }
        this.deps.store.moveProject(p.id, action === 'project-down' ? 1 : -1);
        this.lists.projects = selectKey(this.lists.projects, this.projectItems(), p.id, this.listRows('projects'));
        return;
      }
      case 'project-filter':
        this.filterEditing = true;
        this.filterInput = createTextInput(this.filter);
        return;
      case 'worktree-new':
        this.newWorktree();
        return;
      case 'worktree-delete':
        this.deleteWorktree();
        return;
      case 'session-new':
        void this.newSession();
        return;
      case 'session-rename':
        this.renameSession();
        return;
      case 'session-archive':
      case 'session-unarchive':
        void this.archiveSession(action === 'session-unarchive' ? 'unarchive' : 'toggle');
        return;
      case 'session-delete':
        this.deleteSession();
        return;
      case 'session-show-archived':
        this.showArchived = !this.showArchived;
        this.deps.store.setUi({ showArchived: this.showArchived });
        this.lists.sessions = reconcileList(this.lists.sessions, this.sessionItems(), this.listRows('sessions'));
        this.onSessionChanged();
        this.flash(this.showArchived ? 'Showing archived sessions.' : 'Archived sessions hidden.');
        return;
      case 'session-handoff': {
        const s = this.selectedSession();
        if (s) void this.runHandoff(s);
        return;
      }
      default:
        return;
    }
  }

  onFocusChanged(): void {
    const p = this.selectedProject();
    // Refresh the Git column when it gets focus (cheap: the cache has a 30 s floor otherwise).
    if (this.focus === 'git' && p) void this.loadCheckouts(p, true);
  }

  tryEnterPane(): void {
    const s = this.selectedSession();
    if (s && this.panes.has(s.id)) this.enterPane();
    else if (s) this.flash('Press Enter to open the session in the pane.');
  }

  activate(col: 'projects' | 'git' | 'sessions'): void {
    if (col === 'projects') {
      if (this.selectedProject()) this.focus = 'git';
      else this.openBrowser();
      this.onFocusChanged();
      return;
    }
    if (col === 'git') {
      const row = this.selectedGitRow();
      if (row?.kind === 'pr') {
        const url = row.pr.url;
        this.deps.openUrl(url).then(
          () => this.flash(`Opened ${url}`),
          (err) => this.error(`Cannot open the URL: ${errorText(err)}`),
        );
        return;
      }
      if (row?.kind === 'checkout') this.focus = 'sessions';
      return;
    }
    const s = this.selectedSession();
    if (!s) {
      void this.newSession();
      return;
    }
    void this.openSession(s, true);
  }

  /**
   * Show the other view. The selection goes along: the session of the Sessions column is
   * selected in the inbox (when it is there), the inbox session in the columns. Panes stay open.
   */
  switchView(to: 'projects' | 'inbox', entry?: { row: SessionRow; project: Project; checkout?: Checkout }): void {
    if (to === this.view) return;
    if (this.focus === 'pane') this.leavePane();
    if (to === 'inbox') {
      const s = this.projectSession();
      this.#projectsFocus = this.focus;
      this.view = 'inbox';
      this.focus = 'inbox';
      this.deps.store.setUi({ view: 'inbox' });
      this.inbox.changed();
      if (s && this.inbox.items().some((it) => it.key === s.id)) this.inbox.select(s.id);
      void this.loadAllCheckouts();
    } else {
      const e = entry ?? this.inbox.selected();
      this.view = 'projects';
      this.focus = this.#projectsFocus === 'inbox' || this.#projectsFocus === 'pane' ? 'sessions' : this.#projectsFocus;
      this.deps.store.setUi({ view: 'projects' });
      if (e) {
        this.selectSession(e.project, e.checkout?.path ?? e.row.directory, e.row.id);
        this.focus = 'sessions';
      }
    }
    this.updateWatch();
    this.#prev = null;
    this.invalidate();
  }

  refreshAll(): void {
    if (this.view === 'inbox') void this.loadAllCheckouts(true);
    const p = this.selectedProject();
    if (p) {
      void this.loadCheckouts(p, true);
      if (this.prsAvailable) void this.loadPrs(p);
    }
    this.flash('Refreshing…');
    void this.needService()
      .then((up) => (up ? this.deps.tracker.refresh() : undefined))
      .catch((err) => this.log(`refresh: ${errorText(err)}`));
  }

  openBrowser(): void {
    const env = { platform: this.deps.platform, homedir: this.deps.homedir };
    const p = this.selectedProject();
    const start = p ? path[this.deps.platform === 'win32' ? 'win32' : 'posix'].dirname(p.path) : this.deps.homedir;
    const m: Extract<Modal, { kind: 'browser' }> = { kind: 'browser', state: createBrowser(start, env) };
    this.modal = m;
    void this.refreshBrowser(m);
  }

  removeProject(): void {
    const p = this.selectedProject();
    if (!p) return;
    this.modal = {
      kind: 'confirm',
      state: createConfirm({
        title: 'Remove project',
        message: `Remove "${p.name}" from the list? Only the list entry goes; the folder and its files stay.`,
        yesLabel: 'Remove',
        noLabel: 'Keep',
      }),
      yes: () => {
        this.deps.store.removeProject(p.id);
        this.checkouts.delete(p.id);
        this.lists.projects = reconcileList(this.lists.projects, this.projectItems(), this.listRows('projects'));
        this.selectionMoved('projects');
        this.flash(`Removed ${p.name} from the list.`);
      },
    };
  }

  renameProject(): void {
    const p = this.selectedProject();
    if (!p) return;
    this.modal = {
      kind: 'prompt',
      title: 'Rename project',
      label: `Label for ${p.path} (the folder keeps its name):`,
      input: createTextInput(p.name),
      submit: (v) => {
        if (!this.deps.store.renameProject(p.id, v)) this.error('The name cannot be empty.');
      },
    };
  }

  newWorktree(): void {
    const p = this.selectedProject();
    if (!p) return;
    if (p.kind !== 'git') {
      this.flash('This project is a plain folder: it has no Git worktrees.');
      return;
    }
    if (!this.deps.git.available) {
      this.error(this.deps.git.unavailableReason ?? 'git is not available');
      return;
    }
    this.modal = {
      kind: 'prompt',
      title: 'New worktree',
      label: 'Branch name (new from the default branch, or an existing branch):',
      input: createTextInput(),
      submit: (v) => void this.createWorktree(p, v.trim()),
    };
  }

  async createWorktree(p: Project, name: string): Promise<void> {
    if (!name) return;
    const git = this.deps.git;
    this.flash(`Creating worktree ${name}…`);
    try {
      const branches = await git.listBranches(p.path);
      const exists = branches.some((b) => (b.remote ? b.name.slice(b.name.indexOf('/') + 1) === name : b.name === name));
      let dest: string;
      if (exists) dest = await git.createWorktree(p, name, { newBranch: false });
      else {
        const base = await git.defaultBranch(p.path);
        dest = await git.createWorktree(p, name, { newBranch: true, base: base ?? undefined });
      }
      this.#want.checkout = dest;
      await this.loadCheckouts(p, true);
      if (this.selectedProject()?.id === p.id) {
        const key = 'co:' + pathKey(dest, this.deps.platform);
        this.lists.git = selectKey(this.lists.git, this.gitItems(p), key, this.listRows('git'));
        this.onGitChanged();
      }
      this.flash(`Created worktree ${name} at ${dest}${exists ? ' (existing branch)' : ''}`);
    } catch (err) {
      this.error(`Cannot create the worktree: ${errorText(err)}`);
    }
  }

  deleteWorktree(): void {
    const p = this.selectedProject();
    const row = this.selectedGitRow();
    if (!p || row?.kind !== 'checkout') return;
    const co = row.checkout;
    if (co.isRoot) {
      this.flash('The root checkout cannot be deleted.');
      return;
    }
    const name = co.branch ?? path.basename(co.path);
    this.modal = {
      kind: 'confirm',
      state: createConfirm({
        title: 'Delete worktree',
        message: `Delete the worktree ${co.path}? Its files are deleted. The branch ${co.branch ?? '(detached)'} stays.`,
        yesLabel: 'Delete',
        noLabel: 'Keep',
        requireText: name,
      }),
      yes: () => void this.removeWorktree(p, co, name, false),
    };
  }

  async removeWorktree(p: Project, co: Checkout, name: string, force: boolean): Promise<void> {
    // A running program inside the folder blocks its removal on Windows.
    for (const pane of this.panes.list()) {
      if (samePath(pane.directory, co.path, this.deps.platform)) await this.panes.close(pane.sessionId);
    }
    this.flash(`Deleting worktree ${name}…`);
    try {
      await this.deps.git.removeWorktree(p, co.path, { force });
      this.statuses.delete(pathKey(co.path, this.deps.platform));
      await this.loadCheckouts(p, true);
      this.lists.git = reconcileList(this.lists.git, this.gitItems(), this.listRows('git'));
      this.onGitChanged();
      this.flash(`Deleted worktree ${name}.`);
    } catch (err) {
      const e = err as { stderr?: string };
      const text = `${errorText(err)} ${e.stderr ?? ''}`;
      if (!force && /modified or untracked|use --force|--force to delete|contains (modified|untracked)|is dirty|locked/i.test(text)) {
        this.modal = {
          kind: 'confirm',
          state: createConfirm({
            title: 'Force delete',
            message: `The worktree ${name} has changes (${errorText(err)}). Delete it anyway? The changes are lost.`,
            yesLabel: 'Force delete',
            noLabel: 'Keep',
          }),
          yes: () => void this.removeWorktree(p, co, name, true),
        };
        this.invalidate();
        return;
      }
      this.error(`Cannot delete the worktree: ${errorText(err)}`);
    }
  }

  async newSession(dir: string | null = this.checkoutPath): Promise<void> {
    if (!dir) {
      this.flash('Select a project first.');
      return;
    }
    if (!(await this.needService())) return;
    this.flash('Creating a session…');
    try {
      const id = await this.deps.tracker.create(dir);
      if (this.view === 'inbox') {
        this.focus = 'inbox';
        this.inbox.changed();
        this.inbox.select(id);
        const s = this.inbox.selected();
        if (s?.row.id === id) await this.openSession(s.row, true);
        else this.flash('Session created.');
        return;
      }
      this.#want.session = id;
      this.focus = 'sessions';
      this.onTrackerChange();
      const s = this.sessionRows().find((r) => r.id === id);
      if (s) {
        this.lists.sessions = selectKey(this.lists.sessions, this.sessionItems(), id, this.listRows('sessions'));
        this.onSessionChanged();
        await this.openSession(s, true);
      } else {
        this.flash('Session created.');
      }
    } catch (err) {
      this.error(`Cannot create the session: ${errorText(err)}`);
    }
  }

  /** Size the pane would have for this session right now. */
  paneSize(): { cols: number; rows: number } {
    let lay = this.layout();
    if (!lay.paneInner) {
      const { cols, rows } = this.deps.terminal.size();
      lay =
        this.view === 'inbox'
          ? computeInboxLayout({ cols, rows, width: this.deps.store.ui.inboxWidth, paneFocused: true, zoom: this.zoom })
          : computeLayout({ cols, rows, widths: this.deps.store.ui.columnWidths, paneFocused: true, zoom: this.zoom });
    }
    const inner = lay.paneInner as Rect;
    return { cols: Math.max(10, inner.w), rows: Math.max(4, inner.h) };
  }

  async openSession(s: SessionRow, focusPane: boolean): Promise<void> {
    if (this.panes.has(s.id)) {
      if (focusPane) this.enterPane();
      return;
    }
    if (this.panes.isOpening(s.id)) return;
    if (!(await this.needService())) return;
    if (this.panes.has(s.id) || this.panes.isOpening(s.id)) return;
    const { cols, rows } = this.paneSize();
    this.notes.delete(s.id);
    this.flash('Starting OpenCode…');
    const r = await this.panes.open(s.id, s.directory, cols, rows);
    if (r.ok) {
      this.message = null;
      if (r.warning) this.error(r.warning);
      this.recordPtyDirs();
      this.updateWatch();
      if (focusPane && this.selectedSession()?.id === s.id && !this.modal) this.enterPane();
      this.invalidate();
      return;
    }
    if (r.kind === 'unsupported') {
      this.flash(`The service has no usable PTY API (${r.message}); opening the full window instead.`);
      await this.runHandoff(s);
      return;
    }
    this.notes.set(s.id, this.deps.redact(r.message));
    this.error(r.message);
  }

  async runHandoff(s: SessionRow): Promise<void> {
    const plan = await this.deps.launcher.prepare();
    if (!plan.ok) {
      this.notes.set(s.id, this.deps.redact(plan.message));
      this.error(plan.message);
      return;
    }
    if (!plan.runnableHere) {
      const why = plan.shimNote ?? 'opencode: not found on PATH';
      this.error(`Cannot open the full window: ${why}`);
      return;
    }
    this.handingOff = true;
    let result: { code: number | null; error?: string };
    try {
      result = await handoff(this.deps.terminal, this.deps.runChild, plan.command, ['--session', s.id], s.directory);
    } finally {
      this.handingOff = false;
      this.#prev = null;
    }
    if (result.error) this.error(`opencode: ${result.error}`);
    else this.flash(`OpenCode ended (exit code ${result.code ?? '?'}).`);
    void this.deps.tracker.refresh().catch(() => {});
    this.invalidate();
  }

  renameSession(): void {
    const s = this.selectedSession();
    if (!s) return;
    this.modal = {
      kind: 'prompt',
      title: 'Rename session',
      label: 'New title:',
      input: createTextInput(s.title),
      submit: (v) => {
        const t = v.trim();
        if (!t) return;
        this.deps.tracker.rename(s.id, t).catch((err) => this.error(`Cannot rename: ${errorText(err)}`));
      },
    };
  }

  async archiveSession(mode: 'toggle' | 'unarchive'): Promise<void> {
    const s = this.selectedSession();
    if (!s) return;
    try {
      if (s.archived) {
        await this.deps.tracker.unarchive(s.id);
        this.flash(`Unarchived "${s.title}".`);
      } else if (mode === 'toggle') {
        await this.deps.tracker.archive(s.id);
        this.flash(this.view === 'inbox' ? `Archived "${s.title}"; it left the inbox.` : `Archived "${s.title}". A shows archived sessions.`);
      }
      this.sessionListChanged();
    } catch (err) {
      this.error(`Cannot archive: ${errorText(err)}`);
    }
  }

  deleteSession(): void {
    const s = this.selectedSession();
    if (!s) return;
    this.modal = {
      kind: 'confirm',
      state: createConfirm({
        title: 'Delete session',
        message: `Delete the session "${s.title || s.id}" in OpenCode? Its messages are deleted.`,
        yesLabel: 'Delete',
        noLabel: 'Keep',
      }),
      yes: () => {
        void (async () => {
          await this.panes.close(s.id);
          try {
            await this.deps.tracker.remove(s.id);
            this.deps.store.forgetSession(s.id);
            this.notes.delete(s.id);
            this.sessionListChanged();
            this.flash('Session deleted.');
          } catch (err) {
            this.error(`Cannot delete the session: ${errorText(err)}`);
          }
        })();
      },
    };
  }

  /** After an archive or a delete: the selection moves to the next row of the current view. */
  sessionListChanged(): void {
    if (this.view === 'inbox') {
      this.inbox.changed();
      this.inbox.reconcile();
      return;
    }
    this.lists.sessions = reconcileList(this.lists.sessions, this.sessionItems(), this.listRows('sessions'));
    this.onSessionChanged();
  }

  jumpAttention(dir: 1 | -1): void {
    const list = this.attentionList();
    if (list.length === 0) {
      this.flash('No sessions.');
      return;
    }
    const cur = this.selectedSession()?.id;
    const i = list.findIndex((e) => e.row.id === cur);
    const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    const target = list[next] as (typeof list)[number];
    this.selectSession(target.project, target.dir, target.row.id);
    this.focus = 'sessions';
  }

  /** Select a project, checkout and session together (from a jump or a later inbox view). */
  selectSession(project: Project, dir: string, sessionId: string): void {
    if (this.filter && !this.projectItems().some((it) => it.key === project.id)) this.setFilter('');
    const projectChanged = this.lists.projects.selectedKey !== project.id;
    this.lists.projects = selectKey(this.lists.projects, this.projectItems(), project.id, this.listRows('projects'));
    this.#want.checkout = dir;
    this.#want.session = sessionId;
    if (projectChanged) this.onProjectChanged();
    else this.afterCheckoutsLoaded(project);
    const key = 'co:' + pathKey(dir, this.deps.platform);
    this.lists.git = selectKey(this.lists.git, this.gitItems(project), key, this.listRows('git'));
    this.onGitChanged();
    if (this.#want.session === sessionId && this.sessionRows().some((r) => r.id === sessionId)) {
      this.lists.sessions = selectKey(this.lists.sessions, this.sessionItems(), sessionId, this.listRows('sessions'));
      this.#want.session = null;
    }
    this.onSessionChanged();
  }

  // ---- drawing -----------------------------------------------------------

  /** Ask for a frame. Frames are drawn at most about 60 times per second. */
  invalidate(): void {
    if (this.#drawTimer || this.quitting) return;
    const wait = Math.max(0, 16 - (this.deps.now() - this.#lastDraw));
    this.#drawTimer = setTimeout(() => {
      this.#drawTimer = null;
      this.draw();
    }, wait);
  }

  /** The last drawn frame (tests read it). */
  get frame(): Frame | null {
    return this.#frame;
  }

  /** Draw now and write the difference to the terminal. Returns the frame. */
  draw(): Frame {
    if (this.#drawTimer) {
      clearTimeout(this.#drawTimer);
      this.#drawTimer = null;
    }
    const { cols, rows } = this.deps.terminal.size();
    const f = createFrame(cols, rows);
    // Keep the list states valid for the current items and heights.
    if (this.view === 'inbox') this.inbox.reconcile();
    else {
      for (const col of COLUMNS as Array<'projects' | 'git' | 'sessions'>) {
        this.lists[col] = reconcileList(this.lists[col], this.itemsOf(col), this.listRows(col));
      }
    }
    const lay = this.layout();
    if (this.view === 'inbox') renderInbox(f, this, lay);
    else renderApp(f, this, lay);
    this.#scheduleFit(lay);
    this.#lastDraw = this.deps.now();
    this.#frame = f;
    if (!this.deps.terminal.suspended && !this.deps.terminal.closed) {
      const out = renderDiff(this.#prev, f, { depth: this.deps.depth ?? 'truecolor' });
      if (out) this.deps.terminal.write(out);
      this.#prev = f;
    }
    return f;
  }

  /** The visible pane is resized after a short pause, so a window drag sends one resize. */
  #scheduleFit(lay: AppLayout): void {
    const s = this.selectedSession();
    const pane = s ? this.panes.get(s.id) : undefined;
    const inner = lay.paneInner;
    if (!pane || !inner || inner.w < 1 || inner.h < 1) return;
    if (pane.cols === inner.w && pane.rows === inner.h) return;
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      const now = this.layout().paneInner;
      const cur = this.selectedSession();
      if (!now || !cur) return;
      if (this.panes.fit(cur.id, now.w, now.h)) this.invalidate();
    }, this.deps.resizeDebounceMs ?? 60);
  }

  /** Context of the footer and the help: where the keyboard is now. */
  context(): Context {
    if (this.modal?.kind === 'browser') return 'browser';
    return this.focus;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

export function createApp(deps: AppDeps): App {
  return new App(deps);
}

