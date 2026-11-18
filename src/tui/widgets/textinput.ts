// Single-line text editor. Positions are grapheme indexes; scrolling is in cells, so wide
// characters and combined graphemes move and delete as one unit.

import type { InputEvent } from '../../types.ts';
import { graphemeWidth, graphemes, stringWidth } from '../../width.ts';
import type { Frame, Rect } from '../frame.ts';
import type { Style } from '../style.ts';

export interface TextInputState {
  value: string;
  /** Cursor position as a grapheme index, 0..graphemes(value).length. */
  cursor: number;
  /** First visible cell. Updated by `renderTextInput`. */
  scroll: number;
}

export type TextInputAction = 'none' | 'change' | 'move' | 'submit' | 'cancel';

export interface TextInputResult {
  state: TextInputState;
  action: TextInputAction;
  handled: boolean;
}

export interface TextInputRenderOptions {
  focused: boolean;
  style: Style;
  placeholder?: string;
  placeholderStyle?: Style;
}

export function createTextInput(value = ''): TextInputState {
  return { value: sanitize(value), cursor: graphemes(sanitize(value)).length, scroll: 0 };
}

/** One line only: line breaks and tabs become spaces, other control characters are removed. */
export function sanitize(text: string): string {
  return text.replace(/\r\n|[\r\n\t]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

const NAMED = new Set([
  'enter', 'tab', 'backspace', 'escape', 'up', 'down', 'left', 'right', 'home', 'end',
  'pageup', 'pagedown', 'insert', 'delete', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8',
  'f9', 'f10', 'f11', 'f12',
]);

const isSpace = (g: string): boolean => /^\s+$/u.test(g);

function wordLeft(gs: readonly string[], pos: number): number {
  let i = pos;
  while (i > 0 && isSpace(gs[i - 1]!)) i--;
  while (i > 0 && !isSpace(gs[i - 1]!)) i--;
  return i;
}

function wordRight(gs: readonly string[], pos: number): number {
  let i = pos;
  while (i < gs.length && isSpace(gs[i]!)) i++;
  while (i < gs.length && !isSpace(gs[i]!)) i++;
  return i;
}

function edit(state: TextInputState, gs: string[], cursor: number): TextInputResult {
  return { state: { value: gs.join(''), cursor, scroll: state.scroll }, action: 'change', handled: true };
}

function move(state: TextInputState, cursor: number): TextInputResult {
  return { state: { ...state, cursor }, action: 'move', handled: true };
}

/** Insert text at the cursor. */
export function insertText(state: TextInputState, text: string): TextInputState {
  const gs = graphemes(state.value);
  const add = graphemes(sanitize(text));
  const c = Math.min(state.cursor, gs.length);
  gs.splice(c, 0, ...add);
  // Re-split: an inserted combining mark can join the grapheme before it.
  const value = gs.join('');
  const before = graphemes(gs.slice(0, c + add.length).join('')).length;
  return { value, cursor: before, scroll: state.scroll };
}

/** Apply one input event. Unhandled events return `handled: false` and the same state. */
export function handleTextInput(state: TextInputState, event: InputEvent): TextInputResult {
  const none: TextInputResult = { state, action: 'none', handled: false };
  if (event.type === 'paste') {
    if (sanitize(event.text).length === 0) return { state, action: 'none', handled: true };
    return { state: insertText(state, event.text), action: 'change', handled: true };
  }
  if (event.type !== 'key') return none;
  const gs = graphemes(state.value);
  const c = Math.max(0, Math.min(state.cursor, gs.length));
  const { key: k, ctrl, alt } = event;

  if (ctrl && !alt) {
    switch (k) {
      case 'a': return move(state, 0);
      case 'e': return move(state, gs.length);
      case 'b': return move(state, Math.max(0, c - 1));
      case 'f': return move(state, Math.min(gs.length, c + 1));
      case 'left': return move(state, wordLeft(gs, c));
      case 'right': return move(state, wordRight(gs, c));
      case 'w': case 'backspace': {
        const s = wordLeft(gs, c);
        gs.splice(s, c - s);
        return edit(state, gs, s);
      }
      case 'u': {
        gs.splice(0, c);
        return edit(state, gs, 0);
      }
      case 'k': {
        gs.splice(c);
        return edit(state, gs, c);
      }
      case 'd': case 'delete': {
        if (k === 'delete') {
          const e = wordRight(gs, c);
          gs.splice(c, e - c);
          return edit(state, gs, c);
        }
        if (c >= gs.length) return { state, action: 'none', handled: true };
        gs.splice(c, 1);
        return edit(state, gs, c);
      }
      case 'home': return move(state, 0);
      case 'end': return move(state, gs.length);
    }
    return none;
  }
  if (alt && !ctrl) {
    switch (k) {
      case 'b': case 'left': return move(state, wordLeft(gs, c));
      case 'f': case 'right': return move(state, wordRight(gs, c));
      case 'backspace': {
        const s = wordLeft(gs, c);
        gs.splice(s, c - s);
        return edit(state, gs, s);
      }
      case 'd': case 'delete': {
        const e = wordRight(gs, c);
        gs.splice(c, e - c);
        return edit(state, gs, c);
      }
    }
    return none;
  }
  if (ctrl || alt) return none;
  switch (k) {
    case 'enter': return { state, action: 'submit', handled: true };
    case 'escape': return { state, action: 'cancel', handled: true };
    case 'left': return move(state, Math.max(0, c - 1));
    case 'right': return move(state, Math.min(gs.length, c + 1));
    case 'home': return move(state, 0);
    case 'end': return move(state, gs.length);
    case 'backspace': {
      if (c === 0) return { state, action: 'none', handled: true };
      gs.splice(c - 1, 1);
      return edit(state, gs, c - 1);
    }
    case 'delete': {
      if (c >= gs.length) return { state, action: 'none', handled: true };
      gs.splice(c, 1);
      return edit(state, gs, c);
    }
    case 'space': return { state: insertText({ ...state, cursor: c }, ' '), action: 'change', handled: true };
  }
  if (NAMED.has(k)) return none;
  return { state: insertText({ ...state, cursor: c }, k), action: 'change', handled: true };
}

/** Scroll offset that keeps the cursor cell inside a field `width` cells wide. */
export function scrollFor(state: TextInputState, width: number): number {
  if (width <= 0) return 0;
  const gs = graphemes(state.value);
  const c = Math.max(0, Math.min(state.cursor, gs.length));
  let cc = 0;
  for (let i = 0; i < c; i++) cc += graphemeWidth(gs[i]!);
  const total = stringWidth(state.value);
  let scroll = Math.max(0, state.scroll);
  if (cc < scroll) scroll = cc;
  if (cc >= scroll + width) scroll = cc - width + 1;
  // Do not leave empty room at the right while text is hidden at the left.
  scroll = Math.max(0, Math.min(scroll, total + 1 - width));
  return Math.max(0, scroll);
}

/**
 * Draw the field in the first row of `r`. Places the frame cursor when focused. Returns the
 * state with the scroll offset used; keep it for the next render.
 */
export function renderTextInput(frame: Frame, r: Rect, state: TextInputState, opts: TextInputRenderOptions): TextInputState {
  if (r.w <= 0 || r.h <= 0) return state;
  const scroll = scrollFor(state, r.w);
  frame.pushClip({ x: r.x, y: r.y, w: r.w, h: 1 });
  frame.fillRect(r.x, r.y, r.w, 1, opts.style);
  if (state.value.length === 0 && opts.placeholder) {
    frame.text(r.x, r.y, opts.placeholder, opts.placeholderStyle ?? opts.style, r.w);
  } else {
    frame.text(r.x - scroll, r.y, state.value, opts.style);
  }
  frame.popClip();
  if (opts.focused) {
    const gs = graphemes(state.value);
    let cc = 0;
    for (let i = 0; i < Math.min(state.cursor, gs.length); i++) cc += graphemeWidth(gs[i]!);
    frame.setCursor(r.x + cc - scroll, r.y, true);
  }
  return scroll === state.scroll ? state : { ...state, scroll };
}
