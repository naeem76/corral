import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertColor, defaultTheme, detectColorDepth, paletteRgb, rgb, rgbTo16, rgbTo256, sgrTransition, statusDot, style,
} from '../../src/tui/style.ts';
import { ATTR, COLOR_DEFAULT } from '../../src/types.ts';

test('rgb to 256 and 16', () => {
  assert.equal(rgbTo256(255, 0, 0), 196);
  assert.equal(rgbTo256(0, 0, 0), 16);
  assert.equal(rgbTo256(128, 128, 128), 244);
  assert.equal(rgbTo16(250, 10, 10), 9);
  assert.equal(rgbTo16(0, 0, 0), 0);
  assert.equal(rgbTo16(250, 250, 250), 15);
  for (let i = 16; i < 256; i++) {
    const [r, g, b] = paletteRgb(i);
    assert.deepEqual(paletteRgb(rgbTo256(r, g, b)), [r, g, b], `palette ${i} round-trips`);
  }
});

test('convertColor per depth', () => {
  const red = rgb(255, 0, 0);
  assert.equal(convertColor(red, 'truecolor'), red);
  assert.equal(convertColor(red, '256'), 196);
  assert.equal(convertColor(red, '16'), 9);
  assert.equal(convertColor(196, '16'), 9);
  assert.equal(convertColor(3, '16'), 3);
  assert.equal(convertColor(COLOR_DEFAULT, '16'), COLOR_DEFAULT);
});

test('detectColorDepth', () => {
  assert.equal(detectColorDepth({ WT_SESSION: 'x' }), 'truecolor');
  assert.equal(detectColorDepth({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM: 'xterm-256color' }), '256');
  assert.equal(detectColorDepth({ TERM: 'linux' }), '16');
  assert.equal(detectColorDepth({ CORRAL_COLOR_DEPTH: '16', WT_SESSION: 'x' }), '16');
  assert.equal(detectColorDepth({}), 'truecolor');
});

test('sgrTransition: full and incremental forms', () => {
  assert.equal(sgrTransition(null, style()), '\x1b[0m');
  assert.equal(sgrTransition(null, style(1, 4, ATTR.bold)), '\x1b[0;1;31;44m');
  assert.equal(sgrTransition(style(1), style(1)), '');
  assert.equal(sgrTransition(style(1), style(2)), '\x1b[32m');
  assert.equal(sgrTransition(style(), style(200, rgb(1, 2, 3))), '\x1b[38;5;200;48;2;1;2;3m');
  // Bold off while dim stays on: the reset form is shorter than 22;2.
  assert.equal(sgrTransition(style(-1, -1, ATTR.bold | ATTR.dim), style(-1, -1, ATTR.dim)), '\x1b[0;2m');
  assert.equal(sgrTransition(style(5, 6, ATTR.bold | ATTR.dim), style(5, 6, ATTR.dim)), '\x1b[22;2m');
  // Many attributes off: a reset is shorter.
  const all = ATTR.bold | ATTR.italic | ATTR.underline | ATTR.inverse | ATTR.strike;
  assert.equal(sgrTransition(style(1, 2, all), style()), '\x1b[0m');
  assert.equal(sgrTransition(style(), style(9, 12)), '\x1b[91;104m');
});

test('theme status dots', () => {
  assert.equal(statusDot('needs-input').glyph, '●');
  assert.equal(statusDot('needs-input').style.fg, 1);
  assert.equal(statusDot('working').style.fg, 3);
  assert.equal(statusDot('unseen').style.fg, 2);
  assert.equal(statusDot('idle').style.fg, defaultTheme.status.idle);
});
