// Drawing of the inbox view: one list of sessions in sections at the left, the pane (or the
// information panel) at the right, the footer and the modals (shared with the projects view).

import path from 'node:path';
import type { InboxEntry } from '../../types.ts';
import { formatSnooze } from '../../core/inbox.ts';
import { truncate, wrapText, type Frame, type Rect } from '../frame.ts';
import { defaultTheme, style, type Style } from '../style.ts';
import { stringWidth } from '../../width.ts';
import { inset } from '../widgets/layout.ts';
import { renderList, type ListItem } from '../widgets/list.ts';
import { clean, relativeTime } from './format.ts';
import { SECTION_TITLES, type InboxItem } from './inbox-view.ts';
import type { App } from './app.ts';
import type { AppLayout } from './layout.ts';
import { columnBox, dotAt, drawFooter, drawModalLayer, drawPane, onBg } from './view.ts';
import { agentTag, emptyInboxText } from './agents.ts';

const th = defaultTheme;
/** Below this many cells for the title, the project part of a row is dropped. */
const MIN_TITLE = 12;

export function renderInbox(f: Frame, app: App, lay: AppLayout): void {
  f.clear();
  if (lay.list) drawInboxList(f, app, lay.list);
  if (lay.pane) drawPane(f, app, lay);
  drawFooter(f, app, lay.footer);
  drawModalLayer(f, app, lay.screen);
}

interface Part {
  text: string;
  style: Style;
}

/** Project, plus the branch (or folder name) of a worktree that is not the root. */
export function placeText(e: InboxEntry, platform: NodeJS.Platform): string {
  const name = clean(e.project.name);
  const co = e.checkout;
  if (!co || co.isRoot) return name;
  const branch = co.branch ?? path[platform === 'win32' ? 'win32' : 'posix'].basename(co.path);
  return `${name} · ${clean(branch)}`;
}

/** The tag of a row: back, the snooze time, a failed or interrupted last turn. */
export function tagParts(e: InboxEntry, now: number, compact: boolean): Part[] {
  const out: Part[] = [];
  if (e.woke) out.push({ text: 'back', style: th.match });
  if (e.section === 'snoozed' && e.marks.snoozedUntil !== undefined) {
    const t = formatSnooze(e.marks.snoozedUntil, now);
    out.push({ text: compact ? t.replace(/^until /, '') : t, style: th.dim });
  }
  if (e.row.outcome === 'failed') out.push({ text: 'failed', style: style(1) });
  else if (e.row.outcome === 'interrupted') out.push({ text: 'interrupted', style: th.dim });
  return out;
}

const partsWidth = (parts: Part[]) => parts.reduce((a, p) => a + stringWidth(p.text), 0) + Math.max(0, parts.length - 1) * 2;

/**
 * The title and the right side of a row for `width` cells (the row without the dot). When the
 * title gets too short, the parts give way in this order: the branch, the project, then the
 * word "until" of the snooze text. The title is truncated last; the age always stays.
 */
export function rowParts(
  e: InboxEntry,
  width: number,
  now: number,
  live: boolean,
  platform: NodeJS.Platform,
  agent = '',
): { title: string; right: Part[] } {
  const title = clean(e.row.title).trim() || '(untitled)';
  const age: Part = { text: (live ? '▸ ' : '') + (agent ? agent + ' ' : '') + relativeTime(e.row.updated, now), style: th.dim };
  const max = Math.max(8, Math.floor(width * 0.4));
  const full = placeText(e, platform);
  const name = clean(e.project.name);
  const build = (place: string, compact: boolean): Part[] => {
    const parts: Part[] = [];
    if (place) parts.push({ text: truncate(place, max), style: th.dim });
    parts.push(...tagParts(e, now, compact));
    if (age.text) parts.push(age);
    return parts;
  };
  const room = (parts: Part[]) => width - partsWidth(parts) - 1;
  const options: Array<[string, boolean]> = [];
  if (stringWidth(full) <= max) options.push([full, false]);
  options.push([name, false], ['', false], ['', true]);
  let right: Part[] = [];
  for (const [place, compact] of options) {
    right = build(place, compact);
    if (room(right) >= MIN_TITLE) break;
  }
  return { title: truncate(title, Math.max(1, room(right))), right };
}

function drawInboxList(f: Frame, app: App, outer: Rect): void {
  const focused = app.focus === 'inbox' && !app.modal;
  const items = app.inbox.items();
  const total = app.inbox.entries().length;
  columnBox(f, outer, total ? `Inbox · ${total}` : 'Inbox', focused);
  const list = inset(outer, 1);
  const sel = focused ? th.selection : th.selectionDim;
  const now = app.deps.now();
  const platform = app.deps.platform;
  if (items.length === 0) {
    f.pushClip(list);
    let y = list.y;
    for (const t of emptyInboxText(app)) for (const l of wrapText(t, list.w - 2)) f.text(list.x + 1, y++, l, th.dim);
    f.popClip();
    return;
  }
  renderList(f, list, items, app.inbox.list, {
    focused,
    rowHeight: 1,
    selectedStyle: sel,
    scrollbar: { x: outer.x + outer.w - 1, style: th.scrollThumb },
    renderRow: (fr, r, item: ListItem<InboxItem>, info) => {
      const d = item.data;
      if (d.kind === 'header') {
        let t = `${SECTION_TITLES[d.section]} (${d.count})`;
        if (d.collapsed) t += ' · E shows';
        fr.text(r.x + 1, r.y, t, th.header, r.w - 1);
        return;
      }
      const bg = info.selected ? sel : null;
      const e = d.entry;
      if (info.selected && focused) fr.put(r.x, r.y, '▌', onBg(th.borderFocusedStyle, bg));
      dotAt(fr, r.x + 1, r.y, e.row.status, bg);
      const { title, right } = rowParts(e, r.w - 3, now, app.panes.has(e.row.id), platform, agentTag(app, e.row));
      fr.text(r.x + 3, r.y, title, onBg(e.row.title.trim() ? th.text : th.dim, bg));
      let x = r.x + r.w - partsWidth(right);
      for (const p of right) x = fr.text(x, r.y, p.text, onBg(p.style, bg)) + 2;
    },
  });
}
