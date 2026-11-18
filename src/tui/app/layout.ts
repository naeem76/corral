// Screen layout of the projects view: three list columns at the left, the pane at the right,
// one footer row. Pure function of the window size and a few flags.

import type { Rect } from '../frame.ts';
import { inset } from '../widgets/layout.ts';

export const DEFAULT_WIDTHS: readonly [number, number, number] = [26, 30, 36];
const MIN_WIDTHS: readonly [number, number, number] = [14, 16, 20];
/** Below this pane width the pane is hidden behind the columns. */
export const PANE_MIN = 40;

export interface AppLayout {
  screen: Rect;
  footer: Rect;
  /** Outer rectangles of Projects, Git, Sessions; null when the columns are hidden. */
  columns: [Rect, Rect, Rect] | null;
  /** Outer rectangle of the pane; null when hidden. */
  pane: Rect | null;
  /** Where the emulator grid goes. */
  paneInner: Rect | null;
  /** True when the pane is drawn without a border (zoom or a narrow window). */
  paneBare: boolean;
}

export interface LayoutInput {
  cols: number;
  rows: number;
  widths?: readonly number[] | undefined;
  /** The pane has focus. */
  paneFocused: boolean;
  /** Zoom is on: a focused pane takes the whole window. */
  zoom: boolean;
}

export function sanitizeWidths(w: readonly unknown[] | undefined): [number, number, number] {
  const out: [number, number, number] = [...DEFAULT_WIDTHS];
  if (!Array.isArray(w)) return out;
  for (let i = 0; i < 3; i++) {
    const v = w[i];
    if (typeof v === 'number' && Number.isFinite(v)) out[i] = Math.max(MIN_WIDTHS[i] as number, Math.min(120, Math.floor(v)));
  }
  return out;
}

/** Scale widths to fit `total`, keeping each one at least `min`. */
function fit(widths: readonly number[], total: number, mins: readonly number[]): number[] {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum <= total) return [...widths];
  const out = widths.map((w, i) => Math.max(mins[i] as number, Math.floor((w * total) / sum)));
  // Rounding and the minimums can overshoot: take the rest from the widest column.
  let over = out.reduce((a, b) => a + b, 0) - total;
  while (over > 0) {
    let k = 0;
    for (let i = 1; i < out.length; i++) if ((out[i] as number) > (out[k] as number)) k = i;
    if ((out[k] as number) <= 1) break;
    out[k] = (out[k] as number) - 1;
    over--;
  }
  return out;
}

function columnsAt(x: number, y: number, h: number, widths: readonly number[]): [Rect, Rect, Rect] {
  const r: Rect[] = [];
  let cx = x;
  for (const w of widths) {
    r.push({ x: cx, y, w, h });
    cx += w;
  }
  return r as [Rect, Rect, Rect];
}

export function computeLayout(input: LayoutInput): AppLayout {
  const cols = Math.max(1, input.cols);
  const rows = Math.max(2, input.rows);
  const screen: Rect = { x: 0, y: 0, w: cols, h: rows };
  const footer: Rect = { x: 0, y: rows - 1, w: cols, h: 1 };
  const mainH = rows - 1;
  const full = (): AppLayout => {
    const pane: Rect = { x: 0, y: 0, w: cols, h: mainH };
    return { screen, footer, columns: null, pane, paneInner: pane, paneBare: true };
  };
  if (input.paneFocused && input.zoom) return full();

  const widths = sanitizeWidths(input.widths);
  const sum = widths[0] + widths[1] + widths[2];
  if (cols - sum >= PANE_MIN) {
    const columns = columnsAt(0, 0, mainH, widths);
    const pane: Rect = { x: sum, y: 0, w: cols - sum, h: mainH };
    return { screen, footer, columns, pane, paneInner: inset(pane, 1), paneBare: false };
  }
  const room = cols - PANE_MIN;
  const minSum = MIN_WIDTHS[0] + MIN_WIDTHS[1] + MIN_WIDTHS[2];
  if (room >= minSum) {
    const w = fit(widths, room, MIN_WIDTHS);
    const used = w.reduce((a, b) => a + b, 0);
    const columns = columnsAt(0, 0, mainH, w);
    const pane: Rect = { x: used, y: 0, w: cols - used, h: mainH };
    return { screen, footer, columns, pane, paneInner: inset(pane, 1), paneBare: false };
  }
  // Too narrow for both: focus decides what is shown.
  if (input.paneFocused) return full();
  const w = fit(widths, cols, [6, 6, 6]);
  // Give the rounding rest to the last column so the columns fill the window.
  const used = w.reduce((a, b) => a + b, 0);
  w[2] = (w[2] as number) + Math.max(0, cols - used);
  return { screen, footer, columns: columnsAt(0, 0, mainH, w), pane: null, paneInner: null, paneBare: false };
}
