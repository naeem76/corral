// Controller of the inbox view: one list of the sessions of all projects, in sections, with
// snooze and settle. The pane, the modals and the session actions stay in App; App asks
// `selectedSession()` here while the inbox view is shown.
//
// Marks (`SessionMarks`) are the program's own data in the store. The section rules are the
// pure functions in core/inbox.ts.

import type { InboxEntry, InboxInput, InboxSection, InputEvent, SessionRow } from '../../types.ts';
import { INBOX_SECTIONS, SNOOZE_UNTIL_INPUT } from '../../types.ts';
import { buildInbox, classify, formatSnooze, marksToClear, nextWake, SNOOZE_PRESETS, snoozeUntil } from '../../core/inbox.ts';
import { samePath } from '../../core/paths.ts';
import type { Rect } from '../frame.ts';
import { inset, rectContains } from '../widgets/layout.ts';
import {
  createListState, handleListInput, moveSelection, reconcileList, selectKey, viewRows,
  type ListItem, type ListState,
} from '../widgets/list.ts';
import { createMenu, type MenuItem } from '../widgets/menu.ts';
import type { ActionId } from './bindings.ts';
import { findAction, listContexts } from './bindings.ts';
import type { App } from './app.ts';

export type InboxItem =
  | { kind: 'header'; section: InboxSection; count: number; collapsed: boolean }
  | { kind: 'entry'; entry: InboxEntry };

export const SECTION_TITLES: Record<InboxSection, string> = {
  'needs-input': 'Needs input',
  working: 'Working',
  open: 'Open',
  snoozed: 'Snoozed',
  settled: 'Settled',
};

/** Longest pause between the two clicks of a double click (the same as in the columns). */
const DOUBLE_CLICK_MS = 400;

interface Snapshot {
  entries: InboxEntry[];
  byId: Map<string, InboxEntry>;
  items: ListItem<InboxItem>[];
  /** The entries are valid until this time (the next snooze end). */
  validUntil: number;
}

export class InboxView {
  readonly app: App;
  list: ListState;
  showSettled: boolean;
  /** A saved selection that waits for its session to appear (after a start or a switch). */
  #want: string | null;
  #snap: Snapshot | null = null;
  #lastClick: { key: string | null; at: number } | null = null;
  #lastSelected: string | null = null;

  constructor(app: App) {
    this.app = app;
    const ui = app.deps.store.ui;
    this.showSettled = ui.inboxShowSettled === true;
    const saved = typeof ui.inboxSelectedSessionId === 'string' ? ui.inboxSelectedSessionId : null;
    this.list = createListState(saved);
    this.#want = saved;
    this.#lastSelected = saved;
  }

  // ---- data ----------------------------------------------------------------

  /** Forget the computed list; the next read builds it again. Call after any data change. */
  changed(): void {
    this.#snap = null;
  }

  /** Every top-level, non-archived session in the folders of the registered projects. */
  inputs(): InboxInput[] {
    const { store, tracker, platform } = this.app.deps;
    const out: InboxInput[] = [];
    const seen = new Set<string>();
    for (const project of store.projects) {
      const checkouts = this.app.checkoutsOf(project);
      for (const dir of this.app.projectDirs(project)) {
        const checkout = checkouts.find((c) => samePath(c.path, dir, platform));
        for (const row of tracker.rows(dir)) {
          if (row.archived || seen.has(row.id)) continue;
          seen.add(row.id);
          const t = tracker.get(row.id)?.time;
          const activity = Math.max(t?.busy ?? 0, t?.idle ?? 0);
          const input: InboxInput = { row, activity, marks: { ...(store.sessionMeta(row.id) ?? {}) }, project };
          if (checkout) input.checkout = checkout;
          out.push(input);
        }
      }
    }
    return out;
  }

  #snapshot(): Snapshot {
    const now = this.app.deps.now();
    if (this.#snap && now < this.#snap.validUntil) return this.#snap;
    const entries = buildInbox(this.inputs(), now);
    const byId = new Map(entries.map((e) => [e.row.id, e]));
    const items: ListItem<InboxItem>[] = [];
    for (const section of INBOX_SECTIONS) {
      const list = entries.filter((e) => e.section === section);
      if (list.length === 0) continue;
      const collapsed = section === 'settled' && !this.showSettled;
      items.push({ key: `section:${section}`, header: true, data: { kind: 'header', section, count: list.length, collapsed } });
      if (collapsed) continue;
      for (const entry of list) items.push({ key: entry.row.id, data: { kind: 'entry', entry } });
    }
    this.#snap = { entries, byId, items, validUntil: nextWake(entries, now) ?? Infinity };
    return this.#snap;
  }

  entries(): InboxEntry[] {
    return this.#snapshot().entries;
  }

  items(): ListItem<InboxItem>[] {
    return this.#snapshot().items;
  }

  entry(id: string): InboxEntry | undefined {
    return this.#snapshot().byId.get(id);
  }

  /**
   * The inbox entry of a session row, also for a session outside the inbox list. The projects
   * view uses it for single rows, so it does not build the whole list there.
   */
  entryFor(row: SessionRow): InboxEntry | undefined {
    const known = this.app.view === 'inbox' ? this.entry(row.id) : undefined;
    if (known) return known;
    const project = this.app.deps.store.projects.find((p) => this.app.projectDirs(p).some((d) => samePath(d, row.directory, this.app.deps.platform)));
    if (!project) return undefined;
    const t = this.app.deps.tracker.get(row.id)?.time;
    const marks = { ...(this.app.deps.store.sessionMeta(row.id) ?? {}) };
    return classify({ row, activity: Math.max(t?.busy ?? 0, t?.idle ?? 0), marks, project }, this.app.deps.now());
  }

  /** Time when a snooze ends next (the view must change then), or null. */
  nextWake(): number | null {
    const s = this.#snapshot();
    return Number.isFinite(s.validUntil) ? s.validUntil : null;
  }

  /** Store the mark changes the pure rules cannot express (a request for input ends a snooze). */
  applyMarkRules(): void {
    for (const c of marksToClear(this.entries(), this.app.deps.now())) this.app.deps.store.setSessionMeta(c.id, c.patch);
  }

  // ---- selection -----------------------------------------------------------

  listRect(lay = this.app.layout()): Rect {
    return lay.list ? inset(lay.list, 1) : { x: 0, y: 0, w: 0, h: 0 };
  }

  rows(): number {
    return viewRows(this.listRect().h);
  }

  /** The selected entry, when its row is visible in the list. */
  selected(): InboxEntry | undefined {
    const key = this.list.selectedKey;
    if (!key) return undefined;
    const it = this.items().find((i) => i.key === key);
    return it?.data.kind === 'entry' ? it.data.entry : undefined;
  }

  /** Make the list state valid for the current items; tell App when the selection changed. */
  reconcile(): void {
    const items = this.items();
    const want = this.#want;
    if (want && items.some((it) => it.key === want)) {
      this.list = selectKey(this.list, items, want, this.rows());
      this.#want = null;
    } else if (want) {
      // Keep the wanted key until its session is loaded (no fallback selection is saved).
      this.list = reconcileList(this.list, items, this.rows());
      return;
    } else this.list = reconcileList(this.list, items, this.rows());
    if (this.list.selectedKey !== this.#lastSelected) this.selectionChanged();
  }

  /** Select a session (when it is in the list); else keep it as wanted. */
  select(id: string): void {
    const items = this.items();
    if (items.some((it) => it.key === id)) {
      this.#want = null;
      this.list = selectKey(this.list, items, id, this.rows());
      this.selectionChanged();
    } else this.#want = id;
  }

  selectionChanged(): void {
    const key = this.list.selectedKey;
    this.#lastSelected = key;
    const s = this.selected();
    if (s) this.app.panes.touch(s.row.id);
    if (key !== null || this.#want === null) this.app.deps.store.setUi({ inboxSelectedSessionId: key });
    if (this.app.focus === 'pane' && (!s || !this.app.panes.has(s.row.id))) this.app.focus = 'inbox';
  }

  #userMoved(): void {
    this.#want = null;
    this.selectionChanged();
  }

  // ---- input ---------------------------------------------------------------

  handleEvent(ev: InputEvent): void {
    if (ev.type === 'mouse') {
      this.handleMouse(ev);
      return;
    }
    if (ev.type !== 'key') return;
    const action = findAction(this.app.bindings, listContexts('inbox'), ev);
    if (action) {
      this.app.run(action);
      return;
    }
    const before = this.list.selectedKey;
    const r = handleListInput(this.list, this.items() as ListItem<unknown>[], ev, this.listRect());
    this.list = r.state;
    if (r.state.selectedKey !== before) this.#userMoved();
  }

  handleMouse(ev: Extract<InputEvent, { type: 'mouse' }>): void {
    const lay = this.app.layout();
    if (lay.list && rectContains(lay.list, ev.x, ev.y)) {
      const before = this.list.selectedKey;
      const r = handleListInput(this.list, this.items() as ListItem<unknown>[], ev, this.listRect(lay));
      this.list = r.state;
      if (r.state.selectedKey !== before) this.#userMoved();
      if (ev.action !== 'down' || ev.button !== 'left') return;
      // One click selects. A second click on the same row acts as Enter.
      const key = this.list.selectedKey;
      const onRow = r.activated || key !== before;
      const now = this.app.deps.now();
      const last = this.#lastClick;
      const double = r.activated && last !== null && last.key === key && now - last.at <= DOUBLE_CLICK_MS;
      this.#lastClick = onRow && !double ? { key, at: now } : null;
      if (double) this.open();
      return;
    }
    if (lay.pane && rectContains(lay.pane, ev.x, ev.y) && ev.action === 'down' && ev.button === 'left') {
      const s = this.selected();
      if (s && this.app.panes.has(s.row.id)) this.app.enterPane();
    }
  }

  /** Actions of the inbox context. False when App handles the action itself. */
  run(action: ActionId): boolean {
    switch (action) {
      case 'enter':
        this.open();
        return true;
      case 'inbox-pane': {
        const s = this.selected();
        if (s && this.app.panes.has(s.row.id)) this.app.enterPane();
        else if (s) this.app.flash('Press Enter to open the session in the pane.');
        return true;
      }
      case 'half-down':
      case 'half-up': {
        const rows = this.rows();
        const d = Math.max(1, Math.floor(rows / 2)) * (action === 'half-down' ? 1 : -1);
        const before = this.list.selectedKey;
        this.list = moveSelection(this.list, this.items(), d, rows);
        if (this.list.selectedKey !== before) this.#userMoved();
        return true;
      }
      case 'inbox-show-settled':
        this.showSettled = !this.showSettled;
        this.app.deps.store.setUi({ inboxShowSettled: this.showSettled });
        this.changed();
        this.reconcile();
        this.app.flash(this.showSettled ? 'Showing settled sessions.' : 'Settled sessions hidden. E shows them.');
        return true;
      case 'next-attention':
      case 'prev-attention':
        this.jump(action === 'next-attention' ? 1 : -1);
        return true;
      case 'inbox-goto':
        this.goto();
        return true;
      case 'session-new': {
        const s = this.selected();
        if (!s) {
          this.app.flash('Select a session first, or use the projects view (v) to start one in a project.');
          return true;
        }
        void this.app.newSession(s.row.directory);
        return true;
      }
      default:
        return false;
    }
  }

  open(): void {
    const s = this.selected();
    if (!s) return;
    void this.app.openSession(s.row, true);
  }

  /** Entries that want attention, in list order: needs input, then unseen or back. */
  attention(): InboxEntry[] {
    const all = this.entries();
    return [
      ...all.filter((e) => e.section === 'needs-input'),
      ...all.filter((e) => e.section === 'open' && (e.woke || e.row.status === 'unseen')),
    ];
  }

  jump(dir: 1 | -1): void {
    const list = this.attention();
    if (list.length === 0) {
      this.app.flash('No session needs attention.');
      return;
    }
    const cur = this.list.selectedKey;
    const i = list.findIndex((e) => e.row.id === cur);
    const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    this.select((list[next] as InboxEntry).row.id);
  }

  goto(): void {
    const s = this.selected();
    if (!s) {
      this.app.switchView('projects');
      return;
    }
    this.app.switchView('projects', s);
  }

  // ---- marks ---------------------------------------------------------------

  /** The snooze menu for a session (from the inbox or the Sessions column). */
  snoozeMenu(row: SessionRow): void {
    const e = this.entryFor(row);
    if (row.status === 'needs-input') {
      this.app.flash('This session needs input; a snooze would end at once.');
      return;
    }
    const now = this.app.deps.now();
    const choices: Array<MenuItem & { run: () => void }> = SNOOZE_PRESETS.map((p) => {
      const until = snoozeUntil(p.id, now);
      return {
        key: p.key,
        label: p.label,
        detail: p.id === 'input' ? '' : formatSnooze(until, now).replace(/^until /, ''),
        run: () => this.snooze(row, until),
      };
    });
    const snoozed = e?.marks.snoozedUntil !== undefined && e.marks.snoozedUntil > now;
    if (snoozed) choices.push({ key: 'u', label: 'Remove the snooze', detail: '', run: () => this.unmark(row) });
    const title = row.title.trim() || '(untitled)';
    const note = snoozed ? `Snoozed ${formatSnooze(e!.marks.snoozedUntil as number, now)}.` : `Hide "${title}" until:`;
    this.app.modal = {
      kind: 'menu',
      state: createMenu('Snooze', choices.map(({ key, label, detail }) => ({ key, label, detail })), note),
      choose: (i) => choices[i]?.run(),
    };
  }

  snooze(row: SessionRow, until: number): void {
    this.app.deps.store.setSessionMeta(row.id, { snoozedUntil: until, settledAt: undefined });
    this.#afterMark();
    const now = this.app.deps.now();
    this.app.flash(until >= SNOOZE_UNTIL_INPUT ? 'Snoozed until it needs input. u removes the snooze.' : `Snoozed ${formatSnooze(until, now)}. u removes the snooze.`);
  }

  /** Settle, or unsettle when the session is settled now. */
  toggleSettle(row: SessionRow): void {
    const e = this.entryFor(row);
    if (e?.section === 'settled') {
      this.app.deps.store.setSessionMeta(row.id, { settledAt: undefined });
      this.#afterMark();
      this.app.flash('Unsettled.');
      return;
    }
    if (row.status === 'needs-input' || row.status === 'working') {
      this.app.flash(row.status === 'working' ? 'The session is working; settle it when the turn ends.' : 'The session needs input; answer it first.');
      return;
    }
    // Not earlier than the last activity: the service clock can be ahead of this machine.
    const at = Math.max(this.app.deps.now(), e?.activity ?? 0);
    this.app.deps.store.setSessionMeta(row.id, { settledAt: at, snoozedUntil: undefined });
    this.app.deps.tracker.markSeen(row.id);
    this.#afterMark();
    this.app.flash(this.app.view === 'inbox' && !this.showSettled ? 'Settled. E shows the Settled section.' : 'Settled.');
  }

  /** Back to Open: remove the snooze or the settle mark. */
  unmark(row: SessionRow): void {
    const m = this.app.deps.store.sessionMeta(row.id);
    if (m?.snoozedUntil === undefined && m?.settledAt === undefined) {
      this.app.flash('The session has no snooze and no settle mark.');
      return;
    }
    this.app.deps.store.setSessionMeta(row.id, { snoozedUntil: undefined, settledAt: undefined });
    this.#afterMark();
    this.app.flash(m.snoozedUntil !== undefined ? 'Snooze removed.' : 'Settle mark removed.');
  }

  /** The user opened the session: an ended snooze has done its job. */
  opened(id: string): void {
    const until = this.app.deps.store.sessionMeta(id)?.snoozedUntil;
    if (until !== undefined && until <= this.app.deps.now()) this.app.deps.store.setSessionMeta(id, { snoozedUntil: undefined });
  }

  #afterMark(): void {
    this.changed();
    if (this.app.view === 'inbox') this.reconcile();
    this.app.invalidate();
  }
}
