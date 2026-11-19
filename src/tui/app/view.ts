// Drawing of the projects view: three columns, the pane (or the information panel), the
// footer and the modals. Reads the App state; changes nothing but list scroll positions.
// The pane, the information panel, the footer and the modals are shared with the inbox view
// (view-inbox.ts).

import path from 'node:path';
import type { SessionRow, SessionStatus } from '../../types.ts';
import { AGENT_NAMES } from '../../types.ts';
import { truncate, truncateStart, wrapText, type Frame, type Rect } from '../frame.ts';
import { defaultTheme, statusDot, style, withStyle, type Style } from '../style.ts';
import { stringWidth } from '../../width.ts';
import { inset } from '../widgets/layout.ts';
import { renderList, type ListItem } from '../widgets/list.ts';
import { drawModal, renderConfirm } from '../widgets/modal.ts';
import { renderMenu } from '../widgets/menu.ts';
import { renderTextInput } from '../widgets/textinput.ts';
import { drawHighlighted } from '../widgets/fuzzy.ts';
import { footerHints, helpLines } from './bindings.ts';
import { entryPath } from './browser.ts';
import { clean, relativeTime, tildify } from './format.ts';
import { formatSnooze, formatTime } from '../../core/inbox.ts';
import { SECTION_TITLES } from './inbox-view.ts';
import type { App, GitRow } from './app.ts';
import { agentHelpLines, agentMode, agentTag, emptySessionsText, INSTALL_HINT, openHint, opencodeDown, serviceBadge } from './agents.ts';
import type { AppLayout } from './layout.ts';

const th = defaultTheme;
export const STATUS_TEXT: Record<SessionStatus, string> = {
  'needs-input': 'needs input',
  working: 'working',
  unseen: 'finished, not seen yet',
  idle: 'idle',
};

export function onBg(st: Style, bg: Style | null): Style {
  return bg ? withStyle(st, { bg: bg.bg }) : st;
}

export function renderApp(f: Frame, app: App, lay: AppLayout): void {
  f.clear();
  if (lay.columns) {
    drawProjects(f, app, lay.columns[0]);
    drawGit(f, app, lay.columns[1]);
    drawSessions(f, app, lay.columns[2]);
  }
  if (lay.pane) drawPane(f, app, lay);
  drawFooter(f, app, lay.footer);
  drawModalLayer(f, app, lay.screen);
}

export function columnBox(f: Frame, r: Rect, title: string, focused: boolean): void {
  f.box(r.x, r.y, r.w, r.h, focused ? th.borderFocusedStyle : th.borderStyle, title, {
    border: th.border,
    titleStyle: focused ? th.titleFocusedStyle : th.titleStyle,
  });
}

export function dotAt(f: Frame, x: number, y: number, status: SessionStatus | null, bg: Style | null): void {
  if (!status) return;
  const d = statusDot(status);
  f.put(x, y, d.glyph, onBg(d.style, bg));
}

// ---- Projects --------------------------------------------------------------

function drawProjects(f: Frame, app: App, outer: Rect): void {
  const focused = app.focus === 'projects' && !app.modal;
  const items = app.projectItems();
  const total = app.deps.store.projects.length;
  const title = app.filter ? `Projects ${items.length}/${total}` : 'Projects';
  columnBox(f, outer, title, focused);
  const list = app.listRect('projects');
  const sel = focused ? th.selection : th.selectionDim;
  renderList(f, list, items, app.lists.projects, {
    focused,
    rowHeight: 1,
    selectedStyle: sel,
    scrollbar: { x: outer.x + outer.w - 1, style: th.scrollThumb },
    empty: { text: total === 0 ? 'No projects: press n' : 'No match.', style: th.dim },
    renderRow: (fr, r, item, info) => {
      const bg = info.selected ? sel : null;
      const p = item.data.project;
      if (info.selected && focused) fr.put(r.x, r.y, '▌', onBg(th.borderFocusedStyle, bg));
      dotAt(fr, r.x + 1, r.y, app.statusOfProject(p), bg);
      fr.put(r.x + 3, r.y, p.kind === 'git' ? '◆' : '◇', onBg(p.kind === 'git' ? style(6) : th.dim, bg));
      const x = r.x + 5;
      drawHighlighted(fr, x, r.y, truncate(clean(p.name), r.x + r.w - x), item.data.positions, onBg(th.text, bg), onBg(th.match, bg), r.x + r.w - x);
    },
  });
  if (app.filterEditing || app.filter) {
    const y = outer.y + outer.h - 2;
    const r: Rect = { x: outer.x + 1, y, w: outer.w - 2, h: 1 };
    f.text(r.x, y, '/', th.footerKey);
    app.filterInput = renderTextInput(f, { x: r.x + 1, y, w: r.w - 1, h: 1 }, app.filterEditing ? app.filterInput : { ...app.filterInput, value: app.filter }, {
      focused: app.filterEditing && !app.modal,
      style: app.filterEditing ? th.input : th.dim,
    });
  }
}

// ---- Git -------------------------------------------------------------------

function drawGit(f: Frame, app: App, outer: Rect): void {
  const focused = app.focus === 'git' && !app.modal;
  const p = app.selectedProject();
  columnBox(f, outer, 'Git', focused);
  const list = app.listRect('git');
  const items = app.gitItems(p);
  const cache = p ? app.checkouts.get(p.id) : undefined;
  const sel = focused ? th.selection : th.selectionDim;
  const home = app.deps.homedir;
  const platform = app.deps.platform;
  renderList(f, list, items, app.lists.git, {
    focused,
    rowHeight: 2,
    selectedStyle: sel,
    scrollbar: { x: outer.x + outer.w - 1, style: th.scrollThumb },
    empty: { text: !p ? 'Select a project.' : cache?.loading || !cache ? 'Loading…' : 'Nothing here.', style: th.dim },
    renderRow: (fr, r, item: ListItem<GitRow>, info) => {
      const bg = info.selected ? sel : null;
      const row = item.data;
      if (row.kind === 'pr-header') {
        fr.text(r.x + 1, r.y, `PULL REQUESTS · ${row.count}`, th.header, r.w - 1);
        return;
      }
      if (info.selected && focused) {
        fr.put(r.x, r.y, '▌', onBg(th.borderFocusedStyle, bg));
        fr.put(r.x, r.y + 1, '▌', onBg(th.borderFocusedStyle, bg));
      }
      if (row.kind === 'pr') {
        const pr = row.pr;
        fr.put(r.x + 1, r.y, '↗', onBg(style(2), bg));
        const t = `#${pr.id} ${clean(pr.title)}${pr.status === 'draft' ? ' (draft)' : ''}`;
        fr.text(r.x + 3, r.y, truncate(t, r.w - 3), onBg(th.text, bg));
        fr.text(r.x + 3, r.y + 1, truncate(`${clean(pr.sourceBranch)} → ${clean(pr.targetBranch)} · ${clean(pr.author)}`, r.w - 3), onBg(th.dim, bg));
        return;
      }
      const co = row.checkout;
      dotAt(fr, r.x + 1, r.y, app.statusOfDir(co.path), bg);
      let x = r.x + 3;
      if (co.isRoot) x = fr.text(x, r.y, '⌂ ', onBg(style(6), bg));
      let name: string;
      if (p?.kind === 'dir') name = path[platform === 'win32' ? 'win32' : 'posix'].basename(co.path) || co.path;
      else name = co.branch ? clean(co.branch) : `(detached${co.head ? ' ' + co.head : ''})`;
      let marks = '';
      if (co.dirty) marks += ' *';
      if (co.ahead) marks += ` ↑${co.ahead}`;
      if (co.behind) marks += ` ↓${co.behind}`;
      if (co.locked) marks += ' locked';
      if (co.prunable) marks += ' prunable';
      const room = r.x + r.w - x;
      const nameW = Math.max(1, room - stringWidth(marks));
      x = fr.text(x, r.y, truncate(name, nameW), onBg(th.text, bg));
      if (marks) fr.text(x, r.y, marks, onBg(co.dirty ? style(3) : th.dim, bg), r.x + r.w - x);
      fr.text(r.x + 3, r.y + 1, truncateStart(tildify(co.path, home, platform), r.w - 3), onBg(th.dim, bg));
    },
  });
  if (cache?.error) f.text(list.x + 1, list.y + list.h - 1, truncate(`git: ${cache.error}`, list.w - 1), th.danger);
}

// ---- Sessions --------------------------------------------------------------

function drawSessions(f: Frame, app: App, outer: Rect): void {
  const focused = app.focus === 'sessions' && !app.modal;
  const title = app.showArchived ? 'Sessions (all)' : 'Sessions';
  columnBox(f, outer, title, focused);
  const list = app.listRect('sessions');
  const items = app.sessionItems();
  const sel = focused ? th.selection : th.selectionDim;
  const now = app.deps.now();
  renderList(f, list, items, app.lists.sessions, {
    focused,
    rowHeight: 1,
    selectedStyle: sel,
    scrollbar: { x: outer.x + outer.w - 1, style: th.scrollThumb },
    empty: { text: emptySessionsText(app), style: th.dim },
    renderRow: (fr, r, item: ListItem<SessionRow>, info) => {
      const bg = info.selected ? sel : null;
      const s = item.data;
      if (info.selected && focused) fr.put(r.x, r.y, '▌', onBg(th.borderFocusedStyle, bg));
      dotAt(fr, r.x + 1, r.y, s.status, bg);
      const live = app.panes.has(s.id);
      const time = relativeTime(s.updated, now);
      const tag = markTag(app, s);
      const agent = agentTag(app, s);
      const right = (live ? '▸ ' : '') + (agent ? agent + ' ' : '') + (tag ? tag + ' ' : '') + time;
      const rw = stringWidth(right);
      const t = clean(s.title) || 'New session';
      fr.text(r.x + 3, r.y, truncate(t, Math.max(1, r.w - 4 - rw)), onBg(s.archived || !s.title ? th.dim : th.text, bg));
      fr.text(r.x + r.w - rw, r.y, right, onBg(th.dim, bg));
    },
  });
}

/** The inbox mark of a row in the Sessions column: an active snooze or an effective settle. */
function markTag(app: App, s: SessionRow): string {
  const m = app.deps.store.sessionMeta(s.id);
  if (!m || (m.snoozedUntil === undefined && m.settledAt === undefined)) return '';
  const section = app.inbox.entryFor(s)?.section;
  return section === 'snoozed' ? th.glyphs.snoozed : section === 'settled' ? th.glyphs.settled : '';
}

// ---- Pane ------------------------------------------------------------------

export function drawPane(f: Frame, app: App, lay: AppLayout): void {
  const outer = lay.pane as Rect;
  const inner = lay.paneInner as Rect;
  const s = app.selectedSession();
  const pane = s ? app.panes.get(s.id) : undefined;
  const focused = app.focus === 'pane' && !app.modal;
  if (pane && s) {
    if (!lay.paneBare) {
      const title = `${clean(s.title) || 'New session'}${focused ? '' : ' · Enter or Tab focuses'}`;
      f.box(outer.x, outer.y, outer.w, outer.h, focused ? th.borderFocusedStyle : th.borderStyle, title, {
        border: th.border,
        titleStyle: focused ? th.titleFocusedStyle : th.titleStyle,
      });
    }
    f.pushClip(inner);
    f.blit(pane.emulator, inner.x, inner.y, Math.min(inner.w, pane.emulator.cols), Math.min(inner.h, pane.emulator.rows));
    f.popClip();
    const c = pane.emulator.cursor;
    if (focused && c.visible && c.x < inner.w && c.y < inner.h) f.setCursor(inner.x + c.x, inner.y + c.y, true);
    return;
  }
  drawInfoPanel(f, app, outer, s);
}

function drawInfoPanel(f: Frame, app: App, outer: Rect, s: SessionRow | undefined): void {
  f.box(outer.x, outer.y, outer.w, outer.h, th.borderStyle, s ? clean(s.title) || 'New session' : 'Session', { border: th.border, titleStyle: th.titleStyle });
  const r = inset(outer, 1, 2);
  f.pushClip(r);
  let y = r.y + 1;
  const line = (text: string, st: Style = th.text): void => {
    for (const l of wrapText(text, r.w)) {
      if (y >= r.y + r.h) return;
      f.text(r.x, y++, l, st, r.w);
    }
  };
  const mode = agentMode(app);
  // Without Copilot, a dead service leaves nothing to show; with it, only OpenCode rows suffer.
  const down = opencodeDown(app);
  if (down && (mode !== 'both' || s?.agent !== 'copilot')) {
    line('The OpenCode service is not available.', th.danger);
    if (app.serviceError) line(app.serviceError, th.muted);
    y++;
    line('Run "node src/main.ts doctor" for details. This program retries in the background.', th.dim);
    if (mode === 'both' && !s) {
      y++;
      line('Copilot sessions work without it (they open in the full window).', th.dim);
    }
    if (mode !== 'both' || !s) {
      f.popClip();
      return;
    }
    y++;
  }
  if (mode === 'none') {
    line('No agent found on this machine.', th.danger);
    y++;
    line(INSTALL_HINT, th.dim);
    line('Run "node src/main.ts doctor" for details.', th.dim);
    f.popClip();
    return;
  }
  if (!s) {
    const p = app.selectedProject();
    if (app.view === 'inbox') line('Select a session in the list. v switches to the projects view.', th.dim);
    else line(p ? 'Select a session, or press n in the Sessions column for a new one.' : 'Add a project with n (or o from any column).', th.dim);
    f.popClip();
    return;
  }
  const now = app.deps.now();
  line(clean(s.title) || '(no title)', th.titleFocusedStyle);
  y++;
  f.text(r.x, y, 'Agent     ', th.dim);
  f.text(r.x + 10, y++, AGENT_NAMES[s.agent], th.text, r.w - 10);
  f.text(r.x, y, 'Status    ', th.dim);
  dotAt(f, r.x + 10, y, s.status, null);
  f.text(r.x + 12, y++, STATUS_TEXT[s.status] + (s.archived ? ' (archived)' : ''), th.text, r.w - 12);
  f.text(r.x, y, 'Directory ', th.dim);
  f.text(r.x + 10, y++, truncateStart(tildify(s.directory, app.deps.homedir, app.deps.platform), r.w - 10), th.text);
  f.text(r.x, y, 'Updated   ', th.dim);
  f.text(r.x + 10, y++, `${relativeTime(s.updated, now)} ago`.replace('now ago', 'just now'), th.text, r.w - 10);
  f.text(r.x, y, 'Session   ', th.dim);
  f.text(r.x + 10, y++, s.id, th.dim, r.w - 10);
  const inbox = inboxText(app, s, now);
  if (inbox) {
    f.text(r.x, y, 'Inbox     ', th.dim);
    f.text(r.x + 10, y++, inbox, th.text, r.w - 10);
  }
  y++;
  const note = app.notes.get(s.id) ?? app.panes.exitReason(s.id);
  if (note) {
    line(note, th.danger);
    y++;
  }
  if (app.panes.isOpening(s.id)) line(`Starting ${AGENT_NAMES[s.agent]}…`, th.muted);
  else line(openHint(app, s), th.muted);
  f.popClip();
}

/** The inbox section of a session with its snooze or settle time, for the information panel. */
function inboxText(app: App, s: SessionRow, now: number): string {
  const e = app.inbox.entryFor(s);
  if (!e) return '';
  const m = e.marks;
  let t = SECTION_TITLES[e.section];
  if (e.section === 'snoozed' && m.snoozedUntil !== undefined) t += ` ${formatSnooze(m.snoozedUntil, now)}`;
  else if (e.section === 'settled' && m.settledAt !== undefined) t += ` since ${formatTime(m.settledAt, now)}`;
  else if (m.settledAt !== undefined) t += ` (settled ${formatTime(m.settledAt, now)}; active since)`;
  if (e.woke && m.snoozedUntil !== undefined) t += ` · back: the snooze ended ${formatTime(m.snoozedUntil, now)}`;
  return t;
}

// ---- Footer ----------------------------------------------------------------

export function drawFooter(f: Frame, app: App, r: Rect): void {
  const badge = serviceBadge(app);
  const bw = stringWidth(badge.text);
  const right = r.x + r.w - bw - 1;
  f.text(Math.max(r.x, right), r.y, badge.text, badge.style);
  const room = Math.max(0, right - r.x - 2);
  const m = app.message;
  const age = m ? app.deps.now() - m.at : Infinity;
  if (m && age < (m.error ? 12_000 : 5_000)) {
    f.text(r.x + 1, r.y, truncate(m.text, room), m.error ? th.danger : th.muted);
    return;
  }
  let x = r.x + 1;
  const limit = r.x + 1 + room;
  for (const h of footerHints(app.bindings, app.context())) {
    const need = stringWidth(h.key) + 1 + stringWidth(h.label) + 2;
    if (x + need > limit) break;
    x = f.text(x, r.y, h.key, th.footerKey);
    x = f.text(x + 1, r.y, h.label, th.footerText) + 2;
  }
}

// ---- Modals ----------------------------------------------------------------

export function drawModalLayer(f: Frame, app: App, screen: Rect): void {
  const m = app.modal;
  if (!m) return;
  switch (m.kind) {
    case 'confirm':
      m.state = renderConfirm(f, screen, m.state, th);
      return;
    case 'menu':
      m.state = renderMenu(f, screen, m.state, th);
      return;
    case 'prompt': {
      const width = Math.min(70, Math.max(30, screen.w - 4));
      const lines = wrapText(m.label, width - 4);
      const errLines = m.error ? wrapText(m.error, width - 4) : [];
      const height = lines.length + 4 + (errLines.length ? errLines.length + 1 : 0);
      drawModal(f, screen, { title: m.title, width, height, theme: th }, (fr, inner) => {
        let y = inner.y;
        for (const l of lines) fr.text(inner.x, y++, l, th.dim, inner.w);
        m.input = renderTextInput(fr, { x: inner.x, y: y + 1, w: inner.w, h: 1 }, m.input, { focused: true, style: th.selection });
        y += 3;
        for (const l of errLines) fr.text(inner.x, y++, l, th.danger, inner.w);
      });
      return;
    }
    case 'help': {
      const lines = [...helpLines(app.bindings), {}, ...agentHelpLines(app)];
      const width = Math.min(96, screen.w - 2);
      const height = Math.min(lines.length + 3, screen.h - 1);
      const view = height - 3;
      m.scroll = Math.max(0, Math.min(m.scroll, lines.length - view));
      drawModal(f, screen, { title: 'Keys', width, height, theme: th }, (fr, inner) => {
        const kw = 18;
        for (let i = 0; i < view && i + m.scroll < lines.length; i++) {
          const l = lines[i + m.scroll] as { heading?: string; key?: string; text?: string };
          const y = inner.y + i;
          if (l.heading) fr.text(inner.x, y, l.heading.toUpperCase(), th.header, inner.w);
          else if (l.key !== undefined) {
            fr.text(inner.x, y, truncate(l.key, kw - 1), th.footerKey);
            fr.text(inner.x + kw, y, truncate(l.text ?? '', inner.w - kw), th.text);
          }
        }
        fr.text(inner.x, inner.y + inner.h - 1, 'Any other key closes. ↑/↓ scroll.', th.dim, inner.w);
      });
      return;
    }
    case 'browser': {
      const s = m.state;
      const rows = app.browserRows();
      const width = Math.min(100, Math.max(40, screen.w - 4));
      drawModal(f, screen, { title: 'Add project', width, height: rows + 6, theme: th }, (fr, inner) => {
        fr.text(inner.x, inner.y, 'Folder (Git or not). ● marks a Git repository.', th.dim, inner.w);
        m.state = { ...s, input: renderTextInput(fr, { x: inner.x, y: inner.y + 1, w: inner.w, h: 1 }, s.input, { focused: true, style: th.selection }) };
        const top = s.scrollTop;
        const ly = inner.y + 3;
        if (s.notice) fr.text(inner.x, inner.y + 2, truncate(s.notice, inner.w), th.danger);
        if (s.error) fr.text(inner.x, ly, truncate(s.error, inner.w), th.danger);
        else if (s.loading) fr.text(inner.x, ly, 'Reading…', th.dim);
        else if (s.entries.length === 0) fr.text(inner.x, ly, s.base ? 'No folder matches. Enter adds the typed path.' : 'No sub-folders.', th.dim, inner.w);
        for (let i = 0; i < rows && !s.error; i++) {
          const e = s.entries[top + i];
          if (!e) break;
          const y = ly + i;
          const picked = top + i === s.picked;
          const bg = picked ? th.selection : null;
          if (picked) fr.fillRect(inner.x, y, inner.w, 1, th.selection);
          const full = entryPath(s, e, { platform: app.deps.platform, homedir: app.deps.homedir });
          if (s.git.get(full)) fr.put(inner.x, y, '●', onBg(style(6), bg));
          drawHighlighted(fr, inner.x + 2, y, truncate(clean(e.name), inner.w - 3), e.positions, onBg(th.text, bg), onBg(th.match, bg), inner.w - 3);
        }
        if (s.entries.length > rows) fr.text(inner.x, inner.y + inner.h - 1, `${s.entries.length} folders`, th.dim, inner.w);
      });
      return;
    }
  }
}

