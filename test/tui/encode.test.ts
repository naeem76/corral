import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputDecoder, encodeFocusForPty, encodeKeyForPty, encodeMouseForPty, encodePasteForPty } from '../../src/tui/input.ts';
import type { KeyEvent, MouseEvent } from '../../src/tui/input.ts';
import type { MouseTracking, TermModes } from '../../src/types.ts';

function modes(over: Partial<TermModes> = {}): TermModes {
  return {
    altScreen: false, appCursorKeys: false, appKeypad: false, bracketedPaste: false,
    focusEvents: false, mouse: 'none', mouseSgr: false, ...over,
  };
}

function mouse(action: MouseEvent['action'], button: MouseEvent['button'], x = 15, y = 8, mods: Partial<MouseEvent> = {}): MouseEvent {
  return { type: 'mouse', x, y, button, action, ctrl: false, alt: false, shift: false, raw: '', ...mods };
}

const ALL: MouseEvent[] = [
  mouse('down', 'left'), mouse('up', 'left'), mouse('move', 'left'), mouse('move', 'none'),
  mouse('wheel-up', 'none'), mouse('wheel-down', 'none'), mouse('down', 'right'), mouse('down', 'middle'),
];

test('mouse: mode none never reports', () => {
  for (const ev of ALL) assert.equal(encodeMouseForPty(ev, 10, 5, modes({ mouse: 'none', mouseSgr: true })), null);
});

test('mouse: SGR coordinates shift into the pane and are 1-based', () => {
  const m = modes({ mouse: 'any', mouseSgr: true });
  assert.equal(encodeMouseForPty(mouse('down', 'left'), 10, 5, m), '\x1b[<0;6;4M');
  assert.equal(encodeMouseForPty(mouse('up', 'left'), 10, 5, m), '\x1b[<0;6;4m');
  assert.equal(encodeMouseForPty(mouse('down', 'right'), 10, 5, m), '\x1b[<2;6;4M');
  assert.equal(encodeMouseForPty(mouse('down', 'middle'), 10, 5, m), '\x1b[<1;6;4M');
  assert.equal(encodeMouseForPty(mouse('move', 'left'), 10, 5, m), '\x1b[<32;6;4M');
  assert.equal(encodeMouseForPty(mouse('move', 'none'), 10, 5, m), '\x1b[<35;6;4M');
  assert.equal(encodeMouseForPty(mouse('wheel-up', 'none'), 10, 5, m), '\x1b[<64;6;4M');
  assert.equal(encodeMouseForPty(mouse('wheel-down', 'none'), 10, 5, m), '\x1b[<65;6;4M');
  assert.equal(encodeMouseForPty(mouse('down', 'left', 15, 8, { ctrl: true, shift: true, alt: true }), 10, 5, m), '\x1b[<28;6;4M');
});

test('mouse: events left of or above the pane are not sent', () => {
  const m = modes({ mouse: 'any', mouseSgr: true });
  assert.equal(encodeMouseForPty(mouse('down', 'left', 3, 8), 10, 5, m), null);
  assert.equal(encodeMouseForPty(mouse('down', 'left', 15, 2), 10, 5, m), null);
});

test('mouse: motion filtering per tracking mode', () => {
  const sent = (mode: MouseTracking, ev: MouseEvent): boolean => encodeMouseForPty(ev, 0, 0, modes({ mouse: mode, mouseSgr: true })) !== null;
  for (const mode of ['x10', 'button', 'drag', 'any'] as const) {
    assert.equal(sent(mode, mouse('down', 'left')), true, mode);
    assert.equal(sent(mode, mouse('wheel-up', 'none')), true, mode);
  }
  assert.equal(sent('x10', mouse('up', 'left')), false);
  assert.equal(sent('button', mouse('up', 'left')), true);
  assert.equal(sent('button', mouse('move', 'left')), false);
  assert.equal(sent('button', mouse('move', 'none')), false);
  assert.equal(sent('drag', mouse('move', 'left')), true);
  assert.equal(sent('drag', mouse('move', 'none')), false);
  assert.equal(sent('any', mouse('move', 'left')), true);
  assert.equal(sent('any', mouse('move', 'none')), true);
});

test('mouse: legacy encoding, release without button, coordinate limit', () => {
  const m = modes({ mouse: 'button', mouseSgr: false });
  assert.equal(encodeMouseForPty(mouse('down', 'left', 15, 8), 10, 5, m), '\x1b[M &$');
  assert.equal(encodeMouseForPty(mouse('up', 'left', 15, 8), 10, 5, m), '\x1b[M#&$');
  assert.equal(encodeMouseForPty(mouse('down', 'left', 400, 8), 0, 0, m), null);
  // x10 mode carries no modifiers.
  const x10 = modes({ mouse: 'x10' });
  assert.equal(encodeMouseForPty(mouse('down', 'left', 0, 0, { ctrl: true }), 0, 0, x10), '\x1b[M !!');
});

test('mouse: encoded events decode back to the same event', () => {
  const m = modes({ mouse: 'any', mouseSgr: true });
  for (const ev of ALL) {
    const enc = encodeMouseForPty(ev, 0, 0, m)!;
    const [back] = createInputDecoder().feed(enc);
    assert.equal(back?.type, 'mouse');
    const b = back as MouseEvent;
    assert.deepEqual([b.x, b.y, b.button, b.action], [ev.x, ev.y, ev.button, ev.action]);
  }
});

test('paste: plain or bracketed', () => {
  assert.equal(encodePasteForPty('abc', modes()), 'abc');
  assert.equal(encodePasteForPty('abc', modes({ bracketedPaste: true })), '\x1b[200~abc\x1b[201~');
});

test('paste: end marker inside the text cannot break out', () => {
  const evil = 'safe\x1b[201~rm -rf ~\r';
  const out = encodePasteForPty(evil, modes({ bracketedPaste: true }));
  assert.equal(out, '\x1b[200~saferm -rf ~\r\x1b[201~');
  assert.equal(out.indexOf('\x1b[201~'), out.length - 6);
  // Nested markers that would form a new marker after one removal.
  const nested = encodePasteForPty('a\x1b[20\x1b[201~1~b', modes({ bracketedPaste: true }));
  assert.equal(nested.split('\x1b[201~').length, 2);
  assert.equal(encodePasteForPty('x\x1b[200~y', modes()), 'xy');
});

test('focus', () => {
  assert.equal(encodeFocusForPty(true, modes()), null);
  assert.equal(encodeFocusForPty(true, modes({ focusEvents: true })), '\x1b[I');
  assert.equal(encodeFocusForPty(false, modes({ focusEvents: true })), '\x1b[O');
});

function key(k: string, m: Partial<KeyEvent> = {}): KeyEvent {
  return { type: 'key', key: k, ctrl: false, alt: false, shift: false, raw: '', ...m };
}

test('keys: cursor keys follow application cursor mode', () => {
  assert.equal(encodeKeyForPty(key('up'), modes()), '\x1b[A');
  assert.equal(encodeKeyForPty(key('up'), modes({ appCursorKeys: true })), '\x1bOA');
  assert.equal(encodeKeyForPty(key('up', { ctrl: true }), modes({ appCursorKeys: true })), '\x1b[1;5A');
  assert.equal(encodeKeyForPty(key('home'), modes()), '\x1b[H');
  assert.equal(encodeKeyForPty(key('delete', { shift: true }), modes()), '\x1b[3;2~');
  assert.equal(encodeKeyForPty(key('f1'), modes()), '\x1bOP');
  assert.equal(encodeKeyForPty(key('f12'), modes()), '\x1b[24~');
});

test('keys: control, alt and plain keys', () => {
  assert.equal(encodeKeyForPty(key('a', { ctrl: true }), modes()), '\x01');
  assert.equal(encodeKeyForPty(key('a', { alt: true }), modes()), '\x1ba');
  assert.equal(encodeKeyForPty(key('enter'), modes()), '\r');
  assert.equal(encodeKeyForPty(key('tab', { shift: true }), modes()), '\x1b[Z');
  assert.equal(encodeKeyForPty(key('backspace'), modes()), '\x7f');
  assert.equal(encodeKeyForPty(key('space', { ctrl: true }), modes()), '\x00');
  assert.equal(encodeKeyForPty(key('宽'), modes()), '宽');
  assert.equal(encodeKeyForPty(key('escape'), modes()), '\x1b');
});

test('keys: decode then encode returns xterm bytes', () => {
  const inputs = ['a', '\x01', '\x1b[A', '\x1b[1;5C', '\x1b[3~', '\x1bx', '\r', '\x7f', '\x1b[Z', '\x1b[15~'];
  for (const s of inputs) {
    const evs = createInputDecoder().feed(s);
    assert.equal(evs.length, 1, s);
    assert.equal(encodeKeyForPty(evs[0] as KeyEvent, modes()), s, JSON.stringify(s));
  }
  // kitty and win32-input-mode reports become plain xterm bytes.
  const [kitty] = createInputDecoder().feed('\x1b[97;5u');
  assert.equal(encodeKeyForPty(kitty as KeyEvent, modes()), '\x01');
});
