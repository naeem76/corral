// Terminal emulator for the pane: feed PTY output with write(), read the grid with readCell().

import type { Cell, Emulator, ScreenView } from '../types.ts';
import { Terminal } from './emulator.ts';
import type { EmulatorOptions } from './emulator.ts';

export { Terminal, paletteColor } from './emulator.ts';
export type { EmulatorOptions, CursorShape } from './emulator.ts';

export function createEmulator(cols: number, rows: number, options?: EmulatorOptions): Emulator {
  return new Terminal(cols, rows, options);
}

export interface ScreenToTextOptions {
  /** Remove spaces at the end of each row. Default true. */
  trimRight?: boolean;
  /** Remove empty rows at the end. Default false. */
  trimBottom?: boolean;
}

/** Plain text of the grid, one line per row. Right halves of wide characters are skipped. */
export function screenToText(view: ScreenView, opts: ScreenToTextOptions = {}): string {
  const trimRight = opts.trimRight ?? true;
  const cell: Cell = { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 };
  const lines: string[] = [];
  for (let y = 0; y < view.rows; y++) {
    let line = '';
    for (let x = 0; x < view.cols; x++) {
      view.readCell(x, y, cell);
      if (cell.width === 0) continue;
      line += cell.ch === '' ? ' ' : cell.ch;
    }
    lines.push(trimRight ? line.replace(/ +$/, '') : line);
  }
  if (opts.trimBottom) while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
