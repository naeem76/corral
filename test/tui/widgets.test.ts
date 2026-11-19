import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrame } from '../../src/tui/frame.ts';
import { style } from '../../src/tui/style.ts';
import type { InputEvent } from '../../src/types.ts';
import { stringWidth } from '../../src/width.ts';
import { centerRect, inset, rectContains, splitColumns, splitRows, splitSizes } from '../../src/tui/widgets/layout.ts';
import {
  createListState, handleListInput, moveSelection, reconcileList, renderList, selectedIndexOf, viewRows,
} from '../../src/tui/widgets/list.ts';
import type { ListItem, ListState } from '../../src/tui/widgets/list.ts';
import { createTextInput, handleTextInput, renderTextInput, scrollFor } from '../../src/tui/widgets/textinput.ts';
import { createMenu, handleMenu, renderMenu } from '../../src/tui/widgets/menu.ts';
import type { TextInputState } from '../../src/tui/widgets/textinput.ts';
import { fuzzyFilter, fuzzyMatch } from '../../src/tui/widgets/fuzzy.ts';
import { confirmReady, createConfirm, handleConfirm, renderConfirm } from '../../src/tui/widgets/modal.ts';

function key(k: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): InputEvent {
  return { type: 'key', key: k, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false, raw: '' };
}

function click(x: number, y: number, action: 'down' | 'wheel-up' | 'wheel-down' = 'down'): InputEvent {
  return { type: 'mouse', x, y, button: action === 'down' ? 'left' : 'none', action, ctrl: false, alt: false, shift: false, raw: '' };
}

function prng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 48271) % 0x7fffffff) / 0x7fffffff);
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

test('splitSizes: fixed, min and weights', () => {
  assert.deepEqual(splitSizes(100, [20, { weight: 1 }, { weight: 3 }]), [20, 20, 60]);
  assert.deepEqual(splitSizes(10, [{ min: 4 }, { min: 4 }, 5]), [4, 4, 2]);
  assert.deepEqual(splitSizes(10, [3, 3]), [3, 3]);
  assert.deepEqual(splitSizes(50, [{ max: 10 }, {}]), [10, 40]);
  assert.deepEqual(splitSizes(11, [{}, {}, {}], 1), [3, 3, 3]);
  assert.deepEqual(splitSizes(0, [{ min: 5 }, 3]), [0, 0]);
});

test('splitSizes: random inputs never exceed the total and respect fixed sizes when room', () => {
  const rnd = prng(3);
  for (let i = 0; i < 500; i++) {
    const total = Math.floor(rnd() * 200);
    const specs = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () =>
      rnd() < 0.3 ? Math.floor(rnd() * 30) : { min: Math.floor(rnd() * 20), weight: Math.floor(rnd() * 4), max: rnd() < 0.3 ? 40 : undefined },
    );
    const gap = Math.floor(rnd() * 2);
    const sizes = splitSizes(total, specs, gap);
    const sum = sizes.reduce((a, b) => a + b, 0) + gap * (sizes.length - 1);
    assert.ok(sum <= Math.max(total, gap * (sizes.length - 1)), JSON.stringify({ total, specs, sizes }));
    sizes.forEach((s, k) => assert.ok(s >= 0 && Number.isInteger(s), `size ${k}`));
    const needed = specs.reduce<number>((a, s) => a + (typeof s === 'number' ? s : (s.min ?? 0)), 0) + gap * (specs.length - 1);
    if (needed <= total) specs.forEach((s, k) => {
      if (typeof s === 'number') assert.equal(sizes[k], s);
      else assert.ok(sizes[k]! >= (s.min ?? 0));
    });
  }
});

test('splitColumns, splitRows, inset, centerRect, rectContains', () => {
  const r = { x: 2, y: 1, w: 30, h: 10 };
  const cols = splitColumns(r, [10, {}]);
  assert.deepEqual(cols, [{ x: 2, y: 1, w: 10, h: 10 }, { x: 12, y: 1, w: 20, h: 10 }]);
  const rows = splitRows(r, [{}, 1]);
  assert.deepEqual(rows, [{ x: 2, y: 1, w: 30, h: 9 }, { x: 2, y: 10, w: 30, h: 1 }]);
  assert.deepEqual(inset(r, 1), { x: 3, y: 2, w: 28, h: 8 });
  assert.deepEqual(centerRect(r, 10, 4), { x: 12, y: 4, w: 10, h: 4 });
  assert.deepEqual(centerRect(r, 100, 100), r);
  assert.ok(rectContains(r, 2, 1));
  assert.ok(!rectContains(r, 32, 1));
  assert.ok(!rectContains(r, 2, 11));
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function mkItems(n: number, headersEvery = 0, prefix = 'k'): ListItem<string>[] {
  return Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, data: `item ${i}`, header: headersEvery > 0 && i % headersEvery === 0 }));
}

function checkInvariants(s: ListState, items: readonly ListItem<string>[], rows: number, label: string): void {
  const n = items.length;
  assert.ok(s.scrollTop >= 0 && s.scrollTop <= Math.max(0, n - rows), `${label}: scrollTop ${s.scrollTop} n=${n} rows=${rows}`);
  if (s.selectedKey !== null) {
    const i = selectedIndexOf(s, items);
    assert.ok(i >= 0, `${label}: selected key exists`);
    assert.ok(!items[i]!.header, `${label}: header selected`);
  } else {
    assert.ok(items.every((it) => it.header), `${label}: nothing selected while items exist`);
  }
}

test('list: keys move, skip headers and keep the selection visible with a margin', () => {
  const items = mkItems(50, 10);
  const r = { x: 0, y: 0, w: 20, h: 10 };
  let s = reconcileList(createListState(), items, 10);
  assert.equal(s.selectedKey, 'k1');
  for (let i = 0; i < 12; i++) s = handleListInput(s, items, key('j'), r).state;
  // 12 steps from k1 skipping k10: k14.
  assert.equal(s.selectedKey, 'k14');
  const idx = selectedIndexOf(s, items);
  assert.ok(idx - s.scrollTop <= 8, 'margin of one row at the bottom');
  s = handleListInput(s, items, key('end'), r).state;
  assert.equal(s.selectedKey, 'k49');
  assert.equal(s.scrollTop, 40);
  s = handleListInput(s, items, key('home'), r).state;
  assert.equal(s.selectedKey, 'k1');
  assert.equal(s.scrollTop, 0);
  s = handleListInput(s, items, key('pagedown'), r).state;
  assert.equal(s.selectedKey, 'k11', '9 selectable steps, skipping header k10');
  s = handleListInput(s, items, key('up'), r).state;
  assert.equal(s.selectedKey, 'k9');
  const enter = handleListInput(s, items, key('enter'), r);
  assert.equal(enter.activated, true);
  assert.equal(handleListInput(s, items, key('x'), r).handled, false);
  assert.equal(handleListInput(s, items, key('j', { ctrl: true }), r).handled, false);
});

test('list: mouse click selects, a second click activates, wheel scrolls the view', () => {
  const items = mkItems(30);
  const r = { x: 5, y: 2, w: 20, h: 5 };
  let s = reconcileList(createListState(), items, 5);
  let res = handleListInput(s, items, click(6, 4), r);
  assert.equal(res.state.selectedKey, 'k2');
  assert.equal(res.activated, false);
  res = handleListInput(res.state, items, click(6, 4), r);
  assert.equal(res.activated, true);
  s = handleListInput(res.state, items, click(6, 4, 'wheel-down'), r).state;
  assert.equal(s.scrollTop, 3);
  assert.equal(s.selectedKey, 'k2', 'wheel does not move the selection');
  s = handleListInput(s, items, click(6, 4, 'wheel-down'), r, { wheel: 'select' }).state;
  assert.equal(s.selectedKey, 'k3');
  assert.equal(handleListInput(s, items, click(0, 0), r).handled, false);
});

test('list: two-line rows', () => {
  const items = mkItems(10);
  const r = { x: 0, y: 0, w: 20, h: 7 };
  assert.equal(viewRows(7, 2), 3);
  let s = reconcileList(createListState(), items, 3);
  s = handleListInput(s, items, click(1, 5), r, { rowHeight: 2 }).state;
  assert.equal(s.selectedKey, 'k2');
  for (let i = 0; i < 5; i++) s = handleListInput(s, items, key('down'), r, { rowHeight: 2 }).state;
  assert.equal(s.selectedKey, 'k7');
  assert.ok(s.scrollTop >= 5 && s.scrollTop <= 7);
});

test('list: selection follows the key when items change', () => {
  let items = mkItems(10);
  let s = reconcileList({ selectedKey: 'k5', selectedIndex: 5, scrollTop: 0 }, items, 4);
  items = [{ key: 'new', data: 'x' }, ...items];
  s = reconcileList(s, items, 4);
  assert.equal(s.selectedKey, 'k5');
  assert.equal(s.selectedIndex, 6);
  // The selected item is removed: the item now at its index is selected.
  items = items.filter((it) => it.key !== 'k5');
  s = reconcileList(s, items, 4);
  assert.equal(s.selectedKey, 'k6');
  // All items removed.
  s = reconcileList(s, [], 4);
  assert.equal(s.selectedKey, null);
  assert.equal(s.scrollTop, 0);
});

test('list: invariants under random operations and item changes', () => {
  const rnd = prng(17);
  const keys = ['j', 'k', 'up', 'down', 'pageup', 'pagedown', 'home', 'end'];
  for (let round = 0; round < 60; round++) {
    let items = mkItems(Math.floor(rnd() * 40), Math.floor(rnd() * 6), `r${round}-`);
    const h = 1 + Math.floor(rnd() * 12);
    const rh = rnd() < 0.3 ? 2 : 1;
    const rows = viewRows(h, rh);
    const r = { x: 0, y: 0, w: 10, h };
    let s = reconcileList(createListState(), items, rows);
    for (let step = 0; step < 80; step++) {
      const op = rnd();
      if (op < 0.6) s = handleListInput(s, items, key(keys[Math.floor(rnd() * keys.length)]!), r, { rowHeight: rh }).state;
      else if (op < 0.7) s = handleListInput(s, items, click(1, Math.floor(rnd() * h), rnd() < 0.5 ? 'down' : 'wheel-down'), r, { rowHeight: rh }).state;
      else if (op < 0.8) s = moveSelection(s, items, Math.floor(rnd() * 20) - 10, rows);
      else {
        // Change the items: remove some, insert some, shuffle a bit.
        const next = items.filter(() => rnd() > 0.2);
        const extra = Math.floor(rnd() * 5);
        for (let e = 0; e < extra; e++) next.splice(Math.floor(rnd() * (next.length + 1)), 0, { key: `x${round}-${step}-${e}`, data: 'x', header: rnd() < 0.2 });
        items = next;
        s = reconcileList(s, items, rows);
      }
      checkInvariants(s, items, rows, `round ${round} step ${step}`);
    }
  }
});

test('list: render draws visible rows, selection fill and a scrollbar', () => {
  const items = mkItems(20, 5);
  const f = createFrame(12, 6);
  f.box(0, 0, 12, 6, style());
  const inner = { x: 1, y: 1, w: 10, h: 4 };
  const s = reconcileList({ selectedKey: 'k2', selectedIndex: 2, scrollTop: 1 }, items, 4);
  const seen: number[] = [];
  renderList(f, inner, items, s, {
    focused: true,
    selectedStyle: style(-1, 237),
    scrollbar: { x: 11, style: style(7) },
    renderRow: (fr, rr, item, info) => {
      seen.push(info.index);
      fr.text(rr.x, rr.y, (info.selected ? '>' : ' ') + item.data + (info.index === 3 ? ' and more text that overflows' : ''), style());
    },
  });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(f.rowText(2), '│>item 2   │');
  assert.equal(f.rowText(3), '│ item 3 an│', 'a row cannot draw outside its rectangle');
  assert.equal(f.getCell(9, 2).bg, 237);
  assert.equal(f.getCell(9, 4).bg, -1);
  assert.equal(f.getCell(11, 1).ch, '┃');
  assert.equal(f.getCell(11, 4).ch, '│');
});

test('list: empty text', () => {
  const f = createFrame(10, 2);
  renderList(f, { x: 0, y: 0, w: 10, h: 2 }, [], createListState(), {
    focused: false,
    renderRow: () => assert.fail('no rows'),
    empty: { text: 'nothing', style: style() },
  });
  assert.equal(f.rowText(0), ' nothing  ');
});

// ---------------------------------------------------------------------------
// text input
// ---------------------------------------------------------------------------

function typeAll(s: TextInputState, events: InputEvent[]): TextInputState {
  for (const e of events) s = handleTextInput(s, e).state;
  return s;
}

const chars = (t: string): InputEvent[] => [...new Intl.Segmenter().segment(t)].map((g) => key(g.segment === ' ' ? 'space' : g.segment));

test('text input: insert, move, delete with wide characters and graphemes', () => {
  let s = typeAll(createTextInput(), chars('a宽é😀b'));
  assert.equal(s.value, 'a宽é😀b');
  assert.equal(s.cursor, 5);
  s = typeAll(s, [key('left'), key('left'), key('backspace')]);
  assert.equal(s.value, 'a宽😀b');
  assert.equal(s.cursor, 2);
  s = typeAll(s, [key('delete')]);
  assert.equal(s.value, 'a宽b');
  s = typeAll(s, [key('home'), key('x'), key('end'), key('y')]);
  assert.equal(s.value, 'xa宽by');
  s = typeAll(s, [key('a', { ctrl: true }), key('right'), key('e', { ctrl: true })]);
  assert.equal(s.cursor, 5);
});

test('text input: word movement and deletion', () => {
  let s = createTextInput('hello big  world');
  s = typeAll(s, [key('w', { ctrl: true })]);
  assert.equal(s.value, 'hello big  ');
  s = typeAll(s, [key('left', { ctrl: true })]);
  assert.equal(s.cursor, 6);
  s = typeAll(s, [key('right', { alt: true })]);
  assert.equal(s.cursor, 9);
  s = typeAll(s, [key('backspace', { alt: true })]);
  assert.equal(s.value, 'hello   ');
  s = typeAll(s, [key('b', { alt: true }), key('d', { alt: true })]);
  assert.equal(s.value, '   ');
  s = createTextInput('abc def');
  s = typeAll(s, [key('left'), key('left'), key('u', { ctrl: true })]);
  assert.equal(s.value, 'ef');
  assert.equal(s.cursor, 0);
  s = typeAll(s, [key('right'), key('k', { ctrl: true })]);
  assert.equal(s.value, 'e');
  s = typeAll(createTextInput('one two'), [key('backspace', { ctrl: true })]);
  assert.equal(s.value, 'one ');
});

test('text input: paste is one line, submit and cancel', () => {
  let s = createTextInput('ab');
  s = handleTextInput({ ...s, cursor: 1 }, { type: 'paste', text: 'x\r\ny\tz\x1b' }).state;
  assert.equal(s.value, 'ax y zb');
  assert.equal(s.cursor, 6);
  assert.equal(handleTextInput(s, key('enter')).action, 'submit');
  assert.equal(handleTextInput(s, key('escape')).action, 'cancel');
  assert.equal(handleTextInput(s, key('up')).handled, false);
  assert.equal(handleTextInput(s, key('tab')).handled, false);
  assert.equal(handleTextInput(s, key('space')).state.value, 'ax y z b');
});

test('text input: horizontal scroll keeps the cursor visible, by cell width', () => {
  let s = createTextInput('宽字宽字宽字');
  assert.equal(scrollFor(s, 5), 8);
  const f = createFrame(5, 1);
  s = renderTextInput(f, { x: 0, y: 0, w: 5, h: 1 }, s, { focused: true, style: style() });
  assert.equal(s.scroll, 8);
  assert.deepEqual({ ...f.cursor }, { x: 4, y: 0, visible: true });
  assert.equal(f.rowText(0), '宽字 ');
  s = typeAll(s, [key('home')]);
  const g = createFrame(5, 1);
  s = renderTextInput(g, { x: 0, y: 0, w: 5, h: 1 }, s, { focused: true, style: style() });
  assert.equal(s.scroll, 0);
  assert.equal(g.rowText(0), '宽字 ');
  assert.deepEqual({ ...g.cursor }, { x: 0, y: 0, visible: true });
  // Cursor in the middle: scroll so that it is in view, and the cut wide char is a space.
  s = { ...s, cursor: 4, scroll: 0 };
  const h = createFrame(5, 1);
  s = renderTextInput(h, { x: 0, y: 0, w: 5, h: 1 }, s, { focused: true, style: style() });
  assert.equal(s.scroll, 4);
  assert.equal(h.cursor.x, 4);
});

test('text input: random edits keep the cursor in range and the field in width', () => {
  const rnd = prng(23);
  const evs = [key('a'), key('宽'), key('😀'), key('space'), key('left'), key('right'), key('backspace'), key('delete'),
    key('home'), key('end'), key('w', { ctrl: true }), key('left', { ctrl: true }), key('right', { alt: true })];
  let s = createTextInput();
  for (let i = 0; i < 2000; i++) {
    s = handleTextInput(s, evs[Math.floor(rnd() * evs.length)]!).state;
    const f = createFrame(7, 1);
    s = renderTextInput(f, { x: 0, y: 0, w: 7, h: 1 }, s, { focused: true, style: style() });
    const n = [...new Intl.Segmenter().segment(s.value)].length;
    assert.ok(s.cursor >= 0 && s.cursor <= n);
    assert.ok(f.cursor.x >= 0 && f.cursor.x < 7, `cursor ${f.cursor.x}`);
  }
});

test('text input: placeholder', () => {
  const f = createFrame(10, 1);
  renderTextInput(f, { x: 0, y: 0, w: 10, h: 1 }, createTextInput(), { focused: false, style: style(), placeholder: 'search' });
  assert.equal(f.rowText(0), 'search    ');
  assert.equal(f.cursor.visible, false);
});

// ---------------------------------------------------------------------------
// fuzzy
// ---------------------------------------------------------------------------

test('fuzzy: subsequence, positions and smart case', () => {
  assert.equal(fuzzyMatch('xyz', 'abc'), null);
  assert.deepEqual(fuzzyMatch('', 'abc'), { score: 0, positions: [] });
  assert.deepEqual(fuzzyMatch('abc', 'a-b-c')?.positions, [0, 2, 4]);
  assert.deepEqual(fuzzyMatch('NE', 'tabula-enterprise'), null);
  assert.deepEqual(fuzzyMatch('ne', 'Nebula-Enterprise')?.positions, [0, 1]);
  // Prefers the word start over an earlier scattered match.
  assert.deepEqual(fuzzyMatch('ent', 'tabula-enterprise')?.positions, [7, 8, 9]);
  assert.deepEqual(fuzzyMatch('宽', 'a宽b')?.positions, [1]);
});

test('fuzzy: score order', () => {
  const list = ['src/tui/list.ts', 'test/tui/list.test.ts', 'docs/lists-and-more.md', 'lib/l-i-s-t.ts', 'list.ts'];
  const ranked = fuzzyFilter('list', list, (s) => s).map((r) => r.item);
  assert.equal(ranked[0], 'list.ts');
  assert.equal(ranked[ranked.length - 1], 'lib/l-i-s-t.ts');
  const ab = fuzzyMatch('nb', 'nebula')!;
  const cd = fuzzyMatch('nb', 'nebulas')!;
  assert.ok(ab.score > cd.score, 'shorter text wins a tie');
  const consecutive = fuzzyMatch('neb', 'nebula')!;
  const gaps = fuzzyMatch('neb', 'n-e-b')!;
  assert.ok(consecutive.score > gaps.score);
  assert.deepEqual(fuzzyFilter('', ['b', 'a'], (s) => s).map((r) => r.item), ['b', 'a'], 'empty query keeps the order');
});

// ---------------------------------------------------------------------------
// modal / confirm
// ---------------------------------------------------------------------------

test('confirm: y/n, Enter on the default No, Esc, Tab switches', () => {
  const c = createConfirm({ title: 'Delete', message: 'Delete it?' });
  assert.equal(handleConfirm(c, key('y')).result, 'yes');
  assert.equal(handleConfirm(c, key('n')).result, 'no');
  assert.equal(handleConfirm(c, key('enter')).result, 'no');
  assert.equal(handleConfirm(c, key('escape')).result, 'no');
  const t = handleConfirm(c, key('tab')).state;
  assert.equal(t.choice, 'yes');
  assert.equal(handleConfirm(t, key('enter')).result, 'yes');
  assert.equal(handleConfirm(c, key('q')).result, null);
});

test('confirm: type the name to confirm', () => {
  let c = createConfirm({ title: 'Delete project', message: 'This removes the worktree.', requireText: 'web' });
  assert.equal(confirmReady(c), false);
  assert.equal(handleConfirm(c, key('y')).result, null, 'y is typed, not a shortcut');
  c = handleConfirm(c, key('w')).state;
  c = handleConfirm(c, key('e')).state;
  assert.equal(handleConfirm(c, key('enter')).result, null);
  c = handleConfirm(c, key('b')).state;
  assert.equal(confirmReady(c), true);
  assert.equal(handleConfirm(c, key('enter')).result, 'yes');
  assert.equal(handleConfirm(c, key('escape')).result, 'no');
});

test('confirm: render and click the buttons', () => {
  const f = createFrame(60, 12);
  let c = createConfirm({ title: 'Delete', message: 'Delete the session "fix 宽 bug"?', yesLabel: 'Delete', noLabel: 'Keep' });
  c = renderConfirm(f, { x: 0, y: 0, w: 60, h: 12 }, c);
  const text = Array.from({ length: 12 }, (_, y) => f.rowText(y)).join('\n');
  assert.ok(text.includes('Delete the session'), text);
  assert.ok(text.includes(' Delete ') && text.includes(' Keep '), text);
  assert.ok(c.hit.yes && c.hit.no);
  assert.equal(handleConfirm(c, click(c.hit.yes!.x, c.hit.yes!.y)).result, 'yes');
  assert.equal(handleConfirm(c, click(c.hit.no!.x + 1, c.hit.no!.y)).result, 'no');
  assert.equal(handleConfirm(c, click(0, 0)).result, null);
  for (let y = 0; y < 12; y++) assert.ok(stringWidth(f.rowText(y)) <= 60);
});

test('menu: item keys, j/k with Enter, Esc, and clicks', () => {
  const k = (key: string): InputEvent => ({ type: 'key', key, ctrl: false, alt: false, shift: false, raw: key });
  let m = createMenu('Snooze', [{ key: '1', label: 'One' }, { key: 't', label: 'Two', detail: '09:00' }], 'note');
  assert.equal(handleMenu(m, k('t')).result, 1);
  assert.equal(handleMenu(m, k('escape')).result, 'cancel');
  assert.equal(handleMenu(m, k('x')).result, null);
  m = handleMenu(m, k('j')).state;
  assert.equal(m.picked, 1);
  assert.equal(handleMenu(m, k('enter')).result, 1);
  const f = createFrame(60, 20);
  m = renderMenu(f, { x: 0, y: 0, w: 60, h: 20 }, m);
  assert.ok(m.hit && m.box);
  const text = [...Array(20).keys()].map((y) => f.rowText(y)).join('\n');
  assert.match(text, /t\s+Two\s+09:00/);
  const at = (x: number, y: number): InputEvent => ({ type: 'mouse', x, y, button: 'left', action: 'down', ctrl: false, alt: false, shift: false, raw: '' });
  assert.equal(handleMenu(m, at(m.hit!.x + 2, m.hit!.y)).result, 0);
  assert.equal(handleMenu(m, at(m.box!.x + 1, m.box!.y)).result, null, 'a click on the box keeps it open');
  assert.equal(handleMenu(m, at(0, 0)).result, 'cancel');
});
