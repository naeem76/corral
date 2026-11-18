import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_DEFAULT } from '../../src/types.ts';
import { CSI, ESC, cell, cursor, make, rowText, run, text } from './helpers.ts';

// ---------------------------------------------------------------------------
// Plain text, wrap, pending wrap
// ---------------------------------------------------------------------------

test('plain text and CR LF', () => {
  const em = run('hello\r\nworld');
  assert.equal(text(em), 'hello\nworld');
  assert.deepEqual(cursor(em), [5, 1]);
});

test('LF keeps the column (no newline mode)', () => {
  assert.equal(text(run('ab\ncd')), 'ab\n  cd');
});

test('autowrap moves to the next row', () => {
  const em = run('0123456789ab', 10, 3);
  assert.equal(text(em), '0123456789\nab');
});

test('pending wrap: cursor stays on the last column until the next character', () => {
  const em = run('0123456789', 10, 3);
  assert.deepEqual(cursor(em), [9, 0]);
  em.write('X');
  assert.equal(text(em), '0123456789\nX');
  assert.deepEqual(cursor(em), [1, 1]);
});

test('pending wrap is cleared by CR, cursor movement and erase', () => {
  let em = run('0123456789\rX', 10, 3);
  assert.equal(text(em), 'X123456789');
  em = run(`0123456789${CSI}DX`, 10, 3);
  assert.equal(text(em), '01234567X9');
  em = run(`0123456789${CSI}KX`, 10, 3);
  // EL 0 clears the last cell, then X overwrites it in place (no wrap).
  assert.equal(text(em), '012345678X');
});

test('pending wrap: LF after a full row moves only one row', () => {
  const em = run('0123456789\r\nX', 10, 3);
  assert.equal(text(em), '0123456789\nX');
});

test('pending wrap: BS moves to the column before the last', () => {
  const em = run('0123456789\bX', 10, 3);
  assert.equal(text(em), '0123456789'.slice(0, 8) + 'X9');
});

test('autowrap off: last column is overwritten', () => {
  const em = run(`${CSI}?7l0123456789abc`, 10, 3);
  assert.equal(text(em), '012345678c');
  assert.deepEqual(cursor(em), [9, 0]);
});

test('wrap at the bottom scrolls', () => {
  const em = run('0123456789abcdefghijXY', 10, 2);
  assert.equal(text(em), 'abcdefghij\nXY');
});

// ---------------------------------------------------------------------------
// Cursor movement
// ---------------------------------------------------------------------------

test('CUP, HVP, CHA, HPA, VPA, relative moves', () => {
  const { em } = make(10, 5);
  em.write(`${CSI}3;4H`);
  assert.deepEqual(cursor(em), [3, 2]);
  em.write(`${CSI}2;2f`);
  assert.deepEqual(cursor(em), [1, 1]);
  em.write(`${CSI}H`);
  assert.deepEqual(cursor(em), [0, 0]);
  em.write(`${CSI}7G`);
  assert.deepEqual(cursor(em), [6, 0]);
  em.write(`${CSI}3\``);
  assert.deepEqual(cursor(em), [2, 0]);
  em.write(`${CSI}4d`);
  assert.deepEqual(cursor(em), [2, 3]);
  em.write(`${CSI}A`);
  assert.deepEqual(cursor(em), [2, 2]);
  em.write(`${CSI}2B`);
  assert.deepEqual(cursor(em), [2, 4]);
  em.write(`${CSI}3C`);
  assert.deepEqual(cursor(em), [5, 4]);
  em.write(`${CSI}0D`);
  assert.deepEqual(cursor(em), [4, 4]);
  em.write(`${CSI}2a`);
  assert.deepEqual(cursor(em), [6, 4]);
  em.write(`${CSI}2F`);
  assert.deepEqual(cursor(em), [0, 2]);
  em.write(`${CSI}5C${CSI}E`);
  assert.deepEqual(cursor(em), [0, 3]);
  em.write(`${CSI}H${CSI}e`);
  assert.deepEqual(cursor(em), [0, 1]);
});

test('cursor movement clamps at the edges', () => {
  const { em } = make(10, 5);
  em.write(`${CSI}99;99H`);
  assert.deepEqual(cursor(em), [9, 4]);
  em.write(`${CSI}99A${CSI}99D`);
  assert.deepEqual(cursor(em), [0, 0]);
  em.write(`${CSI}99B${CSI}99C`);
  assert.deepEqual(cursor(em), [9, 4]);
});

test('CUU/CUD stop at the scroll region margins when inside it', () => {
  const { em } = make(10, 10);
  em.write(`${CSI}3;6r${CSI}5;1H${CSI}9A`);
  assert.deepEqual(cursor(em), [0, 2]);
  em.write(`${CSI}9B`);
  assert.deepEqual(cursor(em), [0, 5]);
  // Outside the region the screen edge is the limit.
  em.write(`${CSI}9;1H${CSI}9B`);
  assert.deepEqual(cursor(em), [0, 9]);
});

test('origin mode: CUP is relative to the region and DSR reports relative rows', () => {
  const { em, replies } = make(10, 10);
  em.write(`${CSI}3;6r${CSI}?6h`);
  assert.deepEqual(cursor(em), [0, 2]);
  em.write(`${CSI}2;3H`);
  assert.deepEqual(cursor(em), [2, 3]);
  em.write(`${CSI}99;1H`);
  assert.deepEqual(cursor(em), [0, 5]);
  em.write(`${CSI}6n`);
  assert.deepEqual(replies, [`${CSI}4;1R`]);
  em.write(`${CSI}?6l`);
  assert.deepEqual(cursor(em), [0, 0]);
});

test('DECSC/DECRC and CSI s/u restore position, pen and origin mode', () => {
  const { em } = make(10, 5);
  em.write(`${CSI}2;3H${CSI}31m${ESC}7${CSI}H${CSI}0m${ESC}8X`);
  assert.equal(cell(em, 2, 1).ch, 'X');
  assert.equal(cell(em, 2, 1).fg, 1);
  em.write(`${CSI}4;4H${CSI}s${CSI}H${CSI}uY`);
  assert.equal(cell(em, 3, 3).ch, 'Y');
});

test('DECRC without a save goes home with default pen', () => {
  const em = run(`${CSI}3;3H${CSI}31m${ESC}8X`);
  assert.equal(cell(em, 0, 0).ch, 'X');
  assert.equal(cell(em, 0, 0).fg, COLOR_DEFAULT);
});

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------

const FULL = 'abcdefghij\r\nklmnopqrst\r\nuvwxyz0123';

test('ED 0, 1, 2 and 3', () => {
  assert.equal(text(run(`${FULL}${CSI}2;5H${CSI}J`, 10, 3)), 'abcdefghij\nklmn');
  assert.equal(text(run(`${FULL}${CSI}2;5H${CSI}1J`, 10, 3)), '\n     pqrst\nuvwxyz0123');
  assert.equal(text(run(`${FULL}${CSI}2;5H${CSI}2J`, 10, 3)), '');
  assert.deepEqual(cursor(run(`${FULL}${CSI}2;5H${CSI}2J`, 10, 3)), [4, 1]);
  // ED 3 clears scrollback only; the screen stays.
  assert.equal(text(run(`${FULL}${CSI}3J`, 10, 3)), 'abcdefghij\nklmnopqrst\nuvwxyz0123');
});

test('EL 0, 1, 2', () => {
  assert.equal(rowText(run(`${FULL}${CSI}2;5H${CSI}K`, 10, 3), 1), 'klmn');
  assert.equal(rowText(run(`${FULL}${CSI}2;5H${CSI}1K`, 10, 3), 1), '     pqrst');
  assert.equal(rowText(run(`${FULL}${CSI}2;5H${CSI}2K`, 10, 3), 1), '');
});

test('erase uses the current background color (BCE)', () => {
  const em = run(`${CSI}44m${CSI}2J`, 4, 2);
  assert.equal(cell(em, 3, 1).bg, 4);
  assert.equal(cell(em, 3, 1).ch, '');
  const em2 = run(`abcd${CSI}H${CSI}42m${CSI}2X`, 4, 1);
  assert.equal(rowText(em2, 0), '  cd');
  assert.equal(cell(em2, 1, 0).bg, 2);
  assert.equal(cell(em2, 2, 0).bg, COLOR_DEFAULT);
});

test('ECH erases without moving and stops at the line end', () => {
  const em = run(`abcdefghij${CSI}1;3H${CSI}3X`, 10, 1);
  assert.equal(rowText(em, 0), 'ab   fghij');
  assert.deepEqual(cursor(em), [2, 0]);
  assert.equal(rowText(run(`abcdefghij${CSI}1;8H${CSI}99X`, 10, 1), 0), 'abcdefg');
});

// ---------------------------------------------------------------------------
// Insert and delete
// ---------------------------------------------------------------------------

test('ICH and DCH', () => {
  assert.equal(rowText(run(`abcdefghij${CSI}1;3H${CSI}2@`, 10, 1), 0), 'ab  cdefgh');
  assert.equal(rowText(run(`abcdefghij${CSI}1;3H${CSI}2P`, 10, 1), 0), 'abefghij');
  assert.equal(rowText(run(`abcdefghij${CSI}1;3H${CSI}99P`, 10, 1), 0), 'ab');
});

test('insert mode (IRM) shifts text right', () => {
  const em = run(`abcdef${CSI}1;2H${CSI}4hXY${CSI}4lZ`, 8, 1);
  assert.equal(rowText(em, 0), 'aXYZcdef');
});

test('IL and DL inside the scroll region', () => {
  const rows = 'r0\r\nr1\r\nr2\r\nr3\r\nr4';
  const il = run(`${rows}${CSI}2;4r${CSI}3;2H${CSI}L`, 4, 5);
  assert.equal(text(il), 'r0\nr1\n\nr2\nr4');
  assert.deepEqual(cursor(il), [0, 2]);
  const dl = run(`${rows}${CSI}2;4r${CSI}2;1H${CSI}2M`, 4, 5);
  assert.equal(text(dl), 'r0\nr3\n\n\nr4');
  // Outside the region IL/DL do nothing.
  const out = run(`${rows}${CSI}2;4r${CSI}5;1H${CSI}L`, 4, 5);
  assert.equal(text(out), 'r0\nr1\nr2\nr3\nr4');
  // Large counts clear to the region bottom.
  const big = run(`${rows}${CSI}2;4r${CSI}3;1H${CSI}99L`, 4, 5);
  assert.equal(text(big), 'r0\nr1\n\n\nr4');
});

test('SU and SD scroll only the region', () => {
  const rows = 'r0\r\nr1\r\nr2\r\nr3\r\nr4';
  assert.equal(text(run(`${rows}${CSI}2;4r${CSI}S`, 4, 5)), 'r0\nr2\nr3\n\nr4');
  assert.equal(text(run(`${rows}${CSI}2;4r${CSI}2T`, 4, 5)), 'r0\n\n\nr1\nr4');
  assert.equal(text(run(`${rows}${CSI}S`, 4, 5)), 'r1\nr2\nr3\nr4');
});

test('LF at the region bottom scrolls the region; below it LF does not scroll', () => {
  const rows = 'r0\r\nr1\r\nr2\r\nr3\r\nr4';
  assert.equal(text(run(`${rows}${CSI}2;4r${CSI}4;1H\nX`, 4, 5)), 'r0\nr2\nr3\nX\nr4');
  const em = run(`${rows}${CSI}2;4r${CSI}5;1H\n\nX`, 4, 5);
  assert.equal(text(em), 'r0\nr1\nr2\nr3\nX4');
});

test('RI at the region top scrolls down; IND and NEL', () => {
  const rows = 'r0\r\nr1\r\nr2\r\nr3\r\nr4';
  assert.equal(text(run(`${rows}${CSI}2;4r${CSI}2;1H${ESC}MX`, 4, 5)), 'r0\nX\nr1\nr2\nr4');
  assert.equal(text(run(`${rows}${CSI}1;1H${ESC}MX`, 4, 5)), 'X\nr0\nr1\nr2\nr3');
  assert.equal(text(run(`${CSI}2;2H${ESC}DX`, 4, 5)), '\n\n X');
  assert.equal(text(run(`${CSI}2;2H${ESC}EX`, 4, 5)), '\n\nX');
});

test('scrolled-in rows take the current background', () => {
  const em = run(`${CSI}41m\n\n\n\n\n`, 3, 3);
  assert.equal(cell(em, 0, 2).bg, 1);
});

test('DECSTBM homes the cursor and rejects invalid regions', () => {
  const em = run(`${CSI}3;3H${CSI}2;4r`, 5, 5);
  assert.deepEqual(cursor(em), [0, 0]);
  // top >= bottom is ignored: the full screen still scrolls.
  const em2 = run(`${CSI}4;2r${CSI}5;1Ha\nb`, 5, 5);
  assert.equal(text(em2), '\n\n\na\n b');
});

test('REP repeats the last printed character', () => {
  assert.equal(rowText(run(`ab${CSI}3b`, 10, 1), 0), 'abbbb');
  assert.equal(rowText(run(`${CSI}3b`, 10, 1), 0), '');
  assert.equal(text(run(`a${CSI}6b`, 4, 2)), 'aaaa\naaa');
  // A huge count is capped at one screenful.
  assert.equal(rowText(run(`a${CSI}65535b`, 4, 2), 0), 'aaaa');
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

test('default tab stops every 8 columns, HT stops at the last column', () => {
  const { em } = make(20, 1);
  em.write('\t');
  assert.deepEqual(cursor(em), [8, 0]);
  em.write('\t\t\t');
  assert.deepEqual(cursor(em), [19, 0]);
});

test('HTS, TBC, CHT, CBT', () => {
  const { em } = make(30, 1);
  em.write(`${CSI}4G${ESC}H${CSI}H\t`);
  assert.deepEqual(cursor(em), [3, 0]);
  em.write(`${CSI}2I`);
  assert.deepEqual(cursor(em), [16, 0]);
  em.write(`${CSI}2Z`);
  assert.deepEqual(cursor(em), [3, 0]);
  em.write(`${CSI}g${CSI}H\t`);
  assert.deepEqual(cursor(em), [8, 0]);
  em.write(`${CSI}3g${CSI}H\t`);
  assert.deepEqual(cursor(em), [29, 0]);
});

// ---------------------------------------------------------------------------
// Wide characters and graphemes
// ---------------------------------------------------------------------------

test('wide character takes two cells', () => {
  const em = run('a日b', 10, 1);
  assert.equal(cell(em, 1, 0).ch, '日');
  assert.equal(cell(em, 1, 0).width, 2);
  assert.equal(cell(em, 2, 0).ch, '');
  assert.equal(cell(em, 2, 0).width, 0);
  assert.equal(cell(em, 3, 0).ch, 'b');
  assert.equal(rowText(em, 0), 'a日b');
  assert.deepEqual(cursor(em), [4, 0]);
});

test('wide character at the last column wraps first', () => {
  const em = run('abc日', 4, 2);
  assert.equal(text(em), 'abc\n日');
  assert.equal(cell(em, 3, 0).ch, '');
  assert.equal(cell(em, 0, 1).width, 2);
});

test('wide character exactly filling the row sets pending wrap', () => {
  const em = run('ab日', 4, 2);
  assert.deepEqual(cursor(em), [3, 0]);
  em.write('c');
  assert.equal(text(em), 'ab日\nc');
});

test('overwriting the right half clears the left half', () => {
  const em = run(`日${CSI}1;2Hx`, 4, 1);
  assert.equal(cell(em, 0, 0).ch, '');
  assert.equal(cell(em, 0, 0).width, 1);
  assert.equal(cell(em, 1, 0).ch, 'x');
});

test('overwriting the left half clears the right half', () => {
  const em = run(`日${CSI}1;1Hx`, 4, 1);
  assert.equal(cell(em, 0, 0).ch, 'x');
  assert.equal(cell(em, 1, 0).width, 1);
  assert.equal(cell(em, 1, 0).ch, '');
});

test('a wide character over another wide character offset by one', () => {
  const em = run(`a日${CSI}1;1H本`, 4, 1);
  // 本 at 0-1 cuts 日 at 1-2: the remaining right half at 2 is blank.
  assert.equal(cell(em, 0, 0).ch, '本');
  assert.equal(cell(em, 1, 0).width, 0);
  assert.equal(cell(em, 2, 0).ch, '');
  assert.equal(cell(em, 2, 0).width, 1);
});

test('erase and ECH cutting a wide character clear both halves', () => {
  const em = run(`日本${CSI}1;2H${CSI}X`, 6, 1);
  assert.equal(cell(em, 0, 0).width, 1);
  assert.equal(cell(em, 0, 0).ch, '');
  assert.equal(cell(em, 2, 0).ch, '本');
  const em2 = run(`日本${CSI}1;3H${CSI}1K`, 6, 1);
  assert.equal(cell(em2, 3, 0).width, 1);
  assert.equal(cell(em2, 3, 0).ch, '');
});

test('DCH and ICH never leave half a wide character', () => {
  const em = run(`a日b${CSI}1;1H${CSI}2P`, 6, 1);
  assert.equal(rowText(em, 0), ' b');
  const em2 = run(`abc日${CSI}1;1H${CSI}@`, 5, 1);
  assert.equal(rowText(em2, 0), ' abc');
  assert.equal(cell(em2, 4, 0).width, 1);
});

test('wide character with autowrap off at the last column goes one cell left', () => {
  const em = run(`${CSI}?7labc日`, 4, 1);
  assert.equal(rowText(em, 0), 'ab日');
});

test('combining marks join the previous cell, also across writes', () => {
  const em = run('éx', 4, 1);
  assert.equal(cell(em, 0, 0).ch, 'é');
  assert.equal(cell(em, 1, 0).ch, 'x');
  const { em: em2 } = make(4, 1);
  em2.write('e');
  em2.write('́');
  em2.write('x');
  assert.equal(cell(em2, 0, 0).ch, 'é');
  assert.deepEqual(cursor(em2), [2, 0]);
});

test('combining mark after a full row joins the last cell, not the next row', () => {
  const em = run('abcd́', 4, 2);
  assert.equal(cell(em, 3, 0).ch, 'd́');
  assert.equal(text(em), 'abcd́');
});

test('ZWJ sequences, skin tones, flags and VS16 form one cluster', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const em = run(family + 'x', 10, 1);
  assert.equal(cell(em, 0, 0).ch, family);
  assert.equal(cell(em, 0, 0).width, 2);
  assert.equal(cell(em, 2, 0).ch, 'x');

  const thumbs = '\u{1F44D}\u{1F3FD}';
  assert.equal(cell(run(thumbs, 10, 1), 0, 0).ch, thumbs);

  const flag = '\u{1F1FA}\u{1F1F8}';
  const em3 = run(flag + flag, 10, 1);
  assert.equal(cell(em3, 0, 0).ch, flag);
  assert.equal(cell(em3, 2, 0).ch, flag);

  const heart = '❤️';
  const em4 = run(heart + 'x', 10, 1);
  assert.equal(cell(em4, 0, 0).ch, heart);
  assert.equal(cell(em4, 0, 0).width, 2);
  assert.equal(cell(em4, 2, 0).ch, 'x');
});

test('a cluster split over several writes, also inside a surrogate pair', () => {
  const s = 'a\u{1F468}‍\u{1F469}b';
  const whole = run(s, 10, 1);
  for (let i = 0; i <= s.length; i++) {
    const { em } = make(10, 1);
    em.write(s.slice(0, i));
    em.write(s.slice(i));
    for (let x = 0; x < 10; x++) assert.deepEqual(cell(em, x, 0), cell(whole, x, 0), `split ${i} x ${x}`);
  }
});

test('ZWJ followed by plain text does not join', () => {
  const em = run('a‍b', 4, 1);
  assert.equal(cell(em, 0, 0).ch, 'a‍');
  assert.equal(cell(em, 1, 0).ch, 'b');
});

test('a lone surrogate prints the replacement character', () => {
  assert.equal(cell(run('\uD800x', 4, 1), 0, 0).ch, '�');
  assert.equal(cell(run('\uDC00x', 4, 1), 0, 0).ch, '�');
});

test('a mark at the start of the screen is dropped', () => {
  const em = run('́a', 4, 1);
  assert.equal(cell(em, 0, 0).ch, 'a');
});

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

test('DEC Special Graphics via ESC ( 0 and via SO/SI', () => {
  assert.equal(rowText(run(`${ESC}(0lqqk${ESC}(Bq`, 10, 1), 0), '┌──┐q');
  assert.equal(rowText(run(`${ESC})0a\x0exqx\x0fx`, 10, 1), 0), 'a│─│x');
});

test('DECSC saves the character set', () => {
  assert.equal(rowText(run(`${ESC}(0${ESC}7${ESC}(B${ESC}8q`, 10, 1), 0), '─');
});

// ---------------------------------------------------------------------------
// Alternate screen
// ---------------------------------------------------------------------------

test('1049 saves the cursor, clears the alternate screen and restores on exit', () => {
  const { em } = make(10, 3);
  em.write(`primary${CSI}2;3H`);
  em.write(`${CSI}?1049h`);
  assert.equal(em.modes.altScreen, true);
  assert.equal(text(em), '');
  em.write(`${CSI}Halt`);
  assert.equal(text(em), 'alt');
  em.write(`${CSI}?1049l`);
  assert.equal(em.modes.altScreen, false);
  assert.equal(text(em), 'primary');
  assert.deepEqual(cursor(em), [2, 1]);
  // Entering again shows a clean alternate screen.
  em.write(`${CSI}?1049h`);
  assert.equal(text(em), '');
});

test('47 switches without clearing; 1047 clears the alternate screen on exit', () => {
  const { em } = make(10, 3);
  em.write(`${CSI}?47hA${CSI}?47l`);
  assert.equal(text(em), '');
  em.write(`${CSI}?47h`);
  assert.equal(text(em), 'A');
  em.write(`${CSI}?47l${CSI}?1047h`);
  assert.equal(text(em), 'A');
  em.write(`${CSI}?1047l${CSI}?1047h`);
  assert.equal(text(em), '');
});

test('1048 saves and restores the cursor', () => {
  const em = run(`${CSI}2;2H${CSI}?1048h${CSI}H${CSI}?1048lX`, 5, 3);
  assert.equal(cell(em, 1, 1).ch, 'X');
});

// ---------------------------------------------------------------------------
// Resets, DECALN, DECSCUSR
// ---------------------------------------------------------------------------

test('RIS clears everything', () => {
  const { em } = make(5, 3);
  em.write(`abc${CSI}?1049h${CSI}?25l${CSI}?1000h${ESC}]0;t\x07${CSI}31m${ESC}c`);
  assert.equal(text(em), '');
  assert.equal(em.modes.altScreen, false);
  assert.equal(em.modes.mouse, 'none');
  assert.equal(em.cursor.visible, true);
  assert.equal(em.title, '');
  em.write('x');
  assert.equal(cell(em, 0, 0).fg, COLOR_DEFAULT);
});

test('DECSTR resets pen, region and modes but keeps the text', () => {
  const { em } = make(5, 5);
  em.write(`abc${CSI}2;3r${CSI}?25l${CSI}?1h${CSI}4h${CSI}31m${CSI}!p`);
  assert.equal(text(em), 'abc');
  assert.equal(em.cursor.visible, true);
  assert.equal(em.modes.appCursorKeys, false);
  // The region is the full screen again: LF on the last row scrolls 'abc' away.
  em.write(`${CSI}5;1H\nX`);
  assert.equal(text(em), '\n\n\n\nX');
  assert.equal(cell(em, 0, 3).fg, COLOR_DEFAULT);
});

test('DECALN fills the screen with E', () => {
  assert.equal(text(run(`${ESC}#8`, 3, 2)), 'EEE\nEEE');
});

test('DECSCUSR stores the shape', async () => {
  const { Terminal } = await import('../../src/term/index.ts');
  const t = new Terminal(5, 2);
  t.write(`${CSI}6 q`);
  assert.equal(t.cursorShape, 'bar');
  assert.equal(t.cursorBlink, false);
  t.write(`${CSI}3 q`);
  assert.equal(t.cursorShape, 'underline');
  assert.equal(t.cursorBlink, true);
});

// ---------------------------------------------------------------------------
// Resize and reads
// ---------------------------------------------------------------------------

test('resize keeps the top-left content and clamps the cursor', () => {
  const { em } = make(10, 5);
  em.write(`abcdefghij\r\n0123456789${CSI}5;10H`);
  em.resize(4, 3);
  assert.equal(text(em), 'abcd\n0123');
  assert.deepEqual(cursor(em), [3, 2]);
  em.resize(8, 6);
  assert.equal(text(em), 'abcd\n0123');
  assert.equal(em.cols, 8);
  assert.equal(em.rows, 6);
});

test('resize resets the scroll region and tab stops, and resizes both buffers', () => {
  const { em } = make(10, 5);
  em.write(`${CSI}2;3r${CSI}?1049hALT`);
  em.resize(20, 6);
  em.write(`${CSI}6;1H\nX`);
  // With the region reset, LF on the last row scrolls the whole screen and ALT leaves it.
  assert.equal(text(em), '\n\n\n\n\nX');
  em.write(`${CSI}H\t\t`);
  assert.deepEqual(cursor(em), [16, 0]);
  em.write(`${CSI}?1049l`);
  assert.equal(em.cols, 20);
  em.write(`${CSI}1;20HZ`);
  assert.equal(cell(em, 19, 0).ch, 'Z');
});

test('resize that cuts a wide character blanks it', () => {
  const { em } = make(4, 1);
  em.write('abc');
  em.write(`${CSI}1;3H日`);
  em.resize(3, 1);
  assert.equal(cell(em, 2, 0).width, 1);
  assert.equal(cell(em, 2, 0).ch, '');
});

test('readCell outside the grid returns a blank cell', () => {
  const em = run('abc', 3, 1);
  for (const [x, y] of [
    [-1, 0],
    [3, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    assert.deepEqual(cell(em, x, y), { ch: '', width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 });
  }
});

test('readCell fills and returns the given object', () => {
  const em = run('a', 3, 1);
  const out = { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 };
  assert.equal(em.readCell(0, 0, out), out);
  assert.equal(out.ch, 'a');
});
