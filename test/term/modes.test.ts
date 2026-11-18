import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSI, ESC, make } from './helpers.ts';

test('default modes', () => {
  const { em } = make();
  assert.deepEqual({ ...em.modes }, {
    altScreen: false,
    appCursorKeys: false,
    appKeypad: false,
    bracketedPaste: false,
    focusEvents: false,
    mouse: 'none',
    mouseSgr: false,
  });
  assert.equal(em.cursor.visible, true);
});

test('cursor keys, keypad, paste, focus, cursor visibility', () => {
  const { em } = make();
  em.write(`${CSI}?1h${CSI}?66h${CSI}?2004h${CSI}?1004h${CSI}?25l`);
  assert.equal(em.modes.appCursorKeys, true);
  assert.equal(em.modes.appKeypad, true);
  assert.equal(em.modes.bracketedPaste, true);
  assert.equal(em.modes.focusEvents, true);
  assert.equal(em.cursor.visible, false);
  em.write(`${CSI}?1l${CSI}?66l${CSI}?2004l${CSI}?1004l${CSI}?25h`);
  assert.equal(em.modes.appCursorKeys, false);
  assert.equal(em.modes.appKeypad, false);
  assert.equal(em.modes.bracketedPaste, false);
  assert.equal(em.modes.focusEvents, false);
  assert.equal(em.cursor.visible, true);
});

test('ESC = and ESC > set the keypad mode', () => {
  const { em } = make();
  em.write(`${ESC}=`);
  assert.equal(em.modes.appKeypad, true);
  em.write(`${ESC}>`);
  assert.equal(em.modes.appKeypad, false);
});

test('mouse tracking modes and SGR encoding', () => {
  const { em, replies } = make();
  em.write(`${CSI}?9h`);
  assert.equal(em.modes.mouse, 'x10');
  em.write(`${CSI}?1000h`);
  assert.equal(em.modes.mouse, 'button');
  em.write(`${CSI}?1002h`);
  assert.equal(em.modes.mouse, 'drag');
  em.write(`${CSI}?1003h`);
  assert.equal(em.modes.mouse, 'any');
  // Resetting a mode that is not the current one changes nothing.
  em.write(`${CSI}?1000l`);
  assert.equal(em.modes.mouse, 'any');
  em.write(`${CSI}?1003l`);
  assert.equal(em.modes.mouse, 'none');
  em.write(`${CSI}?1000;1006h`);
  assert.equal(em.modes.mouse, 'button');
  assert.equal(em.modes.mouseSgr, true);
  for (const m of [1005, 1015, 1016]) {
    em.write(`${CSI}?${m}h`);
    assert.equal(em.modes.mouseSgr, true);
  }
  em.write(`${CSI}?1006l`);
  assert.equal(em.modes.mouseSgr, false);
  em.write(`${CSI}?1016$p${CSI}?1000$p${CSI}?1003$p`);
  assert.deepEqual(replies, [`${CSI}?1016;1$y`, `${CSI}?1000;1$y`, `${CSI}?1003;2$y`]);
});

test('the modes object is live (same object, new values)', () => {
  const { em } = make();
  const m = em.modes;
  em.write(`${CSI}?2004h`);
  assert.equal(m.bracketedPaste, true);
});

test('2027 and 2031 are tracked', () => {
  const { em, replies } = make();
  em.write(`${CSI}?2027h${CSI}?2031h${CSI}?2027$p${CSI}?2031$p${CSI}?2031l${CSI}?2031$p`);
  assert.deepEqual(replies, [`${CSI}?2027;1$y`, `${CSI}?2031;1$y`, `${CSI}?2031;2$y`]);
});

test('LNM (mode 20): LF also returns the carriage', () => {
  const { em } = make(10, 3);
  em.write(`${CSI}20hab\ncd`);
  assert.equal(em.readCell(0, 1, { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 }).ch, 'c');
});

// ---------------------------------------------------------------------------
// version and synchronized output
// ---------------------------------------------------------------------------

test('version increases on visible changes, cursor moves, modes and title', () => {
  const { em } = make();
  let v = em.version;
  for (const s of ['a', `${CSI}H`, `${CSI}?25l`, `${CSI}?2004h`, `${ESC}]0;t\x07`, `${CSI}2J`, '\r\n']) {
    em.write(s);
    assert.ok(em.version > v, `version after ${JSON.stringify(s)}`);
    v = em.version;
  }
});

test('version does not change for pure queries', () => {
  const { em } = make();
  const v = em.version;
  em.write(`${CSI}6n${CSI}c${CSI}?2026$p${ESC}]11;?\x07${CSI}?u`);
  assert.equal(em.version, v);
});

test('resize increases version', () => {
  const { em } = make();
  const v = em.version;
  em.resize(20, 10);
  assert.ok(em.version > v);
});

test('synchronized output: no version change until the frame ends, then exactly one', () => {
  let now = 0;
  const { em } = make(10, 3, { now: () => now });
  const v0 = em.version;
  em.write(`${CSI}?2026h`);
  em.write('abc');
  em.write(`${CSI}2;2Hdef`);
  assert.equal(em.version, v0);
  // The grid is updated already.
  assert.equal(em.readCell(0, 0, { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 }).ch, 'a');
  now = 500;
  em.write('more');
  assert.equal(em.version, v0);
  em.write(`${CSI}?2026l`);
  assert.equal(em.version, v0 + 1);
});

test('synchronized output inside one write counts once', () => {
  const { em } = make(10, 3, { now: () => 0 });
  const v0 = em.version;
  em.write(`${CSI}?2026h${CSI}Hframe${CSI}?2026l`);
  assert.equal(em.version, v0 + 1);
});

test('changes before the frame starts are shown at once', () => {
  const { em } = make(10, 3, { now: () => 0 });
  const v0 = em.version;
  em.write(`before${CSI}?2026hinside`);
  assert.equal(em.version, v0 + 1);
  em.write(`${CSI}?2026l`);
  assert.equal(em.version, v0 + 2);
});

test('synchronized output safety net after the timeout (injectable clock)', () => {
  let now = 1000;
  const { em } = make(10, 3, { now: () => now });
  const v0 = em.version;
  em.write(`${CSI}?2026hx`);
  now = 1900;
  assert.equal(em.version, v0);
  now = 2001;
  // Reading version with the clock past the limit releases the frame, without another write.
  assert.equal(em.version, v0 + 1);
  assert.equal(em.version, v0 + 1);
  // The program still holds the mode: the next changes wait for another timeout.
  em.write('y');
  assert.equal(em.version, v0 + 1);
  now = 3100;
  em.write('z');
  assert.equal(em.version, v0 + 2);
  em.write(`${CSI}?2026l`);
  assert.equal(em.version, v0 + 3);
});

test('synchronized output with a custom timeout', () => {
  let now = 0;
  const { em } = make(10, 3, { now: () => now, syncTimeoutMs: 50 });
  const v0 = em.version;
  em.write(`${CSI}?2026hx`);
  now = 51;
  assert.equal(em.version, v0 + 1);
});

test('DECRQM reports 2026 while it is set', () => {
  const { em, replies } = make();
  em.write(`${CSI}?2026h${CSI}?2026$p${CSI}?2026l${CSI}?2026$p`);
  assert.deepEqual(replies, [`${CSI}?2026;1$y`, `${CSI}?2026;2$y`]);
});

test('RIS ends synchronized output', () => {
  const { em } = make(10, 3, { now: () => 0 });
  const v0 = em.version;
  em.write(`${CSI}?2026hx`);
  em.write(`${ESC}c`);
  assert.ok(em.version > v0);
  em.write('y');
  assert.ok(em.version > v0 + 1);
});
