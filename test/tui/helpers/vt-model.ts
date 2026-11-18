// A minimal terminal model for tests: applies the subset of escape sequences that renderDiff
// emits (CUP, CUF, ED 2, SGR, DEC private modes, CR, LF, text) to a grid. It does not import
// src/term on purpose. When a write lands on one half of a wide character, the other half
// becomes '#' so a renderer that relies on stale halves fails the comparison.

import { COLOR_DEFAULT, COLOR_RGB } from '../../../src/types.ts';
import type { Frame } from '../../../src/tui/frame.ts';
import { graphemeWidth, graphemes } from '../../../src/width.ts';

export interface ModelCell {
  ch: string;
  w: number;
  fg: number;
  bg: number;
  attrs: number;
}

export class VtModel {
  cols: number;
  rows: number;
  grid: ModelCell[];
  x = 0;
  y = 0;
  pendingWrap = false;
  autowrap = true;
  cursorVisible = true;
  scrolled = 0;
  pen = { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 };
  unknown: string[] = [];

  constructor(cols: number, rows: number, fill = '?') {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: cols * rows }, () => ({ ch: fill, w: 1, fg: 5, bg: 6, attrs: 0 }));
  }

  /** Load the exact content of a frame (the state a previous render left). */
  static fromFrame(f: Frame): VtModel {
    const m = new VtModel(f.cols, f.rows);
    for (let i = 0; i < f.cols * f.rows; i++) {
      m.grid[i] = { ch: f.ch[i]!, w: f.wid[i]!, fg: f.fg[i]!, bg: f.bg[i]!, attrs: f.attrs[i]! };
    }
    m.x = f.cursor.x;
    m.y = f.cursor.y;
    m.cursorVisible = f.cursor.visible;
    // The pen state after a render is not known to the next render; make it hostile.
    m.pen = { fg: 3, bg: 4, attrs: 1 };
    return m;
  }

  private cell(x: number, y: number): ModelCell {
    return this.grid[y * this.cols + x]!;
  }

  private lineFeed(): void {
    if (this.y === this.rows - 1) {
      this.scrolled++;
      this.grid.splice(0, this.cols);
      for (let i = 0; i < this.cols; i++) this.grid.push({ ch: ' ', w: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
    } else this.y++;
  }

  private breakAt(x: number): void {
    const c = this.cell(x, this.y);
    if (c.w === 0 && x > 0) Object.assign(this.cell(x - 1, this.y), { ch: '#', w: 1 });
    if (c.w === 2 && x + 1 < this.cols) Object.assign(this.cell(x + 1, this.y), { ch: '#', w: 1 });
  }

  private print(g: string): void {
    const w = graphemeWidth(g);
    if (w === 0) return;
    if (this.pendingWrap && this.autowrap) {
      this.x = 0;
      this.lineFeed();
    }
    this.pendingWrap = false;
    if (this.x + w > this.cols) {
      if (this.autowrap) {
        this.x = 0;
        this.lineFeed();
      } else return;
    }
    this.breakAt(this.x);
    if (w === 2) this.breakAt(this.x + 1);
    const p = this.pen;
    Object.assign(this.cell(this.x, this.y), { ch: g, w, fg: p.fg, bg: p.bg, attrs: p.attrs });
    if (w === 2) Object.assign(this.cell(this.x + 1, this.y), { ch: '', w: 0, fg: p.fg, bg: p.bg, attrs: p.attrs });
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      if (this.autowrap) this.pendingWrap = true;
    }
  }

  private sgr(params: number[]): void {
    if (params.length === 0) params = [0];
    const p = this.pen;
    for (let i = 0; i < params.length; i++) {
      const n = params[i]!;
      if (n === 0) Object.assign(p, { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
      else if (n >= 1 && n <= 9) p.attrs |= [0, 1, 2, 4, 8, 64, 0, 16, 128, 32][n]!;
      else if (n === 22) p.attrs &= ~3;
      else if (n === 23) p.attrs &= ~4;
      else if (n === 24) p.attrs &= ~8;
      else if (n === 25) p.attrs &= ~64;
      else if (n === 27) p.attrs &= ~16;
      else if (n === 28) p.attrs &= ~128;
      else if (n === 29) p.attrs &= ~32;
      else if (n >= 30 && n <= 37) p.fg = n - 30;
      else if (n >= 40 && n <= 47) p.bg = n - 40;
      else if (n >= 90 && n <= 97) p.fg = n - 90 + 8;
      else if (n >= 100 && n <= 107) p.bg = n - 100 + 8;
      else if (n === 39) p.fg = COLOR_DEFAULT;
      else if (n === 49) p.bg = COLOR_DEFAULT;
      else if (n === 38 || n === 48) {
        let c: number;
        if (params[i + 1] === 5) {
          c = params[i + 2]!;
          i += 2;
        } else {
          c = COLOR_RGB | (params[i + 2]! << 16) | (params[i + 3]! << 8) | params[i + 4]!;
          i += 4;
        }
        if (n === 38) p.fg = c;
        else p.bg = c;
      } else this.unknown.push(`SGR ${n}`);
    }
  }

  apply(data: string): void {
    let i = 0;
    let text = '';
    const flushText = (): void => {
      for (const g of graphemes(text)) this.print(g);
      text = '';
    };
    while (i < data.length) {
      const c = data[i]!;
      if (c === '\x1b') {
        flushText();
        if (data[i + 1] !== '[') {
          this.unknown.push(JSON.stringify(data.slice(i, i + 2)));
          i += 2;
          continue;
        }
        let j = i + 2;
        let priv = '';
        if (data[j] === '?') {
          priv = '?';
          j++;
        }
        const start = j;
        while (j < data.length && /[0-9;]/.test(data[j]!)) j++;
        const final = data[j]!;
        const params = data.slice(start, j).split(';').filter((s) => s !== '').map(Number);
        i = j + 1;
        if (priv) {
          for (const mode of params) {
            if (mode === 7) {
              this.autowrap = final === 'h';
              if (!this.autowrap) this.pendingWrap = false;
            } else if (mode === 25) this.cursorVisible = final === 'h';
            else if (mode !== 2026) this.unknown.push(`mode ${mode}`);
          }
          continue;
        }
        this.pendingWrap = false;
        switch (final) {
          case 'H':
            this.y = Math.min(this.rows - 1, (params[0] ?? 1) - 1);
            this.x = Math.min(this.cols - 1, (params[1] ?? 1) - 1);
            break;
          case 'C':
            this.x = Math.min(this.cols - 1, this.x + (params[0] ?? 1));
            break;
          case 'J':
            if (params[0] === 2) {
              for (const cell of this.grid) Object.assign(cell, { ch: ' ', w: 1, fg: COLOR_DEFAULT, bg: this.pen.bg, attrs: 0 });
            } else this.unknown.push('J');
            break;
          case 'm':
            this.sgr(params);
            break;
          default:
            this.unknown.push(`CSI ${final}`);
        }
        continue;
      }
      if (c === '\r') {
        flushText();
        this.x = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }
      if (c === '\n') {
        flushText();
        this.pendingWrap = false;
        this.lineFeed();
        i++;
        continue;
      }
      text += c;
      i++;
    }
    flushText();
  }

  /** Differences between the model and a frame, as readable strings (empty when equal). */
  diff(f: Frame): string[] {
    const out: string[] = [];
    for (let y = 0; y < f.rows; y++) {
      for (let x = 0; x < f.cols; x++) {
        const i = y * f.cols + x;
        const m = this.grid[i]!;
        const want = { ch: f.ch[i]!, w: f.wid[i]!, fg: f.fg[i]!, bg: f.bg[i]!, attrs: f.attrs[i]! };
        if (m.ch !== want.ch || m.w !== want.w || m.fg !== want.fg || m.bg !== want.bg || m.attrs !== want.attrs) {
          out.push(`(${x},${y}) got ${JSON.stringify(m)} want ${JSON.stringify(want)}`);
        }
      }
    }
    return out;
  }
}
