// Centered modal boxes, a yes/no confirm, and a "type the name to confirm" variant for
// destructive actions.

import type { InputEvent } from '../../types.ts';
import { stringWidth } from '../../width.ts';
import { wrapText } from '../frame.ts';
import type { Frame, Rect } from '../frame.ts';
import { defaultTheme } from '../style.ts';
import type { Theme } from '../style.ts';
import { centerRect, rectContains } from './layout.ts';
import { createTextInput, handleTextInput, renderTextInput } from './textinput.ts';
import type { TextInputState } from './textinput.ts';

export interface ModalOptions {
  title?: string;
  /** Outer size including the border. Clamped to the screen. */
  width: number;
  height: number;
  theme?: Theme;
}

/**
 * Draw a centered box over `screen`, clear its inside, then call `body` with the inner
 * rectangle (inside the border, one cell of padding left and right). Returns the outer rect.
 */
export function drawModal(frame: Frame, screen: Rect, opts: ModalOptions, body?: (frame: Frame, inner: Rect) => void): Rect {
  const th = opts.theme ?? defaultTheme;
  const outer = centerRect(screen, opts.width, opts.height);
  if (outer.w < 2 || outer.h < 2) return outer;
  frame.pushClip(outer);
  frame.fillRect(outer.x, outer.y, outer.w, outer.h, th.modalBody);
  frame.box(outer.x, outer.y, outer.w, outer.h, th.modalBorder, opts.title, { border: th.border, titleStyle: th.modalTitle });
  const inner: Rect = { x: outer.x + 2, y: outer.y + 1, w: Math.max(0, outer.w - 4), h: Math.max(0, outer.h - 2) };
  if (body) {
    frame.pushClip(inner);
    body(frame, inner);
    frame.popClip();
  }
  frame.popClip();
  return outer;
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmState {
  title: string;
  message: string;
  /** 'yes' or 'no': the button Enter chooses. */
  choice: 'yes' | 'no';
  yesLabel: string;
  noLabel: string;
  /** When set, the user must type this text before Yes works (destructive actions). */
  requireText: string | null;
  input: TextInputState;
  /** Button rectangles from the last render, for mouse clicks. */
  hit: { yes: Rect | null; no: Rect | null };
}

export interface ConfirmInit {
  title: string;
  message: string;
  yesLabel?: string;
  noLabel?: string;
  /** Default 'no' so a stray Enter never confirms. */
  choice?: 'yes' | 'no';
  requireText?: string;
}

export function createConfirm(init: ConfirmInit): ConfirmState {
  return {
    title: init.title,
    message: init.message,
    choice: init.choice ?? 'no',
    yesLabel: init.yesLabel ?? 'Yes',
    noLabel: init.noLabel ?? 'No',
    requireText: init.requireText ?? null,
    input: createTextInput(),
    hit: { yes: null, no: null },
  };
}

/** True when Yes is allowed: no text is required, or the typed text matches exactly. */
export function confirmReady(state: ConfirmState): boolean {
  return state.requireText === null || state.input.value === state.requireText;
}

export interface ConfirmResult {
  state: ConfirmState;
  /** 'yes' / 'no' when the dialog is done, null while it stays open. */
  result: 'yes' | 'no' | null;
}

/**
 * Keys: y / n (simple confirm only), ←/→/Tab switch the button, Enter chooses, Esc is No.
 * In the type-to-confirm variant, typing goes to the text field and Enter is Yes only when
 * the text matches.
 */
export function handleConfirm(state: ConfirmState, event: InputEvent): ConfirmResult {
  const stay = (s: ConfirmState = state): ConfirmResult => ({ state: s, result: null });
  if (event.type === 'mouse') {
    if (event.action !== 'down' || event.button !== 'left') return stay();
    if (state.hit.yes && rectContains(state.hit.yes, event.x, event.y)) {
      return confirmReady(state) ? { state, result: 'yes' } : stay();
    }
    if (state.hit.no && rectContains(state.hit.no, event.x, event.y)) return { state, result: 'no' };
    return stay();
  }
  if (event.type === 'key' && !event.alt) {
    const k = event.key;
    if (k === 'escape' || (event.ctrl && (k === 'c' || k === 'g'))) return { state, result: 'no' };
    if (event.ctrl) {
      // Fall through to the text field (Ctrl+W etc.) below.
    } else if (k === 'enter') {
      if (state.requireText !== null) return confirmReady(state) ? { state, result: 'yes' } : stay();
      return { state, result: state.choice };
    } else if (k === 'tab' || (state.requireText === null && (k === 'left' || k === 'right' || k === 'h' || k === 'l'))) {
      return stay({ ...state, choice: state.choice === 'yes' ? 'no' : 'yes' });
    } else if (state.requireText === null) {
      if (k === 'y' || k === 'Y') return { state, result: 'yes' };
      if (k === 'n' || k === 'N') return { state, result: 'no' };
      return stay();
    }
  }
  if (state.requireText !== null) {
    const r = handleTextInput(state.input, event);
    if (r.handled) return stay({ ...state, input: r.state, choice: 'yes' });
  }
  return stay();
}

/** Draw the confirm dialog centered on `screen`. Returns the state with button hit areas. */
export function renderConfirm(frame: Frame, screen: Rect, state: ConfirmState, theme: Theme = defaultTheme): ConfirmState {
  const width = Math.min(Math.max(40, stringWidth(state.title) + 8), Math.max(10, screen.w - 4), 70);
  const lines = wrapText(state.message, width - 4);
  const extra = state.requireText !== null ? 3 : 0;
  const height = Math.min(lines.length + 4 + extra, screen.h);
  let input = state.input;
  let hit: ConfirmState['hit'] = { yes: null, no: null };
  drawModal(frame, screen, { title: state.title, width, height, theme }, (f, inner) => {
    let y = inner.y;
    for (const line of lines) {
      if (y >= inner.y + inner.h - 1) break;
      f.text(inner.x, y, line, theme.modalBody, inner.w);
      y++;
    }
    if (state.requireText !== null) {
      y++;
      f.text(inner.x, y, `Type "${state.requireText}" to confirm:`, theme.dim, inner.w);
      y++;
      input = renderTextInput(f, { x: inner.x, y, w: inner.w, h: 1 }, state.input, {
        focused: true,
        style: theme.selection,
      });
    }
    const by = inner.y + inner.h - 1;
    const yes = ` ${state.yesLabel} `;
    const no = ` ${state.noLabel} `;
    const yw = stringWidth(yes);
    const nw = stringWidth(no);
    const total = yw + 2 + nw;
    const bx = inner.x + Math.max(0, inner.w - total);
    const ready = confirmReady(state);
    const yesStyle = state.choice === 'yes' && ready ? theme.buttonActive : ready ? theme.button : theme.dim;
    const noStyle = state.choice === 'no' ? theme.buttonActive : theme.button;
    f.text(bx, by, yes, yesStyle, yw);
    f.text(bx + yw + 2, by, no, noStyle, nw);
    hit = { yes: { x: bx, y: by, w: yw, h: 1 }, no: { x: bx + yw + 2, y: by, w: nw, h: 1 } };
  });
  return { ...state, input, hit };
}
