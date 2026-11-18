import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTR, COLOR_DEFAULT, COLOR_RGB } from '../../src/types.ts';
import { CSI, cell, run } from './helpers.ts';

/** Cell 'X' written after the given SGR parameter text. */
function pen(params: string): { fg: number; bg: number; attrs: number } {
  const c = cell(run(`${CSI}${params}mX`), 0, 0);
  assert.equal(c.ch, 'X', 'SGR text must not leak into the grid');
  return { fg: c.fg, bg: c.bg, attrs: c.attrs };
}

const rgb = (r: number, g: number, b: number): number => COLOR_RGB | (r << 16) | (g << 8) | b;

test('attributes on', () => {
  assert.equal(pen('1').attrs, ATTR.bold);
  assert.equal(pen('2').attrs, ATTR.dim);
  assert.equal(pen('3').attrs, ATTR.italic);
  assert.equal(pen('4').attrs, ATTR.underline);
  assert.equal(pen('5').attrs, ATTR.blink);
  assert.equal(pen('6').attrs, ATTR.blink);
  assert.equal(pen('7').attrs, ATTR.inverse);
  assert.equal(pen('8').attrs, ATTR.hidden);
  assert.equal(pen('9').attrs, ATTR.strike);
  assert.equal(pen('21').attrs, ATTR.underline);
  assert.equal(pen('1;3;4;7').attrs, ATTR.bold | ATTR.italic | ATTR.underline | ATTR.inverse);
});

test('attributes off', () => {
  assert.equal(pen('1;2;22').attrs, 0);
  assert.equal(pen('3;23').attrs, 0);
  assert.equal(pen('4;24').attrs, 0);
  assert.equal(pen('5;25').attrs, 0);
  assert.equal(pen('7;27').attrs, 0);
  assert.equal(pen('8;28').attrs, 0);
  assert.equal(pen('9;29').attrs, 0);
  assert.deepEqual(pen('1;31;42;0'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('1;31;42;'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('1;31;42m\x1b['), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
});

test('underline styles with colon sub-parameters', () => {
  assert.equal(pen('4:3').attrs, ATTR.underline);
  assert.equal(pen('4:1').attrs, ATTR.underline);
  assert.equal(pen('4;4:0').attrs, 0);
  // A sub-parameter must not be read as an SGR code of its own (3 = italic).
  assert.equal(pen('4:3').attrs & ATTR.italic, 0);
});

test('16 colors', () => {
  assert.equal(pen('31').fg, 1);
  assert.equal(pen('37').fg, 7);
  assert.equal(pen('44').bg, 4);
  assert.equal(pen('90').fg, 8);
  assert.equal(pen('97').fg, 15);
  assert.equal(pen('100').bg, 8);
  assert.equal(pen('107').bg, 15);
  assert.equal(pen('31;39').fg, COLOR_DEFAULT);
  assert.equal(pen('41;49').bg, COLOR_DEFAULT);
});

test('256 colors and truecolor, semicolon forms', () => {
  assert.equal(pen('38;5;196').fg, 196);
  assert.equal(pen('48;5;17').bg, 17);
  assert.equal(pen('38;2;1;2;3').fg, rgb(1, 2, 3));
  assert.equal(pen('48;2;255;128;0').bg, rgb(255, 128, 0));
  assert.deepEqual(pen('38;2;10;20;30;48;5;4;1'), { fg: rgb(10, 20, 30), bg: 4, attrs: ATTR.bold });
});

test('colon forms', () => {
  assert.equal(pen('38:2::1:2:3').fg, rgb(1, 2, 3));
  assert.equal(pen('38:2:1:2:3').fg, rgb(1, 2, 3));
  assert.equal(pen('38:2:0:1:2:3').fg, rgb(1, 2, 3));
  assert.equal(pen('48:5:9').bg, 9);
  assert.deepEqual(pen('38:5:9;1'), { fg: 9, bg: COLOR_DEFAULT, attrs: ATTR.bold });
});

test('out-of-range color values', () => {
  assert.equal(pen('38;5;256').fg, COLOR_DEFAULT);
  assert.equal(pen('38;2;300;0;999').fg, rgb(255, 0, 255));
});

test('truncated color parameter lists are consumed without side effects', () => {
  assert.deepEqual(pen('38;2;1;2'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('38;5'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('38'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('48;2'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('38:2:1'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  // An unknown color kind skips only the kind.
  assert.deepEqual(pen('38;7;1'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: ATTR.bold });
});

test('underline color 58/59 is ignored and its parameters consumed', () => {
  assert.deepEqual(pen('58;2;1;2;3;1'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: ATTR.bold });
  assert.deepEqual(pen('58;5;3;4'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: ATTR.underline });
  assert.deepEqual(pen('58:2::1:2:3;31'), { fg: 1, bg: COLOR_DEFAULT, attrs: 0 });
  assert.deepEqual(pen('59;7'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: ATTR.inverse });
});

test('unknown SGR codes are ignored', () => {
  assert.deepEqual(pen('53;73;1'), { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: ATTR.bold });
});

test('private SGR-like sequences are not SGR', () => {
  // xterm modifyOtherKeys and XTQMODKEYS must not change the pen.
  assert.deepEqual(pen('31m\x1b[>4;1m\x1b[?4'), { fg: 1, bg: COLOR_DEFAULT, attrs: 0 });
});

test('the pen applies to wide characters and to both halves', () => {
  const em = run(`${CSI}38;2;1;2;3m日`);
  assert.equal(cell(em, 0, 0).fg, rgb(1, 2, 3));
  assert.equal(cell(em, 1, 0).fg, rgb(1, 2, 3));
});
