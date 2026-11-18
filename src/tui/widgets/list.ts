// A scrolling, selectable list. State is plain data that the app keeps; every function returns
// a new state. The selection follows an item key, so it stays on the same item when the item
// array changes.

import type { InputEvent } from '../../types.ts';
import type { Frame, Rect } from '../frame.ts';
import type { Style } from '../style.ts';
import { rectContains } from './layout.ts';

export interface ListItem<T = unknown> {
  /** Stable identity of the item. */
  key: string;
  data: T;
  /** A group header: drawn, but cannot be selected. */
  header?: boolean;
}

export interface ListState {
  selectedKey: string | null;
  /** Last known index of the selection; used when the selected item disappears. */
  selectedIndex: number;
  /** Index of the first visible item. */
  scrollTop: number;
}

export interface ListConfig {
  /** Lines per row, the same for every row (headers included). Default 1. */
  rowHeight?: number;
  /** Rows kept visible above and below the selection when it moves. Default 1. */
  margin?: number;
  /** Mouse wheel: scroll the view (default) or move the selection. */
  wheel?: 'scroll' | 'select';
  /** Rows per wheel step. Default 3 for scroll, 1 for select. */
  wheelStep?: number;
}

export interface RowInfo {
  index: number;
  selected: boolean;
  focused: boolean;
}

export interface ListRenderOptions<T> {
  focused: boolean;
  renderRow: (frame: Frame, rect: Rect, item: ListItem<T>, info: RowInfo) => void;
  rowHeight?: number;
  /** Fill the selected row with this style before `renderRow`. */
  selectedStyle?: Style;
  /** Draw a scrollbar thumb in this column (normally the right border), rows of `rect`. */
  scrollbar?: { x: number; style: Style; track?: Style };
  /** Text shown when the list is empty. */
  empty?: { text: string; style: Style };
}

export interface ListInputResult {
  state: ListState;
  /** True when the list used the event. */
  handled: boolean;
  /** Enter, or a click on the item that was already selected. */
  activated: boolean;
}

export function createListState(selectedKey: string | null = null): ListState {
  return { selectedKey, selectedIndex: 0, scrollTop: 0 };
}

/** Number of whole rows that fit in `height` lines. */
export function viewRows(height: number, rowHeight = 1): number {
  return Math.max(0, Math.floor(height / Math.max(1, rowHeight)));
}

function selectable<T>(items: readonly ListItem<T>[], i: number): boolean {
  const it = items[i];
  return it !== undefined && !it.header;
}

function clampTop(top: number, n: number, rows: number): number {
  return Math.max(0, Math.min(top, Math.max(0, n - rows)));
}

/** Scroll so that `index` is visible with `margin` rows around it. */
export function scrollToShow(scrollTop: number, index: number, n: number, rows: number, margin = 1): number {
  if (rows <= 0 || index < 0) return clampTop(scrollTop, n, rows);
  const m = Math.max(0, Math.min(margin, Math.floor((rows - 1) / 2)));
  let top = scrollTop;
  if (index < top + m) top = index - m;
  if (index > top + rows - 1 - m) top = index - rows + 1 + m;
  return clampTop(top, n, rows);
}

/** Nearest selectable index to `from`, looking forward first. -1 when there is none. */
export function nearestSelectable<T>(items: readonly ListItem<T>[], from: number): number {
  const n = items.length;
  if (n === 0) return -1;
  const start = Math.max(0, Math.min(from, n - 1));
  for (let d = 0; d < n; d++) {
    if (selectable(items, start + d)) return start + d;
    if (selectable(items, start - d)) return start - d;
  }
  return -1;
}

export function selectedIndexOf<T>(state: ListState, items: readonly ListItem<T>[]): number {
  if (state.selectedKey === null) return -1;
  const i = state.selectedIndex;
  if (items[i]?.key === state.selectedKey) return i;
  return items.findIndex((it) => it.key === state.selectedKey);
}

/**
 * Make the state valid for `items`: the selection stays on its key; when the key is gone it
 * moves to the nearest selectable item at the old index. The scroll offset is clamped.
 */
export function reconcileList<T>(state: ListState, items: readonly ListItem<T>[], rows: number, cfg: ListConfig = {}): ListState {
  const n = items.length;
  const found = selectedIndexOf(state, items);
  if (found >= 0 && selectable(items, found)) {
    return { selectedKey: state.selectedKey, selectedIndex: found, scrollTop: clampTop(state.scrollTop, n, rows) };
  }
  const idx = nearestSelectable(items, found >= 0 ? found : state.selectedIndex);
  if (idx < 0) return { selectedKey: null, selectedIndex: 0, scrollTop: clampTop(state.scrollTop, n, rows) };
  return {
    selectedKey: items[idx]!.key,
    selectedIndex: idx,
    scrollTop: scrollToShow(state.scrollTop, idx, n, rows, cfg.margin ?? 1),
  };
}

/** Select the item at `index` (or the nearest selectable one) and scroll it into view. */
export function selectIndex<T>(state: ListState, items: readonly ListItem<T>[], index: number, rows: number, cfg: ListConfig = {}): ListState {
  const idx = selectable(items, index) ? index : nearestSelectable(items, index);
  if (idx < 0) return reconcileList(state, items, rows, cfg);
  return {
    selectedKey: items[idx]!.key,
    selectedIndex: idx,
    scrollTop: scrollToShow(state.scrollTop, idx, items.length, rows, cfg.margin ?? 1),
  };
}

export function selectKey<T>(state: ListState, items: readonly ListItem<T>[], key: string, rows: number, cfg: ListConfig = {}): ListState {
  const i = items.findIndex((it) => it.key === key);
  return i < 0 ? state : selectIndex(state, items, i, rows, cfg);
}

/** Move the selection by `delta` selectable items, skipping headers. Stops at the ends. */
export function moveSelection<T>(state: ListState, items: readonly ListItem<T>[], delta: number, rows: number, cfg: ListConfig = {}): ListState {
  const s = reconcileList(state, items, rows, cfg);
  let i = selectedIndexOf(s, items);
  if (i < 0) return s;
  const step = delta < 0 ? -1 : 1;
  let left = Math.abs(delta);
  let last = i;
  while (left > 0) {
    i += step;
    if (i < 0 || i >= items.length) break;
    if (selectable(items, i)) {
      last = i;
      left--;
    }
  }
  return selectIndex(s, items, last, rows, cfg);
}

function first<T>(items: readonly ListItem<T>[]): number {
  return items.findIndex((it) => !it.header);
}

function last<T>(items: readonly ListItem<T>[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (!items[i]!.header) return i;
  return -1;
}

/** Scroll the view by `delta` rows without moving the selection. */
export function scrollBy(state: ListState, n: number, rows: number, delta: number): ListState {
  return { ...state, scrollTop: clampTop(state.scrollTop + delta, n, rows) };
}

/**
 * Handle a key or mouse event. `rect` is the area that holds the rows (inside the border).
 * Keys: ↑/k ↓/j, PgUp/PgDn, Home/End, Enter. Mouse: click selects, wheel scrolls.
 */
export function handleListInput<T>(
  state: ListState,
  items: readonly ListItem<T>[],
  event: InputEvent,
  r: Rect,
  cfg: ListConfig = {},
): ListInputResult {
  const rh = Math.max(1, cfg.rowHeight ?? 1);
  const rows = viewRows(r.h, rh);
  const no = { state, handled: false, activated: false };
  if (event.type === 'key') {
    if (event.ctrl || event.alt) return no;
    const page = Math.max(1, rows - 1);
    let next: ListState | null = null;
    switch (event.key) {
      case 'up': case 'k': next = moveSelection(state, items, -1, rows, cfg); break;
      case 'down': case 'j': next = moveSelection(state, items, 1, rows, cfg); break;
      case 'pageup': next = moveSelection(state, items, -page, rows, cfg); break;
      case 'pagedown': next = moveSelection(state, items, page, rows, cfg); break;
      case 'home': next = selectIndex(state, items, first(items), rows, cfg); break;
      case 'end': next = selectIndex(state, items, last(items), rows, cfg); break;
      case 'enter': {
        const s = reconcileList(state, items, rows, cfg);
        return { state: s, handled: true, activated: s.selectedKey !== null };
      }
      default: return no;
    }
    return { state: next, handled: true, activated: false };
  }
  if (event.type === 'mouse') {
    if (!rectContains(r, event.x, event.y)) return no;
    if (event.action === 'wheel-up' || event.action === 'wheel-down') {
      const dir = event.action === 'wheel-up' ? -1 : 1;
      if (cfg.wheel === 'select') {
        return { state: moveSelection(state, items, dir * (cfg.wheelStep ?? 1), rows, cfg), handled: true, activated: false };
      }
      return { state: scrollBy(state, items.length, rows, dir * (cfg.wheelStep ?? 3)), handled: true, activated: false };
    }
    if (event.action === 'down' && event.button === 'left') {
      const s = reconcileList(state, items, rows, cfg);
      const idx = s.scrollTop + Math.floor((event.y - r.y) / rh);
      if (idx >= items.length || !selectable(items, idx)) return { state: s, handled: true, activated: false };
      const again = items[idx]!.key === s.selectedKey;
      // A click selects in place: no scroll jump under the pointer.
      return { state: { selectedKey: items[idx]!.key, selectedIndex: idx, scrollTop: s.scrollTop }, handled: true, activated: again };
    }
    return { state, handled: true, activated: false };
  }
  return no;
}

/** Item index under a screen point, or -1. */
export function hitTestList<T>(state: ListState, items: readonly ListItem<T>[], r: Rect, x: number, y: number, rowHeight = 1): number {
  if (!rectContains(r, x, y)) return -1;
  const idx = state.scrollTop + Math.floor((y - r.y) / Math.max(1, rowHeight));
  return idx < items.length ? idx : -1;
}

/** Draw the visible rows into `r`. Call `reconcileList` first when the items changed. */
export function renderList<T>(frame: Frame, r: Rect, items: readonly ListItem<T>[], state: ListState, opts: ListRenderOptions<T>): void {
  const rh = Math.max(1, opts.rowHeight ?? 1);
  const rows = viewRows(r.h, rh);
  const n = items.length;
  if (n === 0 && opts.empty) {
    frame.pushClip(r);
    frame.text(r.x + 1, r.y, opts.empty.text, opts.empty.style, r.w - 1);
    frame.popClip();
  }
  const top = clampTop(state.scrollTop, n, rows);
  for (let k = 0; k < rows; k++) {
    const i = top + k;
    if (i >= n) break;
    const item = items[i]!;
    const rowRect: Rect = { x: r.x, y: r.y + k * rh, w: r.w, h: rh };
    const selected = !item.header && item.key === state.selectedKey;
    frame.pushClip(rowRect);
    if (selected && opts.selectedStyle) frame.fillRect(rowRect.x, rowRect.y, rowRect.w, rowRect.h, opts.selectedStyle);
    opts.renderRow(frame, rowRect, item, { index: i, selected, focused: opts.focused });
    frame.popClip();
  }
  const sb = opts.scrollbar;
  if (sb && n > rows && r.h > 0) {
    const h = r.h;
    const thumb = Math.max(1, Math.round((h * rows) / n));
    const pos = Math.round(((h - thumb) * top) / Math.max(1, n - rows));
    for (let y = 0; y < h; y++) {
      if (y >= pos && y < pos + thumb) frame.put(sb.x, r.y + y, '┃', sb.style);
      else if (sb.track) frame.put(sb.x, r.y + y, '│', sb.track);
    }
  }
}
