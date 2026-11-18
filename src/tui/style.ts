// Styles, the theme, color depth conversion and SGR (Select Graphic Rendition) output.

import { ATTR, COLOR_DEFAULT, COLOR_RGB } from '../types.ts';
import type { Color, SessionStatus } from '../types.ts';

export interface Style {
  fg: Color;
  bg: Color;
  attrs: number;
}

export type ColorDepth = 'truecolor' | '256' | '16';

export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({ fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });

/** Make a style. Missing parts are the terminal defaults. */
export function style(fg: Color = COLOR_DEFAULT, bg: Color = COLOR_DEFAULT, attrs = 0): Style {
  return { fg, bg, attrs };
}

/** Copy of `base` with some parts replaced. */
export function withStyle(base: Style, change: Partial<Style>): Style {
  return { fg: change.fg ?? base.fg, bg: change.bg ?? base.bg, attrs: change.attrs ?? base.attrs };
}

export function rgb(r: number, g: number, b: number): Color {
  return COLOR_RGB | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

export function isRgb(c: Color): boolean {
  return c >= COLOR_RGB;
}

export function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs;
}

// ---------------------------------------------------------------------------
// Palette and depth conversion
// ---------------------------------------------------------------------------

// xterm default values for the 16 ANSI colors.
const ANSI16: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];

/** RGB value of a 256-palette index (xterm defaults). */
export function paletteRgb(index: number): [number, number, number] {
  if (index < 16) {
    const c = ANSI16[index]!;
    return [c[0], c[1], c[2]];
  }
  if (index < 232) {
    const i = index - 16;
    return [CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!];
  }
  const v = 8 + (index - 232) * 10;
  return [v, v, v];
}

function dist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  // Weighted distance: the eye is most sensitive to green.
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function nearestCube(v: number): number {
  let best = 0;
  for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
  return best;
}

/** Nearest xterm 256-palette index (16..255) for an RGB value. */
export function rgbTo256(r: number, g: number, b: number): number {
  const ri = nearestCube(r);
  const gi = nearestCube(g);
  const bi = nearestCube(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cd = dist(r, g, b, CUBE[ri]!, CUBE[gi]!, CUBE[bi]!);
  const avg = (r + g + b) / 3;
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi2 * 10;
  const gd = dist(r, g, b, gv, gv, gv);
  return gd < cd ? 232 + gi2 : cube;
}

/** Nearest of the 16 ANSI colors for an RGB value. */
export function rgbTo16(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const c = ANSI16[i]!;
    const d = dist(r, g, b, c[0], c[1], c[2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Convert a color for a terminal of the given depth. */
export function convertColor(c: Color, depth: ColorDepth): Color {
  if (c < 0 || depth === 'truecolor') return c;
  if (c >= COLOR_RGB) {
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    return depth === '256' ? rgbTo256(r, g, b) : rgbTo16(r, g, b);
  }
  if (depth === '16' && c >= 16) {
    const [r, g, b] = paletteRgb(c);
    return rgbTo16(r, g, b);
  }
  return c;
}

/**
 * Guess the color depth from the environment. Windows Terminal (WT_SESSION) and COLORTERM
 * truecolor/24bit support 24-bit color. TERM=linux gets 16 colors, a plain *-256color TERM gets
 * the 256 palette, everything else truecolor. NEBULA_COLOR_DEPTH overrides the guess.
 */
export function detectColorDepth(env: Record<string, string | undefined>): ColorDepth {
  const forced = env['NEBULA_COLOR_DEPTH'];
  if (forced === 'truecolor' || forced === '256' || forced === '16') return forced;
  const ct = (env['COLORTERM'] ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env['WT_SESSION']) return 'truecolor';
  const term = env['TERM'] ?? '';
  if (term === 'linux' || term === 'vt100' || term === 'ansi') return '16';
  if (term.includes('256color') && !env['TERM_PROGRAM']) return '256';
  return 'truecolor';
}

// ---------------------------------------------------------------------------
// SGR output
// ---------------------------------------------------------------------------

function colorParams(c: Color, bg: boolean): string {
  if (c < 0) return bg ? '49' : '39';
  if (c >= COLOR_RGB) return `${bg ? 48 : 38};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
  if (c < 8) return String((bg ? 40 : 30) + c);
  if (c < 16) return String((bg ? 100 : 90) + c - 8);
  return `${bg ? 48 : 38};5;${c}`;
}

const ATTR_ON: readonly [number, string][] = [
  [ATTR.bold, '1'], [ATTR.dim, '2'], [ATTR.italic, '3'], [ATTR.underline, '4'],
  [ATTR.blink, '5'], [ATTR.inverse, '7'], [ATTR.hidden, '8'], [ATTR.strike, '9'],
];
const ATTR_OFF: readonly [number, string][] = [
  [ATTR.italic, '23'], [ATTR.underline, '24'], [ATTR.blink, '25'], [ATTR.inverse, '27'],
  [ATTR.hidden, '28'], [ATTR.strike, '29'],
];

/**
 * The shortest SGR sequence that changes the pen from `from` to `to` (colors already converted
 * to the output depth). `from` null means the pen is unknown: a full reset is emitted.
 */
export function sgrTransition(from: Style | null, to: Style): string {
  if (from && sameStyle(from, to)) return '';
  // Full form: reset, then everything that is not default.
  const full: string[] = ['0'];
  for (const [bit, code] of ATTR_ON) if (to.attrs & bit) full.push(code);
  if (to.fg !== COLOR_DEFAULT) full.push(colorParams(to.fg, false));
  if (to.bg !== COLOR_DEFAULT) full.push(colorParams(to.bg, true));
  const fullStr = full.length === 1 ? '\x1b[0m' : `\x1b[${full.join(';')}m`;
  if (!from) return fullStr;

  const inc: string[] = [];
  const removed = from.attrs & ~to.attrs;
  let add = to.attrs & ~from.attrs;
  // 22 turns off both bold and dim; turn the kept one on again.
  if (removed & (ATTR.bold | ATTR.dim)) {
    inc.push('22');
    add |= to.attrs & (ATTR.bold | ATTR.dim);
  }
  for (const [bit, code] of ATTR_OFF) if (removed & bit) inc.push(code);
  for (const [bit, code] of ATTR_ON) if (add & bit) inc.push(code);
  if (from.fg !== to.fg) inc.push(colorParams(to.fg, false));
  if (from.bg !== to.bg) inc.push(colorParams(to.bg, true));
  const incStr = `\x1b[${inc.join(';')}m`;
  return incStr.length <= fullStr.length ? incStr : fullStr;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type BorderKind = 'rounded' | 'single';

export interface Theme {
  border: BorderKind;
  /** Border and title of a panel without focus. */
  borderStyle: Style;
  titleStyle: Style;
  /** Border and title of the panel with focus. */
  borderFocusedStyle: Style;
  titleFocusedStyle: Style;
  text: Style;
  muted: Style;
  dim: Style;
  /** Selected row in the focused panel and in other panels. */
  selection: Style;
  selectionDim: Style;
  /** Non-selectable group header rows. */
  header: Style;
  /** Footer: key names and their descriptions. */
  footerKey: Style;
  footerText: Style;
  /** Modal border, title and body. */
  modalBorder: Style;
  modalTitle: Style;
  modalBody: Style;
  /** Buttons in a modal: the active one and the others. */
  buttonActive: Style;
  button: Style;
  /** Input field text and placeholder. */
  input: Style;
  placeholder: Style;
  /** Fuzzy match highlight. */
  match: Style;
  /** Scrollbar thumb. */
  scrollThumb: Style;
  danger: Style;
  /** Status dot color for each session status. */
  status: Record<SessionStatus, Color>;
}

const ACCENT = 6; // cyan
const RED = 1;
const YELLOW = 3;
const GREEN = 2;
const GRAY = 8;
const EDGE = 240;

/** The default look: cyan accent on ANSI colors, like the Nebula default theme. */
export const defaultTheme: Theme = {
  border: 'rounded',
  borderStyle: style(EDGE),
  titleStyle: style(7),
  borderFocusedStyle: style(ACCENT),
  titleFocusedStyle: style(ACCENT, COLOR_DEFAULT, ATTR.bold),
  text: style(),
  muted: style(7),
  dim: style(GRAY),
  selection: style(COLOR_DEFAULT, 237),
  selectionDim: style(COLOR_DEFAULT, 235),
  header: style(GRAY, COLOR_DEFAULT, ATTR.bold),
  footerKey: style(ACCENT, COLOR_DEFAULT, ATTR.bold),
  footerText: style(GRAY),
  modalBorder: style(ACCENT),
  modalTitle: style(ACCENT, COLOR_DEFAULT, ATTR.bold),
  modalBody: style(),
  buttonActive: style(0, ACCENT, ATTR.bold),
  button: style(7),
  input: style(),
  placeholder: style(GRAY, COLOR_DEFAULT, ATTR.italic),
  match: style(ACCENT, COLOR_DEFAULT, ATTR.bold),
  scrollThumb: style(7),
  danger: style(RED, COLOR_DEFAULT, ATTR.bold),
  status: { 'needs-input': RED, working: YELLOW, unseen: GREEN, idle: GRAY },
};

/** The status dot glyph and its style. */
export function statusDot(status: SessionStatus, theme: Theme = defaultTheme): { glyph: string; style: Style } {
  return { glyph: '●', style: style(theme.status[status]) };
}
