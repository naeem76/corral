// A cell frame buffer and the diff renderer that turns one frame into the next on the terminal.
//
// Cell layout follows `Cell` in types.ts: width 1 = normal, 2 = left half of a wide character,
// 0 = right half (empty `ch`). Every write keeps wide pairs whole: a write over one half of a
// wide character turns the other half into a space.

import { COLOR_DEFAULT } from '../types.ts';
import type { Cell, ScreenView } from '../types.ts';
import { graphemeWidth, graphemes, stringWidth } from '../width.ts';
import { DEFAULT_STYLE, convertColor, sgrTransition } from './style.ts';
import type { BorderKind, ColorDepth, Style } from './style.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxOptions {
  border?: BorderKind;
  /** Style of the title text. Default: the border style. */
  titleStyle?: Style;
  /** Fill the inside with this style first. */
  fill?: Style;
}

const BORDERS: Record<BorderKind, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};

// Graphemes that hold a control character are drawn as a space.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** Cut `str` to at most `width` cells, ending with "…" when it was cut. */
export function truncate(str: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(str) <= width) return str;
  let used = 0;
  let out = '';
  for (const g of graphemes(str)) {
    const w = graphemeWidth(g);
    if (used + w > width - 1) break;
    out += g;
    used += w;
  }
  return out + '…';
}

/** Cut `str` to at most `width` cells, keeping the end and starting with "…" when it was cut. */
export function truncateStart(str: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(str) <= width) return str;
  const gs = graphemes(str);
  let used = 0;
  let start = gs.length;
  while (start > 0) {
    const w = graphemeWidth(gs[start - 1]!);
    if (used + w > width - 1) break;
    used += w;
    start--;
  }
  return '…' + gs.slice(start).join('');
}

/** Wrap text into lines of at most `width` cells. Breaks at spaces when it can. */
export function wrapText(str: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const para of str.split('\n')) {
    let line = '';
    let lineW = 0;
    for (const word of para.split(/(\s+)/)) {
      if (word.length === 0) continue;
      const ww = stringWidth(word);
      if (lineW + ww <= width) {
        line += word;
        lineW += ww;
        continue;
      }
      if (/^\s+$/.test(word)) {
        lines.push(line);
        line = '';
        lineW = 0;
        continue;
      }
      if (lineW > 0) lines.push(line.trimEnd());
      line = '';
      lineW = 0;
      // A word longer than the line is split by grapheme.
      for (const g of graphemes(word)) {
        const gw = graphemeWidth(g);
        if (lineW + gw > width) {
          lines.push(line);
          line = '';
          lineW = 0;
        }
        line += g;
        lineW += gw;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export class Frame {
  readonly cols: number;
  readonly rows: number;
  /** Graphemes, row-major. */
  readonly ch: string[];
  readonly wid: Uint8Array;
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly attrs: Uint16Array;
  readonly cursor = { x: 0, y: 0, visible: false };
  private clips: Rect[] = [];
  private clipRect: Rect;
  private scratch: Cell = { ch: '', width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 };

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, Math.floor(cols));
    this.rows = Math.max(0, Math.floor(rows));
    const n = this.cols * this.rows;
    this.ch = new Array<string>(n).fill(' ');
    this.wid = new Uint8Array(n).fill(1);
    this.fg = new Int32Array(n).fill(COLOR_DEFAULT);
    this.bg = new Int32Array(n).fill(COLOR_DEFAULT);
    this.attrs = new Uint16Array(n);
    this.clipRect = { x: 0, y: 0, w: this.cols, h: this.rows };
  }

  /** Current clip rectangle (intersection of every pushed clip and the frame). */
  get clip(): Readonly<Rect> {
    return this.clipRect;
  }

  /** Restrict drawing to `r` (intersected with the current clip) until `popClip`. */
  pushClip(r: Rect): void {
    this.clips.push(this.clipRect);
    const c = this.clipRect;
    const x1 = Math.max(c.x, r.x);
    const y1 = Math.max(c.y, r.y);
    const x2 = Math.min(c.x + c.w, r.x + r.w);
    const y2 = Math.min(c.y + c.h, r.y + r.h);
    this.clipRect = { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  popClip(): void {
    const c = this.clips.pop();
    if (c) this.clipRect = c;
  }

  inClip(x: number, y: number): boolean {
    const c = this.clipRect;
    return x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h;
  }

  /** Fill the whole frame (ignores the clip) and reset the cursor to hidden. */
  clear(st: Style = DEFAULT_STYLE): void {
    this.ch.fill(' ');
    this.wid.fill(1);
    this.fg.fill(st.fg);
    this.bg.fill(st.bg);
    this.attrs.fill(st.attrs);
    this.cursor.x = 0;
    this.cursor.y = 0;
    this.cursor.visible = false;
  }

  /** Read one cell (for tests and hit checks). */
  getCell(x: number, y: number, out?: Cell): Cell {
    const c = out ?? { ch: '', width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 };
    const i = y * this.cols + x;
    c.ch = this.ch[i] ?? ' ';
    c.width = this.wid[i] ?? 1;
    c.fg = this.fg[i] ?? COLOR_DEFAULT;
    c.bg = this.bg[i] ?? COLOR_DEFAULT;
    c.attrs = this.attrs[i] ?? 0;
    return c;
  }

  /** Text of one row; right halves of wide characters are left out. For tests and debugging. */
  rowText(y: number): string {
    let s = '';
    for (let x = 0; x < this.cols; x++) {
      const i = y * this.cols + x;
      if (this.wid[i] !== 0) s += this.ch[i];
    }
    return s;
  }

  /** Turn the other half of a wide character at (x, y) into a space. */
  private breakWide(x: number, y: number): void {
    const i = y * this.cols + x;
    const w = this.wid[i];
    if (w === 0 && x > 0 && this.wid[i - 1] === 2) {
      this.ch[i - 1] = ' ';
      this.wid[i - 1] = 1;
    } else if (w === 2 && x + 1 < this.cols && this.wid[i + 1] === 0) {
      this.ch[i + 1] = ' ';
      this.wid[i + 1] = 1;
    }
  }

  /** Set one cell without the clip check. `w` is 1 or 2; 2 also sets the right half. */
  private setCell(x: number, y: number, g: string, w: number, fg: number, bg: number, at: number): void {
    this.breakWide(x, y);
    const i = y * this.cols + x;
    this.ch[i] = g;
    this.wid[i] = w;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.attrs[i] = at;
    if (w === 2) {
      this.breakWide(x + 1, y);
      this.ch[i + 1] = '';
      this.wid[i + 1] = 0;
      this.fg[i + 1] = fg;
      this.bg[i + 1] = bg;
      this.attrs[i + 1] = at;
    }
  }

  /**
   * Draw one grapheme. Returns the cells it takes (0 when clipped). A wide grapheme without
   * room for its right half becomes a space.
   */
  put(x: number, y: number, g: string, st: Style): number {
    if (!this.inClip(x, y)) return 0;
    let w: number = graphemeWidth(g);
    if (w === 0 || CONTROL.test(g)) {
      g = ' ';
      w = 1;
    }
    if (w === 2 && !this.inClip(x + 1, y)) {
      g = ' ';
      w = 1;
    }
    this.setCell(x, y, g, w, st.fg, st.bg, st.attrs);
    return w;
  }

  /**
   * Draw text from (x, y), at most `maxWidth` cells, clipped by the clip rectangle.
   * Returns the column after the last cell that the text reached.
   */
  text(x: number, y: number, str: string, st: Style, maxWidth = Infinity): number {
    const c = this.clipRect;
    if (y < c.y || y >= c.y + c.h) return x;
    const limit = Math.min(c.x + c.w, x + Math.max(0, maxWidth));
    let cx = x;
    for (let g of graphemes(str)) {
      if (cx >= limit) break;
      let w: number = graphemeWidth(g);
      if (CONTROL.test(g)) {
        g = ' ';
        w = 1;
      }
      if (w === 0) continue;
      if (cx + w > limit) {
        // A wide character cut by the edge becomes a space.
        if (cx >= c.x) this.setCell(cx, y, ' ', 1, st.fg, st.bg, st.attrs);
        cx++;
        break;
      }
      if (cx >= c.x) this.setCell(cx, y, g, w, st.fg, st.bg, st.attrs);
      else if (w === 2 && cx + 1 === c.x) this.setCell(cx + 1, y, ' ', 1, st.fg, st.bg, st.attrs);
      cx += w;
    }
    return cx;
  }

  fillRect(x: number, y: number, w: number, h: number, st: Style, ch = ' '): void {
    const c = this.clipRect;
    const x1 = Math.max(x, c.x);
    const y1 = Math.max(y, c.y);
    const x2 = Math.min(x + w, c.x + c.w);
    const y2 = Math.min(y + h, c.y + c.h);
    // Only narrow fill characters; a wide one would not tile the rectangle.
    const g = graphemeWidth(ch) === 1 && !CONTROL.test(ch) ? ch : ' ';
    for (let yy = y1; yy < y2; yy++) {
      for (let xx = x1; xx < x2; xx++) this.setCell(xx, yy, g, 1, st.fg, st.bg, st.attrs);
    }
  }

  hline(x: number, y: number, w: number, st: Style, ch = '─'): void {
    for (let i = 0; i < w; i++) this.put(x + i, y, ch, st);
  }

  vline(x: number, y: number, h: number, st: Style, ch = '│'): void {
    for (let i = 0; i < h; i++) this.put(x, y + i, ch, st);
  }

  /** Draw a border box. The title sits in the top border: "╭─ Title ───╮". */
  box(x: number, y: number, w: number, h: number, st: Style, title?: string, opts: BoxOptions = {}): void {
    if (w <= 0 || h <= 0) return;
    const b = BORDERS[opts.border ?? 'rounded'];
    if (opts.fill && w > 2 && h > 2) this.fillRect(x + 1, y + 1, w - 2, h - 2, opts.fill);
    if (w === 1 || h === 1) {
      if (h === 1) this.hline(x, y, w, st, b.h);
      else this.vline(x, y, h, st, b.v);
      return;
    }
    this.put(x, y, b.tl, st);
    this.put(x + w - 1, y, b.tr, st);
    this.put(x, y + h - 1, b.bl, st);
    this.put(x + w - 1, y + h - 1, b.br, st);
    this.hline(x + 1, y, w - 2, st, b.h);
    this.hline(x + 1, y + h - 1, w - 2, st, b.h);
    this.vline(x, y + 1, h - 2, st, b.v);
    this.vline(x + w - 1, y + 1, h - 2, st, b.v);
    if (title && w > 4) {
      const t = ` ${truncate(title, w - 6)} `;
      this.text(x + 2, y, t, opts.titleStyle ?? st, w - 4);
    }
  }

  /**
   * Copy a w×h block of cells from an emulator grid at (srcX, srcY) to (dstX, dstY). Cells
   * outside the source become blank. A wide character cut by the region or the clip becomes a
   * space, so the frame never holds half a wide character.
   */
  blit(view: ScreenView, dstX: number, dstY: number, w: number, h: number, srcX = 0, srcY = 0): void {
    const cell = this.scratch;
    for (let r = 0; r < h; r++) {
      const dy = dstY + r;
      const sy = srcY + r;
      let wideAt = -1;
      for (let c = 0; c < w; c++) {
        const dx = dstX + c;
        if (!this.inClip(dx, dy)) continue;
        const sx = srcX + c;
        if (sy < 0 || sy >= view.rows || sx < 0 || sx >= view.cols) {
          this.setCell(dx, dy, ' ', 1, COLOR_DEFAULT, COLOR_DEFAULT, 0);
          continue;
        }
        view.readCell(sx, sy, cell);
        if (cell.width === 0) {
          if (wideAt === dx - 1) continue;
          this.setCell(dx, dy, ' ', 1, cell.fg, cell.bg, cell.attrs);
          continue;
        }
        let g = cell.ch;
        if (g === '' || CONTROL.test(g)) g = ' ';
        if (cell.width === 2) {
          if (c + 1 < w && this.inClip(dx + 1, dy) && sx + 1 < view.cols) {
            this.setCell(dx, dy, g, 2, cell.fg, cell.bg, cell.attrs);
            wideAt = dx;
          } else {
            this.setCell(dx, dy, ' ', 1, cell.fg, cell.bg, cell.attrs);
          }
          continue;
        }
        this.setCell(dx, dy, g, 1, cell.fg, cell.bg, cell.attrs);
      }
    }
  }

  /** Where the terminal cursor goes after this frame is drawn. */
  setCursor(x: number, y: number, visible: boolean): void {
    this.cursor.x = Math.max(0, Math.min(this.cols - 1, Math.floor(x)));
    this.cursor.y = Math.max(0, Math.min(this.rows - 1, Math.floor(y)));
    this.cursor.visible = visible;
  }
}

export function createFrame(cols: number, rows: number): Frame {
  return new Frame(cols, rows);
}

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Color depth of the outer terminal. Default truecolor. */
  depth?: ColorDepth;
  /** Wrap the output in synchronized-update markers (CSI ? 2026 h/l). Default true. */
  sync?: boolean;
}

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

/**
 * The escape sequences that turn a terminal showing `prev` into `next`. `prev` null (or a
 * different size) gives a full repaint. Returns '' when nothing changed.
 */
export function renderDiff(prev: Frame | null, next: Frame, opts: RenderOptions = {}): string {
  const depth = opts.depth ?? 'truecolor';
  const cols = next.cols;
  const rows = next.rows;
  const full = !prev || prev.cols !== cols || prev.rows !== rows;
  const base = full ? null : prev;
  const parts: string[] = [];
  let pen: Style | null = null;
  // Cursor position as the terminal sees it; -1 means unknown.
  let cx = -1;
  let cy = -1;

  if (full) {
    parts.push('\x1b[0m\x1b[H\x1b[2J');
    pen = { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 };
    cx = 0;
    cy = 0;
  }

  const dirty = new Uint8Array(cols + 1);
  const target: Style = { fg: 0, bg: 0, attrs: 0 };
  let changed = false;

  const differs = (i: number): boolean => {
    if (!base) {
      return next.ch[i] !== ' ' || next.wid[i] !== 1 || next.fg[i] !== COLOR_DEFAULT ||
        next.bg[i] !== COLOR_DEFAULT || next.attrs[i] !== 0;
    }
    return base.ch[i] !== next.ch[i] || base.wid[i] !== next.wid[i] || base.fg[i] !== next.fg[i] ||
      base.bg[i] !== next.bg[i] || base.attrs[i] !== next.attrs[i];
  };

  const moveTo = (x: number, y: number): void => {
    if (cx === x && cy === y) return;
    if (cy === y && cx >= 0 && x > cx) {
      const n = x - cx;
      parts.push(n === 1 ? '\x1b[C' : `\x1b[${n}C`);
    } else if (x === 0 && cx >= 0 && cy >= 0 && y === cy + 1) {
      parts.push('\r\n');
    } else {
      parts.push(x === 0 ? `\x1b[${y + 1}H` : `\x1b[${y + 1};${x + 1}H`);
    }
    cx = x;
    cy = y;
  };

  const setPen = (i: number): void => {
    target.fg = convertColor(next.fg[i]!, depth);
    target.bg = convertColor(next.bg[i]!, depth);
    target.attrs = next.attrs[i]!;
    const s = sgrTransition(pen, target);
    if (s) {
      parts.push(s);
      pen = { fg: target.fg, bg: target.bg, attrs: target.attrs };
    }
  };

  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    let any = false;
    for (let x = 0; x < cols; x++) {
      const d = differs(row + x) ? 1 : 0;
      dirty[x] = d;
      if (d) any = true;
    }
    if (!any) continue;
    // A wide character is written whole: if either half changed, both are dirty.
    for (let x = 0; x < cols - 1; x++) {
      const wideNext = next.wid[row + x] === 2;
      const widePrev = base !== null && base.wid[row + x] === 2;
      if ((wideNext || widePrev) && (dirty[x] || dirty[x + 1])) {
        dirty[x] = 1;
        dirty[x + 1] = 1;
      }
    }
    changed = true;
    for (let x = 0; x < cols; x++) {
      if (!dirty[x]) continue;
      const i = row + x;
      let w = next.wid[i]!;
      let g = next.ch[i]!;
      if (w === 0) {
        if (x > 0 && next.wid[i - 1] === 2) continue; // written with its left half
        w = 1;
        g = ' ';
      } else if (w === 2 && x + 1 >= cols) {
        w = 1;
        g = ' ';
      }
      if (g === '') g = ' ';
      // Rewriting a short gap of plain cells in the current style is shorter than a move.
      if (cy === y && cx >= 0 && x > cx && x - cx <= 3) {
        let ok = true;
        for (let k = cx; k < x && ok; k++) {
          const j = row + k;
          const c = next.ch[j]!;
          ok = next.wid[j] === 1 && c.length === 1 && c >= ' ' && c <= '~' && pen !== null &&
            convertColor(next.fg[j]!, depth) === pen.fg && convertColor(next.bg[j]!, depth) === pen.bg &&
            next.attrs[j] === pen.attrs;
        }
        if (ok) {
          for (let k = cx; k < x; k++) parts.push(next.ch[row + k]!);
          cx = x;
        }
      }
      moveTo(x, y);
      setPen(i);
      const lastCell = y === rows - 1 && x + w >= cols;
      // Autowrap off for the bottom-right cell, so the terminal cannot scroll.
      if (lastCell) parts.push('\x1b[?7l', g, '\x1b[?7h');
      else parts.push(g);
      cx += w;
      // After the last column the cursor is in the pending-wrap state; after a wide or
      // complex grapheme the terminal may disagree on its width. Re-address next time.
      if (cx >= cols || w === 2 || g.length > 1) cx = -1;
    }
  }

  const cur = next.cursor;
  const cursorChanged = !base || base.cursor.x !== cur.x || base.cursor.y !== cur.y || base.cursor.visible !== cur.visible;
  if (!changed && !cursorChanged) return '';

  if (pen !== null) {
    const p = pen as Style;
    if (p.fg !== COLOR_DEFAULT || p.bg !== COLOR_DEFAULT || p.attrs !== 0) parts.push('\x1b[0m');
  }
  if (cur.visible) {
    if (cx !== cur.x || cy !== cur.y) parts.push(`\x1b[${cur.y + 1};${cur.x + 1}H`);
    parts.push('\x1b[?25h');
  } else {
    parts.push('\x1b[?25l');
  }
  const body = (changed && (!base || base.cursor.visible) ? '\x1b[?25l' : '') + parts.join('');
  return opts.sync === false ? body : SYNC_ON + body + SYNC_OFF;
}
