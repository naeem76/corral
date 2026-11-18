import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrame, truncate, truncateStart, wrapText } from '../../src/tui/frame.ts';
import type { Frame } from '../../src/tui/frame.ts';
import { style } from '../../src/tui/style.ts';
import { COLOR_DEFAULT } from '../../src/types.ts';
import type { Cell, ScreenView } from '../../src/types.ts';
import { stringWidth } from '../../src/width.ts';

const S = style();

/** Every wide left half is followed by a right half and every right half follows a left half. */
function assertWideConsistent(f: Frame): void {
  for (let y = 0; y < f.rows; y++) {
    for (let x = 0; x < f.cols; x++) {
      const i = y * f.cols + x;
      if (f.wid[i] === 2) {
        assert.ok(x + 1 < f.cols, `wide at last column (${x},${y})`);
        assert.equal(f.wid[i + 1], 0, `missing right half at (${x + 1},${y})`);
      }
      if (f.wid[i] === 0) assert.ok(x > 0 && f.wid[i - 1] === 2, `orphan right half at (${x},${y})`);
    }
  }
}

test('truncate and truncateStart', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('宽字宽字', 5), '宽字…');
  assert.equal(truncate('宽字宽字', 4), '宽…');
  assert.equal(truncate('abc', 1), '…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncateStart('/home/user/project', 10), '…r/project');
  assert.equal(truncateStart('宽字宽字', 5), '…宽字');
  for (const w of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(stringWidth(truncate('a宽b字c😀d', w)) <= w);
    assert.ok(stringWidth(truncateStart('a宽b字c😀d', w)) <= w);
  }
});

test('wrapText', () => {
  assert.deepEqual(wrapText('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b']);
  for (const line of wrapText('宽字宽字宽字 abc 宽字', 5)) assert.ok(stringWidth(line) <= 5);
});

test('text clips at the frame edge and never splits a wide character', () => {
  const f = createFrame(5, 1);
  const end = f.text(0, 0, 'ab宽字', S);
  assert.equal(f.rowText(0), 'ab宽 ');
  assert.equal(end, 5);
  assertWideConsistent(f);
});

test('text clips at maxWidth and the clip rectangle', () => {
  const f = createFrame(10, 2);
  f.text(0, 0, '宽宽宽', S, 3);
  assert.equal(f.rowText(0), '宽        ');
  f.pushClip({ x: 3, y: 0, w: 4, h: 2 });
  f.text(0, 1, 'ab宽宽宽', S);
  f.popClip();
  // 宽 at 2-3 and 6-7 are cut by the clip edges: their visible halves become spaces.
  assert.equal(f.rowText(1), '    宽    ');
  assert.equal(f.getCell(3, 1).ch, ' ');
  assert.equal(f.getCell(4, 1).ch, '宽');
  assert.equal(f.getCell(6, 1).ch, ' ');
  assert.equal(f.getCell(7, 1).ch, ' ');
  assertWideConsistent(f);
});

test('text with control characters draws spaces', () => {
  const f = createFrame(6, 1);
  f.text(0, 0, 'a\tb\x1bc', S);
  assert.equal(f.rowText(0), 'a b c ');
});

test('put over one half of a wide character clears the other half', () => {
  const f = createFrame(6, 1);
  f.text(0, 0, '宽字', S);
  f.put(1, 0, 'x', S);
  assert.equal(f.rowText(0), ' x字  ');
  f.put(2, 0, 'y', S);
  assert.equal(f.rowText(0), ' xy   ');
  assertWideConsistent(f);
  // A wide character on the last column becomes a space.
  f.put(5, 0, '宽', S);
  assert.equal(f.getCell(5, 0).ch, ' ');
  assertWideConsistent(f);
});

test('box drawing with a title', () => {
  const f = createFrame(12, 4);
  f.box(0, 0, 12, 4, S, 'Projects');
  assert.deepEqual([0, 1, 2, 3].map((y) => f.rowText(y)), [
    '╭─ Proje… ─╮',
    '│          │',
    '│          │',
    '╰──────────╯',
  ]);
  const g = createFrame(6, 3);
  g.box(0, 0, 6, 3, S, undefined, { border: 'single' });
  assert.deepEqual([0, 1, 2].map((y) => g.rowText(y)), ['┌────┐', '│    │', '└────┘']);
});

test('hline, vline, fillRect and the clip stack', () => {
  const f = createFrame(5, 3);
  f.pushClip({ x: 1, y: 1, w: 10, h: 10 });
  f.pushClip({ x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual({ ...f.clip }, { x: 1, y: 1, w: 2, h: 2 });
  f.fillRect(0, 0, 5, 3, S, '#');
  f.popClip();
  f.hline(0, 0, 5, S);
  f.vline(4, 0, 3, S);
  f.popClip();
  assert.deepEqual([0, 1, 2].map((y) => f.rowText(y)), ['     ', ' ## │', ' ## │']);
});

class FakeView implements ScreenView {
  cols: number;
  rows: number;
  cells: Cell[];
  cursor = { x: 0, y: 0, visible: true };
  constructor(lines: string[], cols: number) {
    this.cols = cols;
    this.rows = lines.length;
    this.cells = [];
    for (const line of lines) {
      const row: Cell[] = [];
      for (const ch of line) {
        if (ch === '宽' || ch === '字') {
          row.push({ ch, width: 2, fg: 1, bg: 2, attrs: 0 }, { ch: '', width: 0, fg: 1, bg: 2, attrs: 0 });
        } else row.push({ ch, width: 1, fg: 3, bg: COLOR_DEFAULT, attrs: 1 });
      }
      while (row.length < cols) row.push({ ch: '', width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
      this.cells.push(...row.slice(0, cols));
    }
  }
  readCell(x: number, y: number, out: Cell): Cell {
    Object.assign(out, this.cells[y * this.cols + x]!);
    return out;
  }
}

test('blit copies cells and styles', () => {
  const v = new FakeView(['ab宽c', 'xyz'], 6);
  const f = createFrame(8, 3);
  f.blit(v, 1, 1, 6, 2);
  assert.equal(f.rowText(1), ' ab宽c  ');
  assert.equal(f.rowText(2), ' xyz    ');
  assert.deepEqual(f.getCell(3, 1), { ch: '宽', width: 2, fg: 1, bg: 2, attrs: 0 });
  assert.deepEqual(f.getCell(1, 1), { ch: 'a', width: 1, fg: 3, bg: COLOR_DEFAULT, attrs: 1 });
  assertWideConsistent(f);
});

test('blit: wide cells cut by the region, the clip and the source offset', () => {
  const v = new FakeView(['a宽字b'], 6);
  // Region ends in the middle of 字: its left half becomes a space.
  const f = createFrame(8, 1);
  f.blit(v, 0, 0, 4, 1);
  assert.equal(f.rowText(0), 'a宽     ');
  assert.equal(f.getCell(3, 0).ch, ' ');
  assert.equal(f.getCell(3, 0).bg, 2, 'the space keeps the cell style');
  assertWideConsistent(f);
  // Source offset starts on the right half of 宽.
  const g = createFrame(8, 1);
  g.blit(v, 0, 0, 5, 1, 2, 0);
  assert.equal(g.rowText(0), ' 字b    ');
  assertWideConsistent(g);
  // Clip cuts a wide cell on both sides.
  const h = createFrame(8, 1);
  h.text(0, 0, '########', S);
  h.pushClip({ x: 2, y: 0, w: 3, h: 1 });
  h.blit(v, 0, 0, 6, 1);
  h.popClip();
  assert.equal(h.rowText(0), '## 字###');
  assertWideConsistent(h);
  // Source smaller than the region: blank cells.
  const k = createFrame(8, 2);
  k.text(0, 1, '########', S);
  k.blit(v, 0, 0, 8, 2);
  assert.equal(k.rowText(1), '        ');
});

test('random drawing keeps wide pairs consistent', () => {
  let s = 99;
  const rnd = (): number => ((s = (s * 48271) % 0x7fffffff) / 0x7fffffff);
  const glyphs = ['a', '宽', '😀', ' ', 'é'];
  for (let round = 0; round < 200; round++) {
    const f = createFrame(7, 2);
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(rnd() * 9) - 1;
      const y = Math.floor(rnd() * 2);
      const op = rnd();
      if (op < 0.4) f.text(x, y, glyphs[Math.floor(rnd() * 5)]! + glyphs[Math.floor(rnd() * 5)]!, S);
      else if (op < 0.7) f.put(x, y, glyphs[Math.floor(rnd() * 5)]!, S);
      else {
        f.pushClip({ x: Math.floor(rnd() * 7), y: 0, w: Math.floor(rnd() * 5), h: 2 });
        f.blit(new FakeView(['宽a字宽'], 7), x, y, 7, 1, Math.floor(rnd() * 3));
        f.popClip();
      }
    }
    assertWideConsistent(f);
  }
});

test('setCursor clamps to the frame', () => {
  const f = createFrame(4, 2);
  f.setCursor(10, -3, true);
  assert.deepEqual({ ...f.cursor }, { x: 3, y: 0, visible: true });
});
