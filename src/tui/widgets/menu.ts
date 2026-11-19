// A small modal menu: one line per choice, each with its own key. j/k or the arrows and Enter
// also choose; Esc cancels. A click on a line chooses it; a click outside cancels.

import type { InputEvent } from '../../types.ts';
import { stringWidth } from '../../width.ts';
import { truncate, type Frame, type Rect } from '../frame.ts';
import { defaultTheme, type Theme } from '../style.ts';
import { rectContains } from './layout.ts';
import { drawModal } from './modal.ts';

export interface MenuItem {
  /** One printable key that chooses the item. */
  key: string;
  label: string;
  /** Right-aligned extra text (for example the resulting time). */
  detail?: string;
}

export interface MenuState {
  title: string;
  /** A dim line above the items. */
  note: string;
  items: MenuItem[];
  picked: number;
  /** Rectangle of the item lines from the last render, for mouse clicks. */
  hit: Rect | null;
  /** Outer rectangle of the box from the last render. */
  box: Rect | null;
}

export function createMenu(title: string, items: MenuItem[], note = ''): MenuState {
  return { title, note, items, picked: 0, hit: null, box: null };
}

export interface MenuResult {
  state: MenuState;
  /** Index of the chosen item, 'cancel', or null while the menu stays open. */
  result: number | 'cancel' | null;
}

export function handleMenu(state: MenuState, ev: InputEvent): MenuResult {
  const stay = (s: MenuState = state): MenuResult => ({ state: s, result: null });
  const n = state.items.length;
  if (ev.type === 'mouse') {
    if (ev.action === 'wheel-down') return stay({ ...state, picked: Math.min(n - 1, state.picked + 1) });
    if (ev.action === 'wheel-up') return stay({ ...state, picked: Math.max(0, state.picked - 1) });
    if (ev.action !== 'down' || ev.button !== 'left') return stay();
    if (state.hit && rectContains(state.hit, ev.x, ev.y)) {
      const i = ev.y - state.hit.y;
      return i < n ? { state: { ...state, picked: i }, result: i } : stay();
    }
    if (state.box && rectContains(state.box, ev.x, ev.y)) return stay();
    return { state, result: 'cancel' };
  }
  if (ev.type !== 'key' || ev.alt) return stay();
  const k = ev.key;
  if (k === 'escape' || (ev.ctrl && (k === 'c' || k === 'g'))) return { state, result: 'cancel' };
  if (ev.ctrl) return stay();
  if (k === 'down' || k === 'j') return stay({ ...state, picked: Math.min(n - 1, state.picked + 1) });
  if (k === 'up' || k === 'k') return stay({ ...state, picked: Math.max(0, state.picked - 1) });
  if (k === 'home') return stay({ ...state, picked: 0 });
  if (k === 'end') return stay({ ...state, picked: Math.max(0, n - 1) });
  if (k === 'enter') return n > 0 ? { state, result: state.picked } : stay();
  const i = state.items.findIndex((it) => it.key === k);
  return i >= 0 ? { state: { ...state, picked: i }, result: i } : stay();
}

/** Draw the menu centered on `screen`. Returns the state with the hit areas. */
export function renderMenu(frame: Frame, screen: Rect, state: MenuState, theme: Theme = defaultTheme): MenuState {
  let width = stringWidth(state.title) + 8;
  for (const it of state.items) width = Math.max(width, 4 + stringWidth(it.label) + 3 + stringWidth(it.detail ?? '') + 4);
  if (state.note) width = Math.max(width, Math.min(60, stringWidth(state.note) + 4));
  width = Math.min(width, Math.max(10, screen.w - 2));
  const noteLines = state.note ? 2 : 0;
  const height = Math.min(state.items.length + noteLines + 3, screen.h);
  let hit: Rect | null = null;
  const box = drawModal(frame, screen, { title: state.title, width, height, theme }, (f, inner) => {
    let y = inner.y;
    if (state.note) {
      f.text(inner.x, y, truncate(state.note, inner.w), theme.dim);
      y += 2;
    }
    hit = { x: inner.x, y, w: inner.w, h: state.items.length };
    state.items.forEach((it, i) => {
      const yy = y + i;
      const picked = i === state.picked;
      const st = picked ? theme.selection : theme.modalBody;
      if (picked) f.fillRect(inner.x, yy, inner.w, 1, theme.selection);
      f.text(inner.x, yy, it.key, { ...theme.footerKey, bg: st.bg });
      const detail = it.detail ?? '';
      const dw = stringWidth(detail);
      f.text(inner.x + 3, yy, truncate(it.label, Math.max(1, inner.w - 4 - dw)), st);
      if (dw) f.text(inner.x + inner.w - dw, yy, detail, { ...theme.dim, bg: st.bg });
    });
    f.text(inner.x, inner.y + inner.h - 1, 'Esc cancels', theme.dim, inner.w);
  });
  return { ...state, hit, box };
}
