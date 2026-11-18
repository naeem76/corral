import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputDecoder } from '../../src/tui/input.ts';
import type { InputEvent } from '../../src/types.ts';

type K = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean };

function k(key: string, mods: Partial<K> = {}): Partial<InputEvent> {
  return { type: 'key', key, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false };
}

/** Decode in one chunk, then flush. */
function decode(input: string): InputEvent[] {
  const d = createInputDecoder();
  return [...d.feed(input), ...d.flush()];
}

/** Compare events ignoring `raw` unless the expectation has it. */
function same(actual: InputEvent[], expected: Partial<InputEvent>[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: count ${JSON.stringify(actual)}`);
  actual.forEach((ev, i) => {
    const exp = expected[i]!;
    for (const [field, value] of Object.entries(exp)) {
      assert.deepEqual((ev as Record<string, unknown>)[field], value, `${label}: event ${i} field ${field} in ${JSON.stringify(ev)}`);
    }
  });
}

const TABLE: [string, string, Partial<InputEvent>[]][] = [
  ['letter', 'a', [k('a')]],
  ['upper letter', 'A', [k('A')]],
  ['text', 'hi!', [k('h'), k('i'), k('!')]],
  ['grapheme é combined', 'é', [k('é')]],
  ['emoji zwj', '👩‍💻', [k('👩‍💻')]],
  ['cjk', '宽', [k('宽')]],
  ['enter CR', '\r', [k('enter')]],
  ['enter LF', '\n', [k('enter')]],
  ['tab', '\t', [k('tab')]],
  ['shift tab', '\x1b[Z', [k('tab', { shift: true })]],
  ['backspace DEL', '\x7f', [k('backspace')]],
  ['backspace BS', '\x08', [k('backspace', { ctrl: true })]],
  ['space', ' ', [k('space')]],
  ['ctrl+a', '\x01', [k('a', { ctrl: true })]],
  ['ctrl+z', '\x1a', [k('z', { ctrl: true })]],
  ['ctrl+space', '\x00', [k('space', { ctrl: true })]],
  ['ctrl+backslash', '\x1c', [k('\\', { ctrl: true })]],
  ['ctrl+]', '\x1d', [k(']', { ctrl: true })]],
  ['ctrl+^', '\x1e', [k('^', { ctrl: true })]],
  ['ctrl+_', '\x1f', [k('_', { ctrl: true })]],
  ['alt+a', '\x1ba', [k('a', { alt: true })]],
  ['alt+A', '\x1bA', [k('A', { alt: true })]],
  ['alt+ctrl+a', '\x1b\x01', [k('a', { alt: true, ctrl: true })]],
  ['alt+backspace', '\x1b\x7f', [k('backspace', { alt: true })]],
  ['alt+enter', '\x1b\r', [k('enter', { alt: true })]],
  ['alt+space', '\x1b ', [k('space', { alt: true })]],
  ['alt+P', '\x1bPx', [k('P', { alt: true }), k('x')]],
  ['up CSI', '\x1b[A', [k('up')]],
  ['down CSI', '\x1b[B', [k('down')]],
  ['right CSI', '\x1b[C', [k('right')]],
  ['left CSI', '\x1b[D', [k('left')]],
  ['home CSI', '\x1b[H', [k('home')]],
  ['end CSI', '\x1b[F', [k('end')]],
  ['up SS3', '\x1bOA', [k('up')]],
  ['home SS3', '\x1bOH', [k('home')]],
  ['f1 SS3', '\x1bOP', [k('f1')]],
  ['f4 SS3', '\x1bOS', [k('f4')]],
  ['keypad enter SS3', '\x1bOM', [k('enter')]],
  ['ctrl+up', '\x1b[1;5A', [k('up', { ctrl: true })]],
  ['shift+right', '\x1b[1;2C', [k('right', { shift: true })]],
  ['alt+left', '\x1b[1;3D', [k('left', { alt: true })]],
  ['ctrl+shift+end', '\x1b[1;6F', [k('end', { ctrl: true, shift: true })]],
  ['alt via ESC ESC [', '\x1b\x1b[A', [k('up', { alt: true })]],
  ['home ~1', '\x1b[1~', [k('home')]],
  ['insert', '\x1b[2~', [k('insert')]],
  ['delete', '\x1b[3~', [k('delete')]],
  ['shift+delete', '\x1b[3;2~', [k('delete', { shift: true })]],
  ['end ~4', '\x1b[4~', [k('end')]],
  ['pageup', '\x1b[5~', [k('pageup')]],
  ['pagedown', '\x1b[6~', [k('pagedown')]],
  ['ctrl+pagedown', '\x1b[6;5~', [k('pagedown', { ctrl: true })]],
  ['home ~7 rxvt', '\x1b[7~', [k('home')]],
  ['end ~8 rxvt', '\x1b[8~', [k('end')]],
  ['f1 ~11', '\x1b[11~', [k('f1')]],
  ['f5', '\x1b[15~', [k('f5')]],
  ['f6', '\x1b[17~', [k('f6')]],
  ['f10', '\x1b[21~', [k('f10')]],
  ['f11', '\x1b[23~', [k('f11')]],
  ['f12', '\x1b[24~', [k('f12')]],
  ['ctrl+f5', '\x1b[15;5~', [k('f5', { ctrl: true })]],
  ['ctrl+f1 CSI P', '\x1b[1;5P', [k('f1', { ctrl: true })]],
  ['ctrl+f3 CSI R', '\x1b[1;5R', [k('f3', { ctrl: true })]],
  ['shift+f2 SS3 mod', '\x1bO2Q', [k('f2', { shift: true })]],
  ['kitty a', '\x1b[97u', [k('a')]],
  ['kitty ctrl+a', '\x1b[97;5u', [k('a', { ctrl: true })]],
  ['kitty shift+a', '\x1b[97;2u', [k('A', { shift: true })]],
  ['kitty enter', '\x1b[13u', [k('enter')]],
  ['kitty esc', '\x1b[27u', [k('escape')]],
  ['kitty alt+backspace', '\x1b[127;3u', [k('backspace', { alt: true })]],
  ['kitty release dropped', '\x1b[97;1:3u', []],
  ['kitty text field', '\x1b[97;2;65u', [k('A', { shift: true })]],
  ['modifyOtherKeys ctrl+enter', '\x1b[27;5;13~', [k('enter', { ctrl: true })]],
  ['modifyOtherKeys ctrl+shift+a', '\x1b[27;6;65~', [k('a', { ctrl: true, shift: true })]],
  ['win32 input mode a down', '\x1b[65;30;97;1;0;1_', [k('a')]],
  ['win32 input mode up dropped', '\x1b[65;30;97;0;0;1_', []],
  ['win32 input mode ctrl+left', '\x1b[37;75;0;1;8;1_', [k('left', { ctrl: true })]],
  ['focus in', '\x1b[I', [{ type: 'focus', focused: true }]],
  ['focus out', '\x1b[O', [{ type: 'focus', focused: false }]],
  ['paste', '\x1b[200~hello\r\nworld\x1b[201~', [{ type: 'paste', text: 'hello\r\nworld' }]],
  ['paste with escapes inside', '\x1b[200~a\x1b[Ab\x1b[201~x', [{ type: 'paste', text: 'a\x1b[Ab' }, k('x')]],
  ['empty paste', '\x1b[200~\x1b[201~', [{ type: 'paste', text: '' }]],
  // Terminal replies: never keys.
  ['cursor position report', '\x1b[12;40R', []],
  ['device attributes', '\x1b[?62;22c', []],
  ['secondary DA', '\x1b[>1;10;0c', []],
  ['DECRPM', '\x1b[?2026;2$y', []],
  ['kitty flags reply', '\x1b[?0u', []],
  ['OSC 11 reply BEL', '\x1b]11;rgb:0000/0000/0000\x07', []],
  ['OSC 10 reply ST', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', []],
  ['XTVERSION', '\x1bP>|WindowsTerminal 1.21\x1b\\', []],
  ['DECRQSS', '\x1bP1$r0m\x1b\\', []],
  ['kitty graphics APC', '\x1b_Gi=1;OK\x1b\\', []],
  ['DSR ok', '\x1b[0n', []],
  ['unknown CSI', '\x1b[99X', []],
  ['reply between keys', 'a\x1b[1;1R\x1b[?1;2cb', [k('a'), k('b')]],
  // Mouse.
  ['sgr left down', '\x1b[<0;10;5M', [{ type: 'mouse', x: 9, y: 4, button: 'left', action: 'down', ctrl: false, alt: false, shift: false }]],
  ['sgr left up', '\x1b[<0;10;5m', [{ type: 'mouse', x: 9, y: 4, button: 'left', action: 'up' }]],
  ['sgr right down', '\x1b[<2;1;1M', [{ type: 'mouse', x: 0, y: 0, button: 'right', action: 'down' }]],
  ['sgr middle down', '\x1b[<1;3;3M', [{ type: 'mouse', button: 'middle', action: 'down' }]],
  ['sgr drag left', '\x1b[<32;4;4M', [{ type: 'mouse', button: 'left', action: 'move' }]],
  ['sgr motion no button', '\x1b[<35;4;4M', [{ type: 'mouse', button: 'none', action: 'move' }]],
  ['sgr wheel up', '\x1b[<64;7;8M', [{ type: 'mouse', x: 6, y: 7, action: 'wheel-up', button: 'none' }]],
  ['sgr wheel down', '\x1b[<65;7;8M', [{ type: 'mouse', action: 'wheel-down' }]],
  ['sgr wheel horizontal dropped', '\x1b[<66;7;8M', []],
  ['sgr shift click', '\x1b[<4;2;2M', [{ type: 'mouse', shift: true, ctrl: false, alt: false, action: 'down' }]],
  ['sgr alt click', '\x1b[<8;2;2M', [{ type: 'mouse', alt: true }]],
  ['sgr ctrl click', '\x1b[<16;2;2M', [{ type: 'mouse', ctrl: true }]],
  ['sgr ctrl wheel', '\x1b[<80;2;2M', [{ type: 'mouse', ctrl: true, action: 'wheel-up' }]],
  ['sgr large coords', '\x1b[<0;300;120M', [{ type: 'mouse', x: 299, y: 119 }]],
  ['x10 left down', '\x1b[M *(', [{ type: 'mouse', x: 9, y: 7, button: 'left', action: 'down' }]],
  ['x10 release', '\x1b[M#*(', [{ type: 'mouse', button: 'none', action: 'up' }]],
  ['x10 wheel', '\x1b[M`!!', [{ type: 'mouse', x: 0, y: 0, action: 'wheel-up' }]],
  ['urxvt mouse', '\x1b[32;10;5M', [{ type: 'mouse', x: 9, y: 4, button: 'left', action: 'down' }]],
];

test('decoder table', () => {
  for (const [label, input, expected] of TABLE) same(decode(input), expected, label);
});

// A grapheme cluster split across chunks becomes two keys: holding back the last grapheme of
// every chunk would delay every keystroke. Terminals send a cluster in one write.
const CLUSTERS = new Set(['grapheme é combined', 'emoji zwj']);

test('every split position gives the same events', () => {
  for (const [label, input, expected] of TABLE) {
    if (CLUSTERS.has(label)) continue;
    for (let cut = 1; cut < input.length; cut++) {
      const d = createInputDecoder();
      const evs = [...d.feed(input.slice(0, cut)), ...d.feed(input.slice(cut)), ...d.flush()];
      same(evs, expected, `${label} split at ${cut}`);
    }
  }
});

test('one char at a time gives the same events', () => {
  for (const [label, input, expected] of TABLE) {
    if (CLUSTERS.has(label)) continue;
    const d = createInputDecoder();
    const evs: InputEvent[] = [];
    for (const ch of input) evs.push(...d.feed(ch));
    evs.push(...d.flush());
    same(evs, expected, `${label} char by char`);
  }
});

test('the whole table in one chunk', () => {
  // Sequences that end in a pending state (lone ESC alternatives) are excluded by design.
  const all = TABLE.map((t) => t[1]).join('');
  const expected = TABLE.flatMap((t) => t[2]);
  same(decode(all), expected, 'joined');
});

test('raw round-trips for key and mouse events', () => {
  for (const [label, input, expected] of TABLE) {
    const evs = decode(input);
    const raws = evs.filter((e) => e.type === 'key' || e.type === 'mouse').map((e) => (e as { raw: string }).raw);
    const hasOther = expected.some((e) => e.type === 'paste' || e.type === 'focus') || expected.length === 0;
    if (!hasOther && !label.includes('between')) assert.equal(raws.join(''), input, label);
  }
  const evs = decode('ab\x1b[A\x1b[<0;1;1M\x1bx\x01');
  assert.equal(evs.map((e) => (e as { raw: string }).raw).join(''), 'ab\x1b[A\x1b[<0;1;1M\x1bx\x01');
});

test('lone ESC waits, then flush emits Escape', () => {
  const d = createInputDecoder();
  assert.deepEqual(d.feed('\x1b'), []);
  assert.equal(d.pending, true);
  assert.equal(d.pendingTimeout(), 30);
  const evs = d.flush();
  same(evs, [k('escape')], 'flush');
  assert.equal(evs[0]!.type === 'key' && evs[0]!.raw, '\x1b');
  assert.equal(d.pending, false);
  assert.equal(d.pendingTimeout(), null);
});

test('ESC then a sequence in the next chunk is one key', () => {
  const d = createInputDecoder();
  d.feed('\x1b');
  same(d.feed('[A'), [k('up')], 'joined');
});

test('flush of an unfinished CSI gives Alt+[ and the rest as keys', () => {
  const d = createInputDecoder();
  assert.deepEqual(d.feed('\x1b[1;'), []);
  same(d.flush(), [k('[', { alt: true }), k('1'), k(';')], 'flushed');
});

test('two ESC presses', () => {
  const d = createInputDecoder();
  d.feed('\x1b\x1b');
  same(d.flush(), [k('escape'), k('escape')], 'esc esc');
});

test('escape timeout is configurable', () => {
  const d = createInputDecoder({ escTimeoutMs: 50 });
  d.feed('\x1b');
  assert.equal(d.pendingTimeout(), 50);
});

test('big paste across many chunks is one event, and is capped', () => {
  const body = 'x'.repeat(100_000) + '\n' + 'ü'.repeat(1000);
  const input = '\x1b[200~' + body + '\x1b[201~z';
  const d = createInputDecoder();
  const evs: InputEvent[] = [];
  for (let i = 0; i < input.length; i += 997) evs.push(...d.feed(input.slice(i, i + 997)));
  same(evs, [{ type: 'paste', text: body }, k('z')], 'big paste');

  const capped = createInputDecoder({ maxPaste: 10 });
  same([...capped.feed('\x1b[200~0123456789abcdef\x1b[201~')], [{ type: 'paste', text: '0123456789' }], 'capped');
});

test('paste end marker split at every position', () => {
  const input = '\x1b[200~abc\x1b[201~';
  for (let cut = 1; cut < input.length; cut++) {
    const d = createInputDecoder();
    const evs = [...d.feed(input.slice(0, cut)), ...d.feed(input.slice(cut))];
    same(evs, [{ type: 'paste', text: 'abc' }], `cut ${cut}`);
  }
});

test('paste in progress uses a long timeout', () => {
  const d = createInputDecoder();
  d.feed('\x1b[200~abc');
  assert.ok((d.pendingTimeout() ?? 0) >= 500);
  same(d.flush(), [{ type: 'paste', text: 'abc' }], 'flushed paste');
});

test('surrogate pair split across chunks', () => {
  const d = createInputDecoder();
  const s = '😀';
  const evs = [...d.feed(s[0]!), ...d.feed(s[1]!)];
  same(evs, [k('😀')], 'surrogates');
});

test('cursorReports option treats CSI 1;5R as a report', () => {
  const d = createInputDecoder({ cursorReports: true });
  assert.deepEqual(d.feed('\x1b[1;5R'), []);
});

test('onUnknown sees dropped sequences', () => {
  const seen: string[] = [];
  const d = createInputDecoder({ onUnknown: (s) => seen.push(s) });
  d.feed('\x1b[99X\x1b[?62c');
  assert.deepEqual(seen, ['\x1b[99X', '\x1b[?62c']);
});

test('garbage never throws and never loops', () => {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ['\x1b', '[', 'O', ']', 'P', '<', '?', ';', '0', '1', '9', 'M', 'm', 'u', '~', '\x07', '\\', 'a', '\x00', '\x7f', '\x9b', '\ud83d', 'é', '2', '0', '1', '~', 'R', '_', 'G'];
  for (let round = 0; round < 300; round++) {
    const d = createInputDecoder();
    let s = '';
    const len = Math.floor(rnd() * 60);
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const cut = Math.floor(rnd() * (s.length + 1));
    d.feed(s.slice(0, cut));
    d.feed(s.slice(cut));
    d.flush();
    assert.equal(d.pending, false, JSON.stringify(s));
  }
});

test('long unterminated OSC is dropped, not kept forever', () => {
  const d = createInputDecoder();
  d.feed('\x1b]' + 'x'.repeat(5000));
  assert.equal(d.pending, false);
  same(d.feed('a'), [k('a')], 'after');
});
