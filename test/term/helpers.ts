// Shared helpers for the emulator tests.

import type { Cell, Emulator } from '../../src/types.ts';
import { createEmulator, screenToText } from '../../src/term/index.ts';
import type { EmulatorOptions } from '../../src/term/index.ts';

export interface Harness {
  em: Emulator;
  replies: string[];
}

export function make(cols = 10, rows = 5, options?: EmulatorOptions): Harness {
  const em = createEmulator(cols, rows, options);
  const replies: string[] = [];
  em.onReply = (d) => replies.push(d);
  return { em, replies };
}

/** Emulator after writing data; returns the screen text with trailing empty rows removed. */
export function run(data: string, cols = 10, rows = 5): Emulator {
  const { em } = make(cols, rows);
  em.write(data);
  return em;
}

export function text(em: Emulator): string {
  return screenToText(em, { trimBottom: true });
}

export function rowText(em: Emulator, y: number): string {
  return screenToText(em).split('\n')[y] ?? '';
}

export function cell(em: Emulator, x: number, y: number): Cell {
  return em.readCell(x, y, { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 });
}

export function cursor(em: Emulator): [number, number] {
  return [em.cursor.x, em.cursor.y];
}

/** Every cell of both the visible grid and the cursor, for exact comparisons. */
export function snapshot(em: Emulator): string {
  const out: string[] = [];
  const c: Cell = { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 };
  for (let y = 0; y < em.rows; y++) {
    for (let x = 0; x < em.cols; x++) {
      em.readCell(x, y, c);
      out.push(`${c.ch}|${c.width}|${c.fg}|${c.bg}|${c.attrs}`);
    }
  }
  out.push(`cursor ${em.cursor.x},${em.cursor.y},${em.cursor.visible}`);
  out.push(JSON.stringify(em.modes), em.title);
  return out.join('\n');
}

export const ESC = '\x1b';
export const CSI = '\x1b[';
export const ST = '\x1b\\';
