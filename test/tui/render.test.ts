import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrame, renderDiff } from '../../src/tui/frame.ts';
import type { Frame } from '../../src/tui/frame.ts';
import { rgb, style } from '../../src/tui/style.ts';
import type { Style } from '../../src/tui/style.ts';
import { ATTR, COLOR_DEFAULT } from '../../src/types.ts';
import { VtModel } from './helpers/vt-model.ts';

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const GLYPHS = ['a', 'b', 'Z', ' ', '-', '宽', '字', 'é', '─', '😀', '❤️', 'é', '|'];
const STYLES: Style[] = [
  style(),
  style(1),
  style(2, 0),
  style(COLOR_DEFAULT, 237, ATTR.bold),
  style(rgb(10, 200, 30), rgb(1, 2, 3), ATTR.italic | ATTR.underline),
  style(200, COLOR_DEFAULT, ATTR.dim),
  style(7, 4, ATTR.bold | ATTR.dim | ATTR.inverse),
  style(12, 9, ATTR.strike | ATTR.hidden | ATTR.blink),
];

type Op = (f: Frame) => void;

function randomOps(rnd: () => number, cols: number, rows: number, count: number): Op[] {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const kind = rnd();
    const x = Math.floor(rnd() * (cols + 2)) - 1;
    const y = Math.floor(rnd() * rows);
    const st = pick(STYLES);
    if (kind < 0.6) {
      let s = '';
      const n = 1 + Math.floor(rnd() * 12);
      for (let k = 0; k < n; k++) s += pick(GLYPHS);
      ops.push((f) => f.text(x, y, s, st));
    } else if (kind < 0.75) {
      const w = Math.floor(rnd() * cols);
      const h = Math.floor(rnd() * 3);
      ops.push((f) => f.fillRect(x, y, w, h, st));
    } else if (kind < 0.85) {
      const w = 2 + Math.floor(rnd() * cols);
      const h = 2 + Math.floor(rnd() * rows);
      ops.push((f) => f.box(x, y, w, h, st, 'T宽'));
    } else {
      ops.push((f) => f.put(x, y, pick(GLYPHS), st));
    }
  }
  const cx = Math.floor(rnd() * cols);
  const cy = Math.floor(rnd() * rows);
  const vis = rnd() < 0.5;
  ops.push((f) => f.setCursor(cx, cy, vis));
  return ops;
}

function build(cols: number, rows: number, ops: Op[]): Frame {
  const f = createFrame(cols, rows);
  for (const op of ops) op(f);
  return f;
}

function checkApply(model: VtModel, out: string, next: Frame, label: string): void {
  model.apply(out);
  const d = model.diff(next);
  assert.deepEqual(d.slice(0, 5), [], `${label}: ${d.length} differences`);
  assert.equal(model.scrolled, 0, `${label}: screen scrolled`);
  assert.deepEqual(model.unknown, [], `${label}: unknown sequences`);
  assert.equal(model.cursorVisible, next.cursor.visible, `${label}: cursor visibility`);
  if (next.cursor.visible) assert.deepEqual([model.x, model.y], [next.cursor.x, next.cursor.y], `${label}: cursor position`);
  assert.equal(model.autowrap, true, `${label}: autowrap restored`);
}

test('full repaint from null draws the frame exactly', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = prng(seed);
    const cols = 3 + Math.floor(rnd() * 30);
    const rows = 1 + Math.floor(rnd() * 8);
    const f = build(cols, rows, randomOps(rnd, cols, rows, 15));
    const model = new VtModel(cols, rows);
    checkApply(model, renderDiff(null, f), f, `seed ${seed}`);
  }
});

test('diff of random frame pairs turns prev into next', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rnd = prng(seed * 7919);
    const cols = 2 + Math.floor(rnd() * 25);
    const rows = 1 + Math.floor(rnd() * 7);
    const base = randomOps(rnd, cols, rows, 12);
    const prev = build(cols, rows, base);
    // Half the pairs share most content; the others are unrelated.
    const next = rnd() < 0.5 ? build(cols, rows, [...base, ...randomOps(rnd, cols, rows, 3)]) : build(cols, rows, randomOps(rnd, cols, rows, 12));
    const model = VtModel.fromFrame(prev);
    checkApply(model, renderDiff(prev, next), next, `seed ${seed}`);
    // Depth conversion keeps the cells; only check that no 24-bit color is sent.
    assert.ok(!renderDiff(prev, next, { depth: '256' }).includes('38;2;'), `seed ${seed} 256`);
  }
});

test('nothing changed gives an empty string', () => {
  const ops = randomOps(prng(5), 20, 5, 10);
  const a = build(20, 5, ops);
  const b = build(20, 5, ops);
  assert.equal(renderDiff(a, b), '');
  assert.equal(renderDiff(a, a), '');
});

test('only the cursor moved: sync markers and a cursor update', () => {
  const a = createFrame(10, 3);
  a.setCursor(1, 1, true);
  const b = createFrame(10, 3);
  b.setCursor(4, 2, true);
  assert.equal(renderDiff(a, b), '\x1b[?2026h\x1b[3;5H\x1b[?25h\x1b[?2026l');
  const c = createFrame(10, 3);
  assert.equal(renderDiff(b, c, { sync: false }), '\x1b[?25l');
});

test('one changed cell is a short update', () => {
  const a = createFrame(40, 10);
  const b = createFrame(40, 10);
  b.put(5, 3, 'x', style());
  const out = renderDiff(a, b, { sync: false });
  assert.equal(out, '\x1b[4;6H\x1b[0mx\x1b[?25l');
});

test('a short gap in the same style is rewritten instead of moved over', () => {
  const a = createFrame(20, 1);
  a.text(0, 0, 'abcdef', style());
  const b = createFrame(20, 1);
  b.text(0, 0, 'Xbcdef', style());
  b.put(3, 0, 'Y', style());
  const model = VtModel.fromFrame(a);
  const out = renderDiff(a, b, { sync: false });
  model.apply(out);
  assert.deepEqual(model.diff(b), []);
  assert.ok(!out.includes('C'), out);
});

test('writing the bottom-right cell never scrolls', () => {
  for (const ch of ['x', '宽']) {
    const f = createFrame(6, 3);
    f.fillRect(0, 0, 6, 3, style(1, 2));
    f.text(4, 2, ch + ch, style(3));
    const model = new VtModel(6, 3);
    const out = renderDiff(null, f);
    checkApply(model, out, f, ch);
    assert.ok(out.includes('\x1b[?7l'), 'autowrap is turned off around the last cell');
  }
});

test('size change gives a full repaint', () => {
  const a = createFrame(10, 3);
  const b = createFrame(12, 3);
  b.text(0, 0, 'hi', style());
  const out = renderDiff(a, b);
  assert.ok(out.includes('\x1b[2J'));
  const model = new VtModel(12, 3);
  checkApply(model, out, b, 'resize');
});

test('replacing a wide character by narrow ones and back', () => {
  const a = createFrame(8, 1);
  a.text(0, 0, '宽字宽字', style());
  const b = createFrame(8, 1);
  b.text(0, 0, '宽ab字c', style());
  const m1 = VtModel.fromFrame(a);
  checkApply(m1, renderDiff(a, b), b, 'wide to narrow');
  const m2 = VtModel.fromFrame(b);
  checkApply(m2, renderDiff(b, a), a, 'narrow to wide');
  // Shift wide characters by one cell.
  const c = createFrame(8, 1);
  c.text(1, 0, '宽字宽', style());
  const m3 = VtModel.fromFrame(a);
  checkApply(m3, renderDiff(a, c), c, 'shift');
});

test('256 and 16 color output', () => {
  const f = createFrame(4, 1);
  f.text(0, 0, 'ab', style(rgb(255, 0, 0), rgb(0, 0, 255)));
  const o256 = renderDiff(null, f, { depth: '256' });
  assert.ok(o256.includes('38;5;196'), o256);
  assert.ok(o256.includes('48;5;21'), o256);
  const o16 = renderDiff(null, f, { depth: '16' });
  assert.ok(o16.includes("\x1b[91;44m"), JSON.stringify(o16));
});
