// Terminal emulator: parser dispatch, cursor, modes, SGR and replies to terminal queries.
// Output only: keyboard and mouse input go to the PTY directly from the outer terminal.

import { ATTR, COLOR_DEFAULT, COLOR_RGB } from '../types.ts';
import type { Cell, Emulator, MouseTracking, TermModes } from '../types.ts';
import { codePointWidth, graphemeWidth } from '../width.ts';
import { Parser } from './parser.ts';
import type { ParserHandler } from './parser.ts';
import { CLUSTER_BIT, Row, Screen } from './screen.ts';
import type { SavedCursor } from './screen.ts';

export interface EmulatorOptions {
  /** Default foreground as 0xRRGGBB, reported to OSC 10 queries. */
  defaultFg?: number;
  /** Default background as 0xRRGGBB, reported to OSC 11 queries. */
  defaultBg?: number;
  /** Cursor color as 0xRRGGBB, reported to OSC 12 queries. Default: defaultFg. */
  cursorColor?: number;
  /** Clock in milliseconds, for the synchronized-output safety net. */
  now?: () => number;
  /** Synchronized output is ended by force after this many milliseconds. */
  syncTimeoutMs?: number;
  /** Cell size in pixels, reported to window-size queries (CSI 14 t / 16 t). */
  cellWidthPx?: number;
  cellHeightPx?: number;
}

export type CursorShape = 'block' | 'underline' | 'bar';

const DEFAULT_FG = 0xd0d0d0;
const DEFAULT_BG = 0x101010;
const MAX_CLUSTER_LENGTH = 32;
const MAX_TITLE = 1024;
const CLUSTER_TABLE_COMPACT = 8192;

const ESC = '\x1b';
const CSI = '\x1b[';
const ST = '\x1b\\';

// DEC Special Graphics for 0x5f..0x7e.
const DEC_GRAPHICS = [
  0x00a0, 0x25c6, 0x2592, 0x2409, 0x240c, 0x240d, 0x240a, 0x00b0, 0x00b1, 0x2424, 0x240b, 0x2518,
  0x2510, 0x250c, 0x2514, 0x253c, 0x23ba, 0x23bb, 0x2500, 0x23bc, 0x23bd, 0x251c, 0x2524, 0x2534,
  0x252c, 0x2502, 0x2264, 0x2265, 0x03c0, 0x2260, 0x00a3, 0x00b7,
];

const ASCII_STRINGS: string[] = [];
for (let i = 0; i < 128; i++) ASCII_STRINGS.push(String.fromCharCode(i));

// DEC private modes that DECRQM reports as recognized.
const KNOWN_DEC_MODES = new Set([
  1, 6, 7, 9, 12, 25, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1048, 1049,
  2004, 2026, 2027, 2031,
]);
const KNOWN_ANSI_MODES = new Set([4, 20]);
const MOUSE_MODES: Record<number, MouseTracking> = { 9: 'x10', 1000: 'button', 1002: 'drag', 1003: 'any' };

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function hex4(v: number): string {
  const h = (v & 0xff).toString(16).padStart(2, '0');
  return h + h;
}

function rgbSpec(rgb: number): string {
  return `rgb:${hex4(rgb >> 16)}/${hex4(rgb >> 8)}/${hex4(rgb)}`;
}

/** xterm's default 256-color palette as 0xRRGGBB. */
export function paletteColor(i: number): number {
  const base = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  if (i < 16) return base[i]!;
  if (i < 232) {
    const n = i - 16;
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return (level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6);
  }
  const g = 8 + (i - 232) * 10;
  return (g << 16) | (g << 8) | g;
}

interface ModesState {
  altScreen: boolean;
  appCursorKeys: boolean;
  appKeypad: boolean;
  bracketedPaste: boolean;
  focusEvents: boolean;
  mouse: MouseTracking;
  mouseSgr: boolean;
}

export class Terminal implements Emulator, ParserHandler {
  cols: number;
  rows: number;
  onReply: ((data: string) => void) | null = null;
  title = '';
  cursorShape: CursorShape = 'block';
  cursorBlink = true;

  private parser: Parser;
  private primary: Screen;
  private alt: Screen;
  private buf: Screen;

  // Cursor.
  private x = 0;
  private y = 0;
  private wrapPending = false;
  private readonly cursorObj = { x: 0, y: 0, visible: true };

  // Current pen.
  private fg = COLOR_DEFAULT;
  private bg = COLOR_DEFAULT;
  private attrs = 0;

  // Character sets: 0 ASCII, 1 DEC Special Graphics.
  private g0 = 0;
  private g1 = 0;
  private gl = 0;

  private top = 0;
  private bottom = 0;
  private tabs: Uint8Array;

  // Modes.
  private decModes = new Set<number>();
  private autowrap = true;
  private origin = false;
  private insert = false;
  private newline = false;
  private cursorVisible = true;
  private readonly modesObj: ModesState = {
    altScreen: false,
    appCursorKeys: false,
    appKeypad: false,
    bracketedPaste: false,
    focusEvents: false,
    mouse: 'none',
    mouseSgr: false,
  };

  // Grapheme joining across writes.
  private pendingHigh = 0;
  private lastValid = false;
  private lastX = 0;
  private lastY = 0;
  private joinNext = false;
  private lastCode = 0;
  private lastWidth = 1;

  // Multi-code-point clusters.
  private clusters: string[] = [];
  private clusterIds = new Map<string, number>();
  private cpStrings = new Map<number, string>();

  // Version and synchronized output.
  private versionNum = 0;
  private touched = false;
  private syncOn = false;
  private syncStart = 0;
  private syncPending = false;
  private readonly now: () => number;
  private readonly syncTimeout: number;

  private readonly defaultFg: number;
  private readonly defaultBg: number;
  private readonly cursorColor: number;
  private readonly cellW: number;
  private readonly cellH: number;

  constructor(cols: number, rows: number, options: EmulatorOptions = {}) {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    this.cols = cols;
    this.rows = rows;
    this.primary = new Screen(cols, rows);
    this.alt = new Screen(cols, rows);
    this.buf = this.primary;
    this.bottom = rows - 1;
    this.tabs = new Uint8Array(cols);
    this.resetTabs();
    this.parser = new Parser(this);
    this.now = options.now ?? Date.now;
    this.syncTimeout = options.syncTimeoutMs ?? 1000;
    this.defaultFg = options.defaultFg ?? DEFAULT_FG;
    this.defaultBg = options.defaultBg ?? DEFAULT_BG;
    this.cursorColor = options.cursorColor ?? this.defaultFg;
    this.cellW = options.cellWidthPx ?? 8;
    this.cellH = options.cellHeightPx ?? 16;
    this.decModes.add(7);
    this.decModes.add(25);
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  get cursor(): { readonly x: number; readonly y: number; readonly visible: boolean } {
    const c = this.cursorObj;
    c.x = this.x;
    c.y = this.y;
    c.visible = this.cursorVisible;
    return c;
  }

  get modes(): TermModes {
    return this.modesObj;
  }

  get version(): number {
    this.checkSyncTimeout();
    return this.versionNum;
  }

  /** True while the program holds synchronized output (mode 2026). */
  get synchronized(): boolean {
    return this.syncOn;
  }

  write(data: string): void {
    if (data.length === 0) return;
    this.parser.write(data);
    if (this.clusters.length > CLUSTER_TABLE_COMPACT) this.compactClusters();
    if (this.touched) {
      this.touched = false;
      if (this.syncOn) {
        this.syncPending = true;
        this.checkSyncTimeout();
      } else {
        this.versionNum++;
      }
    }
  }

  readCell(x: number, y: number, out: Cell): Cell {
    const line = x >= 0 && x < this.cols && y >= 0 && y < this.rows ? this.buf.lines[y] : undefined;
    if (!line) {
      out.ch = '';
      out.width = 1;
      out.fg = COLOR_DEFAULT;
      out.bg = COLOR_DEFAULT;
      out.attrs = 0;
      return out;
    }
    out.ch = this.codeString(line.codes[x]!);
    out.width = line.width[x]!;
    out.fg = line.fg[x]!;
    out.bg = line.bg[x]!;
    out.attrs = line.attrs[x]!;
    return out;
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (cols === this.cols && rows === this.rows) return;
    this.primary.resize(cols, rows);
    this.alt.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.tabs = new Uint8Array(cols);
    this.resetTabs();
    if (this.x >= cols) this.x = cols - 1;
    if (this.y >= rows) this.y = rows - 1;
    this.wrapPending = false;
    this.lastValid = false;
    this.bump();
  }

  // -------------------------------------------------------------------------
  // Version
  // -------------------------------------------------------------------------

  private bump(): void {
    if (this.syncOn) this.syncPending = true;
    else this.versionNum++;
  }

  private checkSyncTimeout(): void {
    if (this.syncOn && this.syncPending && this.now() - this.syncStart > this.syncTimeout) {
      // The program forgot to end the frame. Show what it drew; keep waiting for the next.
      this.versionNum++;
      this.syncPending = false;
      this.syncStart = this.now();
    }
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  private codeString(code: number): string {
    if (code === 0) return '';
    if (code < 128) return ASCII_STRINGS[code]!;
    if (code & CLUSTER_BIT) return this.clusters[code & ~CLUSTER_BIT] ?? '';
    let s = this.cpStrings.get(code);
    if (s === undefined) {
      s = String.fromCodePoint(code);
      if (this.cpStrings.size < 4096) this.cpStrings.set(code, s);
    }
    return s;
  }

  private clusterCode(s: string): number {
    let id = this.clusterIds.get(s);
    if (id === undefined) {
      id = this.clusters.length;
      this.clusters.push(s);
      this.clusterIds.set(s, id);
    }
    return CLUSTER_BIT | id;
  }

  /** Drop clusters that no cell refers to any more. */
  private compactClusters(): void {
    const old = this.clusters;
    this.clusters = [];
    this.clusterIds = new Map();
    const remap = (code: number): number => (code & CLUSTER_BIT ? this.clusterCode(old[code & ~CLUSTER_BIT]!) : code);
    for (const screen of [this.primary, this.alt]) {
      for (const line of screen.lines) {
        const codes = line.codes;
        for (let x = 0; x < codes.length; x++) if (codes[x]! & CLUSTER_BIT) codes[x] = remap(codes[x]!);
      }
    }
    this.lastCode = remap(this.lastCode);
  }

  print(data: string, start: number, end: number): void {
    this.touched = true;
    for (let i = start; i < end; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x7f && this.pendingHigh === 0) {
        this.joinNext = false;
        if (c >= 0x5f && (this.gl === 0 ? this.g0 : this.g1) !== 0) {
          this.place(DEC_GRAPHICS[c - 0x5f]!, 1);
          continue;
        }
        this.place(c, 1);
        continue;
      }
      if (this.pendingHigh !== 0) {
        const high = this.pendingHigh;
        this.pendingHigh = 0;
        if (c >= 0xdc00 && c <= 0xdfff) {
          this.printCodePoint(((high - 0xd800) << 10) + (c - 0xdc00) + 0x10000);
          continue;
        }
        this.printCodePoint(0xfffd);
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        if (i + 1 < end) {
          const d = data.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) {
            i++;
            this.printCodePoint(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000);
            continue;
          }
          c = 0xfffd;
        } else {
          // The low half may come in the next write.
          this.pendingHigh = c;
          continue;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        c = 0xfffd;
      }
      this.printCodePoint(c);
    }
  }

  private printCodePoint(cp: number): void {
    const w = cp < 0x7f ? 1 : codePointWidth(cp);
    if (this.lastValid && this.joins(cp, w)) {
      this.combine(cp);
      return;
    }
    this.joinNext = false;
    if (w === 0) return; // A mark with nothing to attach to.
    this.place(cp, w);
  }

  private joins(cp: number, w: number): boolean {
    if (w === 0) return true;
    const prev = this.buf.lines[this.lastY]!.codes[this.lastX]!;
    if (this.joinNext) return PICTOGRAPHIC.test(String.fromCodePoint(cp));
    if (isRegionalIndicator(cp)) return isRegionalIndicator(prev);
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) {
      const first = prev & CLUSTER_BIT ? this.clusters[prev & ~CLUSTER_BIT]!.codePointAt(0)! : prev;
      return first > 0x7f && PICTOGRAPHIC.test(String.fromCodePoint(first));
    }
    return false;
  }

  /** Append cp to the grapheme in the last printed cell. */
  private combine(cp: number): void {
    const line = this.buf.lines[this.lastY]!;
    const x = this.lastX;
    const prev = line.codes[x]!;
    if (prev === 0) return;
    const s = this.codeString(prev) + String.fromCodePoint(cp);
    this.joinNext = cp === 0x200d;
    if (s.length > MAX_CLUSTER_LENGTH) return;
    const code = this.clusterCode(s);
    line.codes[x] = code;
    this.lastCode = code;
    // VS16 turns a narrow pictograph into a two-cell emoji; widen it when there is room.
    if (line.width[x] === 1 && cp === 0xfe0f && graphemeWidth(s) === 2 && x + 1 < this.cols) {
      if (line.width[x + 1] === 2 && x + 2 < this.cols) line.blankCell(x + 2);
      line.width[x] = 2;
      line.codes[x + 1] = 0;
      line.width[x + 1] = 0;
      line.fg[x + 1] = line.fg[x]!;
      line.bg[x + 1] = line.bg[x]!;
      line.attrs[x + 1] = line.attrs[x]!;
      this.lastWidth = 2;
      if (!this.wrapPending && this.y === this.lastY && this.x === x + 1) {
        this.x = x + 2;
        if (this.x >= this.cols) {
          this.x = this.cols - 1;
          this.wrapPending = this.autowrap;
        }
      }
    }
  }

  /** Put one character (code point or cluster code) of width w at the cursor and advance. */
  private place(code: number, w: number): void {
    const cols = this.cols;
    if (w === 2 && cols < 2) w = 1;
    if (this.wrapPending) {
      this.wrapPending = false;
      if (this.autowrap) {
        this.buf.lines[this.y]!.wrapped = true;
        this.x = 0;
        this.index();
      }
    }
    if (w === 2 && this.x === cols - 1) {
      if (this.autowrap) {
        const line = this.buf.lines[this.y]!;
        line.erase(cols - 1, cols, this.bg);
        line.wrapped = true;
        this.x = 0;
        this.index();
      } else {
        this.x = cols - 2;
      }
    }
    const x = this.x;
    const line = this.buf.lines[this.y]!;
    if (this.insert) line.insertCells(x, w, this.bg);
    const width = line.width;
    if (width[x] === 0 && x > 0) line.blankCell(x - 1);
    if (w === 1) {
      if (width[x] === 2 && x + 1 < cols) line.blankCell(x + 1);
    } else if (width[x + 1] === 2 && x + 2 < cols) {
      line.blankCell(x + 2);
    }
    line.codes[x] = code;
    width[x] = w;
    line.fg[x] = this.fg;
    line.bg[x] = this.bg;
    line.attrs[x] = this.attrs;
    if (w === 2) {
      line.codes[x + 1] = 0;
      width[x + 1] = 0;
      line.fg[x + 1] = this.fg;
      line.bg[x + 1] = this.bg;
      line.attrs[x + 1] = this.attrs;
    }
    this.lastValid = true;
    this.lastX = x;
    this.lastY = this.y;
    this.lastCode = code;
    this.lastWidth = w;
    const nx = x + w;
    if (nx >= cols) {
      this.x = cols - 1;
      this.wrapPending = this.autowrap;
    } else {
      this.x = nx;
    }
  }

  // -------------------------------------------------------------------------
  // Cursor and scrolling
  // -------------------------------------------------------------------------

  private moveTo(x: number, y: number): void {
    this.x = x < 0 ? 0 : x >= this.cols ? this.cols - 1 : x;
    this.y = y < 0 ? 0 : y >= this.rows ? this.rows - 1 : y;
    this.wrapPending = false;
  }

  /** CUP/VPA row in origin mode is relative to the scroll region and stays inside it. */
  private moveToOrigin(x: number, y: number): void {
    if (this.origin) {
      y += this.top;
      if (y > this.bottom) y = this.bottom;
    }
    this.moveTo(x, y);
  }

  private index(): void {
    if (this.y === this.bottom) this.buf.scrollUp(this.top, this.bottom, 1, this.bg);
    else if (this.y < this.rows - 1) this.y++;
  }

  private reverseIndex(): void {
    if (this.y === this.top) this.buf.scrollDown(this.top, this.bottom, 1, this.bg);
    else if (this.y > 0) this.y--;
  }

  private resetTabs(): void {
    this.tabs.fill(0);
    for (let x = 8; x < this.cols; x += 8) this.tabs[x] = 1;
  }

  private tabForward(n: number): void {
    let x = this.x;
    while (n-- > 0 && x < this.cols - 1) {
      x++;
      while (x < this.cols - 1 && !this.tabs[x]) x++;
    }
    this.x = x;
  }

  private tabBackward(n: number): void {
    let x = this.x;
    while (n-- > 0 && x > 0) {
      x--;
      while (x > 0 && !this.tabs[x]) x--;
    }
    this.x = x;
    this.wrapPending = false;
  }

  private saveCursor(): void {
    this.buf.saved = {
      x: this.x,
      y: this.y,
      fg: this.fg,
      bg: this.bg,
      attrs: this.attrs,
      origin: this.origin,
      wrapPending: this.wrapPending,
      g0: this.g0,
      g1: this.g1,
      gl: this.gl,
    };
  }

  private restoreCursor(): void {
    const s: SavedCursor | null = this.buf.saved;
    if (!s) {
      this.moveTo(0, 0);
      this.fg = COLOR_DEFAULT;
      this.bg = COLOR_DEFAULT;
      this.attrs = 0;
      this.setOrigin(false);
      this.g0 = this.g1 = this.gl = 0;
      return;
    }
    this.moveTo(s.x, s.y);
    this.wrapPending = s.wrapPending && s.x === this.cols - 1;
    this.fg = s.fg;
    this.bg = s.bg;
    this.attrs = s.attrs;
    this.setOrigin(s.origin);
    this.g0 = s.g0;
    this.g1 = s.g1;
    this.gl = s.gl;
  }

  private setOrigin(on: boolean): void {
    this.origin = on;
    if (on) this.decModes.add(6);
    else this.decModes.delete(6);
  }

  private eraseDisplay(mode: number): void {
    const buf = this.buf;
    const bg = this.bg;
    if (mode === 0) {
      buf.lines[this.y]!.erase(this.x, this.cols, bg);
      for (let y = this.y + 1; y < this.rows; y++) buf.lines[y]!.fill(0, this.cols, bg);
    } else if (mode === 1) {
      for (let y = 0; y < this.y; y++) buf.lines[y]!.fill(0, this.cols, bg);
      buf.lines[this.y]!.erase(0, this.x + 1, bg);
    } else if (mode === 2) {
      buf.clear(bg);
    }
    // Mode 3 clears scrollback, which this emulator does not keep.
    this.wrapPending = false;
  }

  private eraseLine(mode: number): void {
    const line = this.buf.lines[this.y]!;
    if (mode === 0) line.erase(this.x, this.cols, this.bg);
    else if (mode === 1) line.erase(0, this.x + 1, this.bg);
    else if (mode === 2) line.erase(0, this.cols, this.bg);
    this.wrapPending = false;
  }

  private switchScreen(toAlt: boolean, clearAlt: boolean): void {
    if (toAlt) {
      if (clearAlt) this.alt.clear(COLOR_DEFAULT);
      this.buf = this.alt;
    } else {
      this.buf = this.primary;
    }
    this.modesObj.altScreen = toAlt;
    this.lastValid = false;
  }

  private fullReset(): void {
    this.primary = new Screen(this.cols, this.rows);
    this.alt = new Screen(this.cols, this.rows);
    this.buf = this.primary;
    this.x = this.y = 0;
    this.wrapPending = false;
    this.fg = this.bg = COLOR_DEFAULT;
    this.attrs = 0;
    this.g0 = this.g1 = this.gl = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.resetTabs();
    this.decModes.clear();
    this.decModes.add(7);
    this.decModes.add(25);
    this.autowrap = true;
    this.origin = false;
    this.insert = false;
    this.newline = false;
    this.cursorVisible = true;
    Object.assign(this.modesObj, {
      altScreen: false,
      appCursorKeys: false,
      appKeypad: false,
      bracketedPaste: false,
      focusEvents: false,
      mouse: 'none',
      mouseSgr: false,
    });
    this.title = '';
    this.cursorShape = 'block';
    this.cursorBlink = true;
    this.lastValid = false;
    this.joinNext = false;
    this.lastCode = 0;
    this.clusters = [];
    this.clusterIds = new Map();
    if (this.syncOn) {
      this.syncOn = false;
      this.versionNum++;
      this.syncPending = false;
    }
  }

  private softReset(): void {
    this.cursorVisible = true;
    this.decModes.add(25);
    this.setOrigin(false);
    // VT510 turns autowrap off here; keeping it on is what programs expect in practice.
    this.autowrap = true;
    this.decModes.add(7);
    this.insert = false;
    this.modesObj.appCursorKeys = false;
    this.decModes.delete(1);
    this.modesObj.appKeypad = false;
    this.decModes.delete(66);
    this.top = 0;
    this.bottom = this.rows - 1;
    this.fg = this.bg = COLOR_DEFAULT;
    this.attrs = 0;
    this.g0 = this.g1 = this.gl = 0;
    this.buf.saved = null;
    this.wrapPending = false;
  }

  // -------------------------------------------------------------------------
  // Parser callbacks
  // -------------------------------------------------------------------------

  execute(code: number): void {
    this.pendingHigh = 0;
    this.lastValid = false;
    switch (code) {
      case 0x08: // BS
        if (this.x > 0) this.x--;
        this.wrapPending = false;
        break;
      case 0x09: // HT
        this.tabForward(1);
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        if (this.newline) this.x = 0;
        this.index();
        this.wrapPending = false;
        break;
      case 0x0d: // CR
        this.x = 0;
        this.wrapPending = false;
        break;
      case 0x0e: // SO
        this.gl = 1;
        return;
      case 0x0f: // SI
        this.gl = 0;
        return;
      default:
        return; // BEL and the rest change nothing visible.
    }
    this.touched = true;
  }

  esc(inter: number, final: number): void {
    this.pendingHigh = 0;
    this.lastValid = false;
    if (inter === 0) {
      switch (final) {
        case 0x37: // DECSC
          this.saveCursor();
          return;
        case 0x38: // DECRC
          this.restoreCursor();
          break;
        case 0x44: // IND
          this.index();
          this.wrapPending = false;
          break;
        case 0x45: // NEL
          this.x = 0;
          this.index();
          this.wrapPending = false;
          break;
        case 0x48: // HTS
          this.tabs[this.x] = 1;
          return;
        case 0x4d: // RI
          this.reverseIndex();
          this.wrapPending = false;
          break;
        case 0x63: // RIS
          this.parser.reset();
          this.fullReset();
          break;
        case 0x3d: // DECKPAM
          this.modesObj.appKeypad = true;
          this.decModes.add(66);
          break;
        case 0x3e: // DECKPNM
          this.modesObj.appKeypad = false;
          this.decModes.delete(66);
          break;
        default:
          return; // ST, SS2, SS3 and unknown
      }
      this.touched = true;
      return;
    }
    if (inter === 0x28 || inter === 0x29) {
      // Designate G0 / G1.
      const set = final === 0x30 ? 1 : 0;
      if (inter === 0x28) this.g0 = set;
      else this.g1 = set;
      return;
    }
    if (inter === 0x23 && final === 0x38) {
      // DECALN: fill the screen with E.
      for (const line of this.buf.lines) {
        line.fill(0, this.cols, COLOR_DEFAULT);
        line.codes.fill(0x45);
      }
      this.top = 0;
      this.bottom = this.rows - 1;
      this.moveTo(0, 0);
      this.touched = true;
    }
  }

  osc(data: string): void {
    this.lastValid = false;
    const semi = data.indexOf(';');
    const head = semi < 0 ? data : data.slice(0, semi);
    if (!/^\d{1,5}$/.test(head)) return;
    const n = Number(head);
    const rest = semi < 0 ? '' : data.slice(semi + 1);
    switch (n) {
      case 0:
      case 2: {
        const t = rest.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, MAX_TITLE);
        if (t !== this.title) {
          this.title = t;
          this.touched = true;
        }
        return;
      }
      case 4: {
        const parts = rest.split(';');
        for (let k = 0; k + 1 < parts.length; k += 2) {
          const idx = Number(parts[k]);
          if (parts[k + 1] === '?' && Number.isInteger(idx) && idx >= 0 && idx < 256) {
            this.reply(`${ESC}]4;${idx};${rgbSpec(paletteColor(idx))}${ST}`);
          }
        }
        return;
      }
      case 10:
      case 11:
      case 12: {
        const parts = rest.split(';');
        for (let k = 0; k < parts.length && n + k <= 12; k++) {
          if (parts[k] !== '?') continue;
          const code = n + k;
          const rgb = code === 10 ? this.defaultFg : code === 11 ? this.defaultBg : this.cursorColor;
          this.reply(`${ESC}]${code};${rgbSpec(rgb)}${ST}`);
        }
        return;
      }
      default:
        // 1, 7, 8, 52, 66, 99, 104, 110-112, 133, 1337, 7501 and the rest: nothing to show.
        return;
    }
  }

  dcs(_params: Int32Array, _count: number, _prefix: number, inter: number, final: number, data: string): void {
    this.lastValid = false;
    if (inter === 0x2b && final === 0x71) {
      // XTGETTCAP: no capabilities are reported.
      this.reply(`${ESC}P0+r${ST}`);
      return;
    }
    if (inter === 0x24 && final === 0x71) {
      // DECRQSS
      let body: string | null = null;
      if (data === 'm') body = '0m';
      else if (data === 'r') body = `${this.top + 1};${this.bottom + 1}r`;
      else if (data === ' q') {
        const base = this.cursorShape === 'block' ? 1 : this.cursorShape === 'underline' ? 3 : 5;
        body = `${base + (this.cursorBlink ? 0 : 1)} q`;
      }
      this.reply(body === null ? `${ESC}P0$r${ST}` : `${ESC}P1$r${body}${ST}`);
    }
  }

  csi(params: Int32Array, subs: Uint8Array, count: number, prefix: number, inter: number, final: number): void {
    this.pendingHigh = 0;
    const p0 = params[0]!;
    // Most commands treat a missing or zero parameter as 1.
    const n = p0 > 0 ? p0 : 1;
    if (prefix === 0 && inter === 0) {
      if (final !== 0x6d && final !== 0x62) this.lastValid = false;
      switch (final) {
        case 0x40: // ICH
          this.buf.lines[this.y]!.insertCells(this.x, n, this.bg);
          this.wrapPending = false;
          break;
        case 0x41: // CUU
          this.moveTo(this.x, this.y >= this.top ? Math.max(this.y - n, this.top) : this.y - n);
          break;
        case 0x42: // CUD
        case 0x65: // VPR
          this.moveTo(this.x, this.y <= this.bottom ? Math.min(this.y + n, this.bottom) : this.y + n);
          break;
        case 0x43: // CUF
        case 0x61: // HPR
          this.moveTo(this.x + n, this.y);
          break;
        case 0x44: // CUB
          this.moveTo(this.x - n, this.y);
          break;
        case 0x45: // CNL
          this.moveTo(0, this.y <= this.bottom ? Math.min(this.y + n, this.bottom) : this.y + n);
          break;
        case 0x46: // CPL
          this.moveTo(0, this.y >= this.top ? Math.max(this.y - n, this.top) : this.y - n);
          break;
        case 0x47: // CHA
        case 0x60: // HPA
          this.moveTo(n - 1, this.y);
          break;
        case 0x48: // CUP
        case 0x66: // HVP
          this.moveToOrigin(count > 1 && params[1]! > 0 ? params[1]! - 1 : 0, n - 1);
          break;
        case 0x64: // VPA
          this.moveToOrigin(this.x, n - 1);
          break;
        case 0x49: // CHT
          this.tabForward(n);
          break;
        case 0x5a: // CBT
          this.tabBackward(n);
          break;
        case 0x4a: // ED
          this.eraseDisplay(p0 < 0 ? 0 : p0);
          break;
        case 0x4b: // EL
          this.eraseLine(p0 < 0 ? 0 : p0);
          break;
        case 0x4c: // IL
        case 0x4d: // DL
          if (this.y >= this.top && this.y <= this.bottom) {
            if (final === 0x4c) this.buf.scrollDown(this.y, this.bottom, n, this.bg);
            else this.buf.scrollUp(this.y, this.bottom, n, this.bg);
            this.x = 0;
            this.wrapPending = false;
          }
          break;
        case 0x50: // DCH
          this.buf.lines[this.y]!.deleteCells(this.x, n, this.bg);
          this.wrapPending = false;
          break;
        case 0x53: // SU
          this.buf.scrollUp(this.top, this.bottom, n, this.bg);
          break;
        case 0x54: // SD (a 5-parameter form is mouse tracking, ignored)
          if (count <= 1) this.buf.scrollDown(this.top, this.bottom, n, this.bg);
          break;
        case 0x58: // ECH
          this.buf.lines[this.y]!.erase(this.x, Math.min(this.x + n, this.cols), this.bg);
          this.wrapPending = false;
          break;
        case 0x62: // REP
          if (this.lastValid && this.lastCode !== 0) {
            const max = this.cols * this.rows;
            const code = this.lastCode;
            const w = this.lastWidth;
            for (let k = 0; k < n && k < max; k++) this.place(code, w);
          }
          break;
        case 0x63: // DA1
          if (p0 <= 0) this.reply(`${CSI}?62;22c`);
          return;
        case 0x67: // TBC
          if (p0 <= 0) this.tabs[this.x] = 0;
          else if (p0 === 3) this.tabs.fill(0);
          return;
        case 0x68: // SM
        case 0x6c: // RM
          for (let k = 0; k < count; k++) this.setAnsiMode(params[k]!, final === 0x68);
          break;
        case 0x6d: // SGR
          this.sgr(params, subs, count);
          return;
        case 0x6e: // DSR
          if (p0 === 5) this.reply(`${CSI}0n`);
          else if (p0 === 6) this.reply(`${CSI}${this.reportRow()};${this.x + 1}R`);
          return;
        case 0x72: // DECSTBM
          this.setScrollRegion(p0 > 0 ? p0 : 1, count > 1 && params[1]! > 0 ? params[1]! : this.rows);
          break;
        case 0x73: // SCOSC
          this.saveCursor();
          return;
        case 0x75: // SCORC
          this.restoreCursor();
          break;
        case 0x74: // window operations
          this.windowOp(p0);
          return;
        default:
          return;
      }
      this.touched = true;
      return;
    }
    this.lastValid = false;
    if (prefix === 0x3f) {
      // '?'
      if (inter === 0 && (final === 0x68 || final === 0x6c)) {
        // Mode 2026 itself is not a visible change; it counts frames on its own.
        let visible = false;
        for (let k = 0; k < count; k++) {
          const mode = params[k]!;
          this.setDecMode(mode, final === 0x68);
          if (mode !== 2026) visible = true;
        }
        if (visible) this.touched = true;
      } else if (inter === 0x24 && final === 0x70) {
        // DECRQM (DEC)
        const mode = p0 < 0 ? 0 : p0;
        const state = KNOWN_DEC_MODES.has(mode) ? (this.decModes.has(mode) ? 1 : 2) : 0;
        this.reply(`${CSI}?${mode};${state}$y`);
      } else if (inter === 0 && final === 0x6e) {
        if (p0 === 6) this.reply(`${CSI}?${this.reportRow()};${this.x + 1}R`);
        else if (p0 === 996) this.reply(`${CSI}?997;${this.isDarkBackground() ? 1 : 2}n`);
      }
      // CSI ? u (kitty keyboard query) gets no reply on purpose: "not supported".
      return;
    }
    if (prefix === 0x3e) {
      // '>'
      if (inter === 0 && final === 0x63) {
        if (p0 <= 0) this.reply(`${CSI}>0;0;0c`);
      } else if (inter === 0 && final === 0x71) {
        if (p0 <= 0) this.reply(`${ESC}P>|corral${ST}`);
      }
      // CSI > Ps u (kitty push) and CSI > 4 ; Ps m (modifyOtherKeys): ignored.
      return;
    }
    if (prefix !== 0) return; // CSI < u, CSI = u, CSI = c and the rest.
    if (inter === 0x20 && final === 0x71) {
      // DECSCUSR
      const s = p0 < 0 ? 0 : p0;
      this.cursorShape = s <= 2 ? 'block' : s <= 4 ? 'underline' : 'bar';
      this.cursorBlink = s === 0 || s % 2 === 1;
      return;
    }
    if (inter === 0x21 && final === 0x70) {
      this.softReset();
      this.touched = true;
      return;
    }
    if (inter === 0x24 && final === 0x70) {
      // DECRQM (ANSI)
      const mode = p0 < 0 ? 0 : p0;
      let state = 0;
      if (KNOWN_ANSI_MODES.has(mode)) state = (mode === 4 ? this.insert : this.newline) ? 1 : 2;
      this.reply(`${CSI}${mode};${state}$y`);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers for CSI
  // -------------------------------------------------------------------------

  private reply(s: string): void {
    this.onReply?.(s);
  }

  private reportRow(): number {
    return this.origin ? this.y - this.top + 1 : this.y + 1;
  }

  private isDarkBackground(): boolean {
    const b = this.defaultBg;
    const lum = 0.299 * ((b >> 16) & 0xff) + 0.587 * ((b >> 8) & 0xff) + 0.114 * (b & 0xff);
    return lum < 128;
  }

  private windowOp(p: number): void {
    if (p === 14) this.reply(`${CSI}4;${this.rows * this.cellH};${this.cols * this.cellW}t`);
    else if (p === 16) this.reply(`${CSI}6;${this.cellH};${this.cellW}t`);
    else if (p === 18) this.reply(`${CSI}8;${this.rows};${this.cols}t`);
  }

  private setScrollRegion(top: number, bottom: number): void {
    if (bottom > this.rows) bottom = this.rows;
    if (top >= bottom) return;
    this.top = top - 1;
    this.bottom = bottom - 1;
    this.moveToOrigin(0, 0);
  }

  private setAnsiMode(mode: number, on: boolean): void {
    if (mode === 4) this.insert = on;
    else if (mode === 20) this.newline = on;
  }

  private setDecMode(mode: number, on: boolean): void {
    if (!KNOWN_DEC_MODES.has(mode)) return;
    const m = this.modesObj;
    switch (mode) {
      case 1:
        m.appCursorKeys = on;
        break;
      case 6:
        this.setOrigin(on);
        this.moveToOrigin(0, 0);
        return;
      case 7:
        this.autowrap = on;
        if (!on) this.wrapPending = false;
        break;
      case 12:
        this.cursorBlink = on;
        break;
      case 25:
        this.cursorVisible = on;
        break;
      case 47:
      case 1047:
        if (on === m.altScreen) break;
        if (!on && mode === 1047) this.alt.clear(COLOR_DEFAULT);
        this.switchScreen(on, false);
        break;
      case 1048:
        if (on) this.saveCursor();
        else this.restoreCursor();
        return; // Not a state; DECRQM reports it as reset.
      case 1049:
        if (on === m.altScreen) break;
        if (on) {
          this.saveCursor();
          this.switchScreen(true, true);
          // The alternate buffer keeps its own saved cursor; xterm copies it on entry.
          this.alt.saved = this.primary.saved;
        } else {
          this.switchScreen(false, false);
          this.restoreCursor();
        }
        break;
      case 66:
        m.appKeypad = on;
        break;
      case 9:
      case 1000:
      case 1002:
      case 1003: {
        const t = MOUSE_MODES[mode]!;
        if (on) {
          for (const k of [9, 1000, 1002, 1003]) this.decModes.delete(k);
          m.mouse = t;
        } else if (m.mouse === t) {
          m.mouse = 'none';
        }
        break;
      }
      case 1004:
        m.focusEvents = on;
        break;
      case 1006:
        m.mouseSgr = on;
        break;
      case 2004:
        m.bracketedPaste = on;
        break;
      case 2026:
        if (on && !this.syncOn) {
          // Changes made before the frame started are shown now.
          if (this.touched) {
            this.touched = false;
            this.versionNum++;
          }
          this.syncOn = true;
          this.syncStart = this.now();
          this.syncPending = false;
        } else if (!on && this.syncOn) {
          this.syncOn = false;
          this.syncPending = false;
          this.touched = false;
          this.versionNum++;
        }
        break;
    }
    if (on) this.decModes.add(mode);
    else this.decModes.delete(mode);
  }

  // -------------------------------------------------------------------------
  // SGR
  // -------------------------------------------------------------------------

  private sgr(params: Int32Array, subs: Uint8Array, count: number): void {
    let i = 0;
    while (i < count) {
      const p = params[i]! < 0 ? 0 : params[i]!;
      // Group: p followed by its ':' sub-parameters.
      let end = i + 1;
      while (end < count && subs[end] === 1) end++;
      const nsub = end - i - 1;
      if (p === 38 || p === 48 || p === 58) {
        let color = -2; // -2: no valid color
        let next = end;
        if (nsub > 0) {
          const kind = params[i + 1]!;
          if (kind === 5 && nsub >= 2) color = this.index256(params[i + 2]!);
          else if (kind === 2) {
            // 38:2:Pi:r:g:b (colorspace id present) or 38:2:r:g:b.
            const o = nsub >= 5 ? i + 3 : i + 2;
            if (nsub >= 4) color = this.rgb(params[o]!, params[o + 1]!, params[o + 2]!);
          }
        } else if (i + 1 < count) {
          const kind = params[i + 1]!;
          if (kind === 5) {
            if (i + 2 < count) color = this.index256(params[i + 2]!);
            next = Math.min(i + 3, count);
          } else if (kind === 2) {
            if (i + 4 < count) color = this.rgb(params[i + 2]!, params[i + 3]!, params[i + 4]!);
            next = Math.min(i + 5, count);
          } else {
            next = i + 2;
          }
        }
        if (color !== -2) {
          if (p === 38) this.fg = color;
          else if (p === 48) this.bg = color;
        }
        i = next;
        continue;
      }
      i = end;
      switch (p) {
        case 0:
          this.fg = this.bg = COLOR_DEFAULT;
          this.attrs = 0;
          break;
        case 1:
          this.attrs |= ATTR.bold;
          break;
        case 2:
          this.attrs |= ATTR.dim;
          break;
        case 3:
          this.attrs |= ATTR.italic;
          break;
        case 4:
          if (nsub > 0 && params[i - nsub]! === 0) this.attrs &= ~ATTR.underline;
          else this.attrs |= ATTR.underline;
          break;
        case 5:
        case 6:
          this.attrs |= ATTR.blink;
          break;
        case 7:
          this.attrs |= ATTR.inverse;
          break;
        case 8:
          this.attrs |= ATTR.hidden;
          break;
        case 9:
          this.attrs |= ATTR.strike;
          break;
        case 21:
          this.attrs |= ATTR.underline;
          break;
        case 22:
          this.attrs &= ~(ATTR.bold | ATTR.dim);
          break;
        case 23:
          this.attrs &= ~ATTR.italic;
          break;
        case 24:
          this.attrs &= ~ATTR.underline;
          break;
        case 25:
          this.attrs &= ~ATTR.blink;
          break;
        case 27:
          this.attrs &= ~ATTR.inverse;
          break;
        case 28:
          this.attrs &= ~ATTR.hidden;
          break;
        case 29:
          this.attrs &= ~ATTR.strike;
          break;
        case 39:
          this.fg = COLOR_DEFAULT;
          break;
        case 49:
          this.bg = COLOR_DEFAULT;
          break;
        default:
          if (p >= 30 && p <= 37) this.fg = p - 30;
          else if (p >= 40 && p <= 47) this.bg = p - 40;
          else if (p >= 90 && p <= 97) this.fg = p - 90 + 8;
          else if (p >= 100 && p <= 107) this.bg = p - 100 + 8;
      }
    }
  }

  private index256(v: number): number {
    return v >= 0 && v <= 255 ? v : -2;
  }

  private rgb(r: number, g: number, b: number): number {
    const c = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
    return COLOR_RGB | (c(r) << 16) | (c(g) << 8) | c(b);
  }
}
