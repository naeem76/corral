// Character grid of one buffer (primary or alternate).
//
// Each row keeps its cells in typed arrays, so a row is a few allocations, not one object per
// cell. Rows are separate objects so scrolling only moves row references, and a later
// scrollback ring for the primary buffer can take the rows that scroll out at the top
// (see `Screen.scrollUp`, which already hands the old row back for reuse).

import { COLOR_DEFAULT } from '../types.ts';

/** A code with this bit set is an index into the emulator's grapheme table (multi-code-point cluster). */
export const CLUSTER_BIT = 0x40000000;

export class Row {
  /** 0 = blank, code point, or CLUSTER_BIT | table index. */
  codes: Uint32Array;
  fg: Int32Array;
  bg: Int32Array;
  attrs: Uint16Array;
  /** 1 normal, 2 left half of a wide character, 0 right half. */
  width: Uint8Array;
  /** True when the text continues on the next row because of autowrap. */
  wrapped = false;

  constructor(cols: number, bg: number) {
    this.codes = new Uint32Array(cols);
    this.fg = new Int32Array(cols).fill(COLOR_DEFAULT);
    this.bg = new Int32Array(cols).fill(bg);
    this.attrs = new Uint16Array(cols);
    this.width = new Uint8Array(cols).fill(1);
  }

  /** Blank cells [x0, x1) with background bg. Does not repair wide halves outside the range. */
  fill(x0: number, x1: number, bg: number): void {
    if (x1 <= x0) return;
    this.codes.fill(0, x0, x1);
    this.fg.fill(COLOR_DEFAULT, x0, x1);
    this.bg.fill(bg, x0, x1);
    this.attrs.fill(0, x0, x1);
    this.width.fill(1, x0, x1);
  }

  blankCell(x: number): void {
    this.codes[x] = 0;
    this.width[x] = 1;
  }

  /** Blank [x0, x1) and also the other half of any wide character cut at the edges. */
  erase(x0: number, x1: number, bg: number): void {
    const cols = this.codes.length;
    if (x0 < 0) x0 = 0;
    if (x1 > cols) x1 = cols;
    if (x1 <= x0) return;
    if (x0 > 0 && this.width[x0] === 0) this.blankCell(x0 - 1);
    if (x1 < cols && this.width[x1] === 0) this.blankCell(x1);
    this.fill(x0, x1, bg);
  }

  copyCell(from: number, to: number): void {
    this.codes[to] = this.codes[from]!;
    this.fg[to] = this.fg[from]!;
    this.bg[to] = this.bg[from]!;
    this.attrs[to] = this.attrs[from]!;
    this.width[to] = this.width[from]!;
  }

  /** Blank half characters left without their partner after a shift. */
  repairWide(): void {
    const cols = this.codes.length;
    for (let x = 0; x < cols; x++) {
      const w = this.width[x]!;
      if (w === 2 && (x + 1 >= cols || this.width[x + 1] !== 0)) this.blankCell(x);
      else if (w === 0 && (x === 0 || this.width[x - 1] !== 2)) this.blankCell(x);
    }
  }

  /** Insert n blank cells at x, shifting the rest right; cells past the end are lost. */
  insertCells(x: number, n: number, bg: number): void {
    const cols = this.codes.length;
    if (x >= cols) return;
    if (n > cols - x) n = cols - x;
    this.codes.copyWithin(x + n, x, cols - n);
    this.fg.copyWithin(x + n, x, cols - n);
    this.bg.copyWithin(x + n, x, cols - n);
    this.attrs.copyWithin(x + n, x, cols - n);
    this.width.copyWithin(x + n, x, cols - n);
    this.fill(x, x + n, bg);
    this.repairWide();
  }

  /** Delete n cells at x, shifting the rest left; blank cells come in at the end. */
  deleteCells(x: number, n: number, bg: number): void {
    const cols = this.codes.length;
    if (x >= cols) return;
    if (n > cols - x) n = cols - x;
    this.codes.copyWithin(x, x + n, cols);
    this.fg.copyWithin(x, x + n, cols);
    this.bg.copyWithin(x, x + n, cols);
    this.attrs.copyWithin(x, x + n, cols);
    this.width.copyWithin(x, x + n, cols);
    this.fill(cols - n, cols, bg);
    this.repairWide();
  }

  /** New row with `cols` columns that keeps the left part of this row. */
  resized(cols: number): Row {
    const r = new Row(cols, COLOR_DEFAULT);
    const n = Math.min(cols, this.codes.length);
    r.codes.set(this.codes.subarray(0, n));
    r.fg.set(this.fg.subarray(0, n));
    r.bg.set(this.bg.subarray(0, n));
    r.attrs.set(this.attrs.subarray(0, n));
    r.width.set(this.width.subarray(0, n));
    if (n > 0 && r.width[n - 1] === 2) r.blankCell(n - 1);
    r.wrapped = this.wrapped && cols >= this.codes.length;
    return r;
  }
}

export interface SavedCursor {
  x: number;
  y: number;
  fg: number;
  bg: number;
  attrs: number;
  origin: boolean;
  wrapPending: boolean;
  g0: number;
  g1: number;
  gl: number;
}

export class Screen {
  cols: number;
  rows: number;
  lines: Row[];
  /** DECSC state of this buffer (xterm keeps one per buffer). */
  saved: SavedCursor | null = null;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.lines = [];
    for (let y = 0; y < rows; y++) this.lines.push(new Row(cols, COLOR_DEFAULT));
  }

  clear(bg: number): void {
    for (const line of this.lines) {
      line.fill(0, this.cols, bg);
      line.wrapped = false;
    }
  }

  /** Scroll rows [top, bottom] up by n; blank rows with background bg come in at the bottom. */
  scrollUp(top: number, bottom: number, n: number, bg: number): void {
    const height = bottom - top + 1;
    if (n > height) n = height;
    if (n <= 0) return;
    // A scrollback ring would take these rows when top === 0 on the primary buffer.
    const out = this.lines.splice(top, n);
    for (const row of out) {
      row.fill(0, this.cols, bg);
      row.wrapped = false;
    }
    this.lines.splice(bottom - n + 1, 0, ...out);
  }

  /** Scroll rows [top, bottom] down by n; blank rows come in at the top. */
  scrollDown(top: number, bottom: number, n: number, bg: number): void {
    const height = bottom - top + 1;
    if (n > height) n = height;
    if (n <= 0) return;
    const out = this.lines.splice(bottom - n + 1, n);
    for (const row of out) {
      row.fill(0, this.cols, bg);
      row.wrapped = false;
    }
    this.lines.splice(top, 0, ...out);
  }

  resize(cols: number, rows: number): void {
    const lines: Row[] = [];
    for (let y = 0; y < rows; y++) {
      const old = this.lines[y];
      lines.push(old ? (cols === this.cols ? old : old.resized(cols)) : new Row(cols, COLOR_DEFAULT));
    }
    this.lines = lines;
    this.cols = cols;
    this.rows = rows;
    if (this.saved) {
      this.saved.x = Math.min(this.saved.x, cols - 1);
      this.saved.y = Math.min(this.saved.y, rows - 1);
    }
  }
}
