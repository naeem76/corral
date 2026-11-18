// Manual demo of the TUI toolkit: three boxed lists, focus movement, a text input modal (n),
// a confirm modal (d), mouse click and wheel, and a readout of the last input event.
//
//   fnm exec --using=26 node src/tui/demo.ts
//
// q or Ctrl+C quits and restores the terminal.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InputEvent, SessionStatus } from '../types.ts';
import { createFrame, renderDiff, truncate } from './frame.ts';
import type { Frame, Rect } from './frame.ts';
import { formatBinding, matches } from './keys.ts';
import { defaultTheme, detectColorDepth, statusDot } from './style.ts';
import { openTerminal } from './terminal.ts';
import { inset, rectContains, splitColumns, splitRows } from './widgets/layout.ts';
import { createListState, handleListInput, reconcileList, renderList, viewRows } from './widgets/list.ts';
import type { ListItem, ListState } from './widgets/list.ts';
import { createConfirm, handleConfirm, renderConfirm } from './widgets/modal.ts';
import type { ConfirmState } from './widgets/modal.ts';
import { drawModal } from './widgets/modal.ts';
import { createTextInput, handleTextInput, renderTextInput } from './widgets/textinput.ts';
import type { TextInputState } from './widgets/textinput.ts';

interface Row {
  label: string;
  detail?: string;
  status?: SessionStatus;
}

interface Column {
  title: string;
  items: ListItem<Row>[];
  list: ListState;
  rowHeight: number;
}

type Modal =
  | { kind: 'input'; column: number; input: TextInputState }
  | { kind: 'confirm'; column: number; key: string; confirm: ConfirmState }
  | null;

export interface DemoState {
  columns: Column[];
  focus: number;
  modal: Modal;
  lastEvent: string;
  counter: number;
  quit: boolean;
}

const th = defaultTheme;

function items(rows: Row[], prefix: string): ListItem<Row>[] {
  return rows.map((data, i) => ({ key: `${prefix}${i}`, data }));
}

export function createDemoState(): DemoState {
  const projects: ListItem<Row>[] = [
    { key: 'h-work', data: { label: 'Work' }, header: true },
    ...items([{ label: 'nebula-enterprise' }, { label: 'billing-service' }, { label: 'docs-site' }], 'p'),
    { key: 'h-oss', data: { label: 'Open source' }, header: true },
    ...items(Array.from({ length: 20 }, (_, i) => ({ label: `oss-project-${i + 1}` })), 'q'),
  ];
  const git = items(
    [
      { label: 'main', detail: '~/dev/nebula-enterprise' },
      { label: 'feature/tui-toolkit', detail: '~/dev/wt/tui-toolkit' },
      { label: 'fix/windows-paths', detail: '~/dev/wt/windows-paths' },
      { label: 'PR 412 宽字符 support ✨', detail: 'active · Naeem → main' },
    ],
    'g',
  );
  const statuses: SessionStatus[] = ['needs-input', 'working', 'unseen', 'idle'];
  const sessions = items(
    Array.from({ length: 30 }, (_, i) => ({ label: `Session ${i + 1}: refactor the parser`, status: statuses[i % 4]! })),
    's',
  );
  return {
    columns: [
      { title: 'Projects', items: projects, list: createListState('p0'), rowHeight: 1 },
      { title: 'Git', items: git, list: createListState('g0'), rowHeight: 2 },
      { title: 'Sessions', items: sessions, list: createListState('s0'), rowHeight: 1 },
    ],
    focus: 0,
    modal: null,
    lastEvent: '(none)',
    counter: 0,
    quit: false,
  };
}

interface Layout {
  cols: Rect[];
  inner: Rect[];
  pane: Rect;
  footer: Rect;
  screen: Rect;
}

function layout(w: number, h: number): Layout {
  const screen: Rect = { x: 0, y: 0, w, h };
  const [main, footer] = splitRows(screen, [{ min: 3 }, 1]);
  const parts = splitColumns(main!, [{ min: 12, weight: 2 }, { min: 14, weight: 3 }, { min: 14, weight: 3 }, { min: 10, weight: 4 }]);
  const cols = parts.slice(0, 3);
  return { cols, inner: cols.map((r) => inset(r, 1)), pane: parts[3]!, footer: footer!, screen };
}

export function describeEvent(ev: InputEvent): string {
  const raw = (s: string): string => JSON.stringify(s).slice(1, -1);
  switch (ev.type) {
    case 'key': {
      const mods = `${ev.ctrl ? 'ctrl+' : ''}${ev.alt ? 'alt+' : ''}${ev.shift ? 'shift+' : ''}`;
      return `key ${mods}${ev.key}  raw=${raw(ev.raw)}`;
    }
    case 'mouse':
      return `mouse ${ev.action} ${ev.button} @${ev.x},${ev.y}${ev.ctrl ? ' ctrl' : ''}${ev.alt ? ' alt' : ''}${ev.shift ? ' shift' : ''}  raw=${raw(ev.raw)}`;
    case 'paste':
      return `paste ${ev.text.length} chars: ${raw(ev.text.slice(0, 40))}`;
    case 'focus':
      return `focus ${ev.focused ? 'in' : 'out'}`;
  }
}

export function handleDemoEvent(s: DemoState, ev: InputEvent, w: number, h: number): void {
  s.lastEvent = describeEvent(ev);
  const lay = layout(w, h);
  if (matches(ev, 'ctrl+c')) {
    s.quit = true;
    return;
  }
  const m = s.modal;
  if (m?.kind === 'input') {
    const r = handleTextInput(m.input, ev);
    if (r.action === 'cancel') s.modal = null;
    else if (r.action === 'submit') {
      const col = s.columns[m.column]!;
      const label = r.state.value.trim() || 'untitled';
      const key = `new${++s.counter}`;
      col.items = [...col.items, { key, data: { label, status: 'idle', detail: 'new item' } }];
      col.list = { ...col.list, selectedKey: key };
      col.list = reconcileList(col.list, col.items, viewRows(lay.inner[m.column]!.h, col.rowHeight));
      s.modal = null;
    } else m.input = r.state;
    return;
  }
  if (m?.kind === 'confirm') {
    const r = handleConfirm(m.confirm, ev);
    if (r.result === 'yes') {
      const col = s.columns[m.column]!;
      col.items = col.items.filter((it) => it.key !== m.key);
      col.list = reconcileList(col.list, col.items, viewRows(lay.inner[m.column]!.h, col.rowHeight));
    }
    if (r.result) s.modal = null;
    else m.confirm = r.state;
    return;
  }
  if (ev.type === 'mouse') {
    const ci = lay.cols.findIndex((r) => rectContains(r, ev.x, ev.y));
    if (ci < 0) return;
    if (ev.action === 'down') s.focus = ci;
    const col = s.columns[ci]!;
    col.list = handleListInput(col.list, col.items, ev, lay.inner[ci]!, { rowHeight: col.rowHeight }).state;
    return;
  }
  if (ev.type !== 'key') return;
  if (matches(ev, 'q')) {
    s.quit = true;
    return;
  }
  if (matches(ev, ['tab', 'right', 'l'])) {
    s.focus = (s.focus + 1) % 3;
    return;
  }
  if (matches(ev, ['shift+tab', 'left', 'h'])) {
    s.focus = (s.focus + 2) % 3;
    return;
  }
  const col = s.columns[s.focus]!;
  if (matches(ev, 'n')) {
    s.modal = { kind: 'input', column: s.focus, input: createTextInput() };
    return;
  }
  if (matches(ev, 'd')) {
    const it = col.items.find((x) => x.key === col.list.selectedKey);
    if (!it) return;
    s.modal = {
      kind: 'confirm',
      column: s.focus,
      key: it.key,
      confirm: createConfirm({
        title: `Delete from ${col.title}`,
        message: `Remove "${it.data.label}" from the list? This is only a demo.`,
        yesLabel: 'Delete',
        noLabel: 'Keep',
        requireText: s.focus === 0 ? it.data.label : undefined,
      }),
    };
    return;
  }
  col.list = handleListInput(col.list, col.items, ev, lay.inner[s.focus]!, { rowHeight: col.rowHeight }).state;
}

export function renderDemo(f: Frame, s: DemoState): void {
  const lay = layout(f.cols, f.rows);
  f.clear();
  s.columns.forEach((col, ci) => {
    const focused = ci === s.focus && s.modal === null;
    const outer = lay.cols[ci]!;
    const inner = lay.inner[ci]!;
    f.box(outer.x, outer.y, outer.w, outer.h, focused ? th.borderFocusedStyle : th.borderStyle, col.title, {
      border: th.border,
      titleStyle: focused ? th.titleFocusedStyle : th.titleStyle,
    });
    col.list = reconcileList(col.list, col.items, viewRows(inner.h, col.rowHeight));
    renderList(f, inner, col.items, col.list, {
      focused,
      rowHeight: col.rowHeight,
      selectedStyle: focused ? th.selection : th.selectionDim,
      scrollbar: { x: outer.x + outer.w - 1, style: th.scrollThumb },
      empty: { text: 'empty — press n', style: th.dim },
      renderRow: (fr, r, item, info) => {
        const bg = info.selected ? (focused ? th.selection : th.selectionDim) : null;
        const withBg = (st: typeof th.text) => (bg ? { ...st, bg: bg.bg } : st);
        if (item.header) {
          fr.text(r.x, r.y, item.data.label.toUpperCase(), th.header, r.w);
          return;
        }
        let x = r.x;
        if (info.selected) fr.put(x, r.y, '▌', withBg({ ...th.borderFocusedStyle }));
        x += 1;
        if (item.data.status) {
          const dot = statusDot(item.data.status);
          fr.put(x, r.y, dot.glyph, withBg(dot.style));
          x += 2;
        }
        fr.text(x, r.y, truncate(item.data.label, r.x + r.w - x), withBg(th.text));
        if (r.h > 1 && item.data.detail) fr.text(r.x + 3, r.y + 1, truncate(item.data.detail, r.w - 3), withBg(th.dim));
      },
    });
  });
  // The pane: a readout of the last input event.
  const pane = lay.pane;
  f.box(pane.x, pane.y, pane.w, pane.h, th.borderStyle, 'Last input', { border: th.border, titleStyle: th.titleStyle });
  const pi = inset(pane, 1, 2);
  f.pushClip(pi);
  let y = pi.y;
  for (const line of [s.lastEvent, '', `size ${f.cols}×${f.rows}`, `focus ${s.columns[s.focus]!.title}`]) {
    f.text(pi.x, y++, line, th.text, pi.w);
  }
  f.popClip();
  // Footer hints.
  const hints: [string, string][] = [['tab', 'focus'], ['shift+tab', 'back'], ['j', 'down'], ['k', 'up'], ['n', 'new'], ['d', 'delete'], ['q', 'quit']];
  let x = lay.footer.x + 1;
  for (const [k, label] of hints) {
    x = f.text(x, lay.footer.y, formatBinding(k), th.footerKey);
    x = f.text(x + 1, lay.footer.y, label, th.footerText) + 2;
  }
  // Modals on top.
  const m = s.modal;
  if (m?.kind === 'input') {
    drawModal(f, lay.screen, { title: `New item in ${s.columns[m.column]!.title}`, width: 50, height: 5, theme: th }, (fr, inner) => {
      fr.text(inner.x, inner.y, 'Name (Enter to add, Esc to cancel):', th.dim, inner.w);
      m.input = renderTextInput(fr, { x: inner.x, y: inner.y + 2, w: inner.w, h: 1 }, m.input, {
        focused: true,
        style: th.selection,
        placeholder: 'type here',
        placeholderStyle: th.placeholder,
      });
    });
  } else if (m?.kind === 'confirm') {
    m.confirm = renderConfirm(f, lay.screen, m.confirm, th);
  }
}

function main(): void {
  const term = openTerminal({ stdin: process.stdin, stdout: process.stdout });
  const depth = detectColorDepth(process.env);
  const state = createDemoState();
  let prev: Frame | null = null;
  const draw = (): void => {
    const { cols, rows } = term.size();
    const f = createFrame(cols, rows);
    renderDemo(f, state);
    term.write(renderDiff(prev, f, { depth }));
    prev = f;
  };
  term.onInput((events) => {
    const { cols, rows } = term.size();
    for (const ev of events) {
      handleDemoEvent(state, ev, cols, rows);
      if (state.quit) {
        term.close();
        process.exit(0);
      }
    }
    draw();
  });
  term.onResize(() => {
    prev = null;
    draw();
  });
  term.onRedraw(() => {
    prev = null;
    draw();
  });
  draw();
}

function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
