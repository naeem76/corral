import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PARAMS, MAX_PARAM_VALUE, MAX_STRING, Parser } from '../../src/term/parser.ts';
import type { ParserHandler } from '../../src/term/parser.ts';

type Ev = (string | number | number[])[];

function recorder(): { events: Ev[]; parser: Parser } {
  const events: Ev[] = [];
  const h: ParserHandler = {
    print: (d, s, e) => {
      const last = events[events.length - 1];
      if (last && last[0] === 'print') last[1] += d.slice(s, e);
      else events.push(['print', d.slice(s, e)]);
    },
    execute: (c) => events.push(['exec', c]),
    csi: (p, subs, n, prefix, inter, final) =>
      events.push(['csi', String.fromCharCode(prefix || 0x20) + (inter ? String.fromCharCode(inter) : '') + String.fromCharCode(final), Array.from(p.subarray(0, n)), Array.from(subs.subarray(0, n))]),
    esc: (inter, final) => events.push(['esc', (inter ? String.fromCharCode(inter) : '') + String.fromCharCode(final)]),
    osc: (d) => events.push(['osc', d]),
    dcs: (p, n, prefix, inter, final, d) =>
      events.push(['dcs', String.fromCharCode(prefix || 0x20) + (inter ? String.fromCharCode(inter) : '') + String.fromCharCode(final), Array.from(p.subarray(0, n)), d]),
  };
  return { events, parser: new Parser(h) };
}

function parse(...chunks: string[]): Ev[] {
  const { events, parser } = recorder();
  for (const c of chunks) parser.write(c);
  return events;
}

test('text and C0 controls', () => {
  assert.deepEqual(parse('ab\r\ncd'), [['print', 'ab'], ['exec', 13], ['exec', 10], ['print', 'cd']]);
});

test('CSI parameters, empty parameters and private prefix', () => {
  assert.deepEqual(parse('\x1b[1;22H'), [['csi', ' H', [1, 22], [0, 0]]]);
  assert.deepEqual(parse('\x1b[;5H'), [['csi', ' H', [-1, 5], [0, 0]]]);
  assert.deepEqual(parse('\x1b[m'), [['csi', ' m', [-1], [0]]]);
  assert.deepEqual(parse('\x1b[?1049h'), [['csi', '?h', [1049], [0]]]);
  assert.deepEqual(parse('\x1b[?2026$p'), [['csi', '?$p', [2026], [0]]]);
  assert.deepEqual(parse('\x1b[2 q'), [['csi', '  q', [2], [0]]]);
});

test('colon sub-parameters are marked', () => {
  assert.deepEqual(parse('\x1b[38:2::1:2:3m'), [['csi', ' m', [38, 2, -1, 1, 2, 3], [0, 1, 1, 1, 1, 1]]]);
  assert.deepEqual(parse('\x1b[4:3;1m'), [['csi', ' m', [4, 3, 1], [0, 1, 0]]]);
});

test('sequence split at every position gives the same events', () => {
  const sample = 'x\x1b[38;2;1;2;3mA\x1b]0;title\x07B\x1bP+q544e\x1b\\C\x1b_Gq\x1b\\D\x1b(0q\x1b(BE';
  const whole = parse(sample);
  for (let i = 0; i <= sample.length; i++) {
    for (let j = i; j <= sample.length; j++) {
      assert.deepEqual(parse(sample.slice(0, i), sample.slice(i, j), sample.slice(j)), whole, `split ${i},${j}`);
    }
  }
});

test('OSC ends with BEL or ST; ESC dispatch of ST is visible but harmless', () => {
  assert.deepEqual(parse('\x1b]2;hi\x07'), [['osc', '2;hi']]);
  assert.deepEqual(parse('\x1b]2;hi\x1b\\'), [['osc', '2;hi'], ['esc', '\\']]);
});

test('CAN and SUB cancel a sequence; ESC restarts it', () => {
  assert.deepEqual(parse('\x1b[3\x18m'), [['print', 'm']]);
  assert.deepEqual(parse('\x1b[3\x1am'), [['print', 'm']]);
  assert.deepEqual(parse('\x1b]0;abc\x18x'), [['print', 'x']]);
  assert.deepEqual(parse('\x1b[3\x1b[4m'), [['csi', ' m', [4], [0]]]);
});

test('C0 inside CSI executes without breaking the sequence', () => {
  assert.deepEqual(parse('\x1b[1\r;2H'), [['exec', 13], ['csi', ' H', [1, 2], [0, 0]]]);
});

test('ESC intermediates and DCS', () => {
  assert.deepEqual(parse('\x1b(0\x1b#8\x1b7'), [['esc', '(0'], ['esc', '#8'], ['esc', '7']]);
  assert.deepEqual(parse('\x1bP+q544e\x1b\\'), [['dcs', ' +q', [-1], '544e'], ['esc', '\\']]);
  assert.deepEqual(parse('\x1bP$qm\x1b\\'), [['dcs', ' $q', [-1], 'm'], ['esc', '\\']]);
});

test('APC, PM and SOS strings are swallowed', () => {
  assert.deepEqual(parse('a\x1b_Gi=1,a=q;AAAA\x1b\\b\x1b^pm\x1b\\c\x1bXsos\x1b\\d'), [
    ['print', 'a'],
    ['esc', '\\'],
    ['print', 'b'],
    ['esc', '\\'],
    ['print', 'c'],
    ['esc', '\\'],
    ['print', 'd'],
  ]);
});

test('invalid characters in CSI go to ignore state until the final byte', () => {
  assert.deepEqual(parse('\x1b[1?2hX'), [['print', 'X']]);
  assert.deepEqual(parse('\x1b[1$1pX'), [['print', 'X']]);
});

test('non-ASCII text inside an escape sequence aborts it and is printed', () => {
  assert.deepEqual(parse('\x1b[1é'), [['print', 'é']]);
});

test('parameter count and values are bounded', () => {
  const many = '\x1b[' + Array.from({ length: 100000 }, (_, i) => String(i % 10)).join(';') + 'm';
  const ev = parse(many);
  assert.equal(ev.length, 1);
  assert.equal((ev[0]![2] as number[]).length, MAX_PARAMS);
  const big = parse('\x1b[99999999999999999999999A');
  assert.deepEqual(big, [['csi', ' A', [MAX_PARAM_VALUE], [0]]]);
});

test('an overlong OSC string is dropped, and parsing continues after it', () => {
  const long = '\x1b]0;' + 'x'.repeat(MAX_STRING + 10) + '\x07after';
  assert.deepEqual(parse(long), [['print', 'after']]);
  // Also when it arrives in many chunks.
  const { events, parser } = recorder();
  parser.write('\x1b]52;c;');
  for (let i = 0; i < 200; i++) parser.write('A'.repeat(1000));
  parser.write('\x1b\\ok');
  assert.deepEqual(events, [['esc', '\\'], ['print', 'ok']]);
});

test('DEL and C1 code points are ignored in ground', () => {
  assert.deepEqual(parse('a\x7fb\x9bc'), [['print', 'abc']]);
});
