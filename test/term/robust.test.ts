import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { make, snapshot, text } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

// A mixed sample that touches most code paths: SGR (both forms), wide and combining text, ZWJ
// emoji, DEC graphics, scroll regions, alt screen, OSC/DCS/APC strings, replies and wrap.
const SAMPLE = [
  'plain \x1b[1;31mred\x1b[0m \x1b[38:2::10:20:30mrgb\x1b[m\r\n',
  '日本語 é \u{1F468}‍\u{1F469}‍\u{1F467} ❤️ \u{1F1FA}\u{1F1F8}\r\n',
  '\x1b(0lqqk\x1b(B \x1b)0\x0exqx\x0f\r\n',
  '\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1bP+q544e\x1b\\\x1b_Gq=1\x1b\\',
  '\x1b[2;5r\x1b[5;1H\nscrolled\x1b[2;1H\x1bMrev\x1b[r',
  '\x1b[?1049h\x1b[?2026h\x1b[H\x1b[48;5;17m\x1b[2Jalt \x1b[38;2;1;2;3mscreen\x1b[?2026l',
  '\x1b[3;3H\x1b[4h<ins>\x1b[4l\x1b[2P\x1b[3@\x1b[2X\x1b[1K\x1b[6n\x1b[c\x1b[?2026$p',
  'long line that wraps across the right edge of the small grid 0123456789\r\n',
  '\x1b[?1049l\x1b[10;1Hback\x1b7\x1b[1;1H\x1b8!\x1b[3b\t|\x1b[2I|\x1b[Z|',
  '\x1b[58:2::1:2:3m\x1b[4:3munder\x1b[24m \x1b[38;5;196m\u{1F44D}\u{1F3FD}\x1b[0m end',
].join('');

function finalState(chunks: string[]): string {
  const { em } = make(24, 12, { now: () => 0 });
  for (const c of chunks) em.write(c);
  return snapshot(em);
}

test('write split at every position gives the same final grid', () => {
  const whole = finalState([SAMPLE]);
  for (let i = 0; i <= SAMPLE.length; i++) {
    assert.equal(finalState([SAMPLE.slice(0, i), SAMPLE.slice(i)]), whole, `split at ${i}`);
  }
});

test('write in random small chunks gives the same final grid', () => {
  const whole = finalState([SAMPLE]);
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    const chunks: string[] = [];
    for (let i = 0; i < SAMPLE.length; ) {
      const n = 1 + rand(7);
      chunks.push(SAMPLE.slice(i, i + n));
      i += n;
    }
    assert.equal(finalState(chunks), whole, `round ${round}`);
  }
});

test('one code unit at a time gives the same final grid', () => {
  assert.equal(finalState([...SAMPLE.split('')]), finalState([SAMPLE]));
});

test('replies are the same regardless of split', () => {
  const whole = make(24, 12);
  whole.em.write(SAMPLE);
  const split = make(24, 12);
  for (const ch of SAMPLE.split('')) split.em.write(ch);
  assert.deepEqual(split.replies, whole.replies);
  assert.ok(whole.replies.length >= 4);
});

test('hostile input does not throw and memory stays bounded', () => {
  const { em } = make(80, 24);
  const before = process.memoryUsage().heapUsed;
  // Long OSC without a terminator, then text.
  em.write('\x1b]0;');
  for (let i = 0; i < 100; i++) em.write('A'.repeat(100000));
  em.write('\x07ok');
  assert.equal(em.title, '');
  assert.match(text(em), /ok/);
  // Long DCS and APC.
  em.write('\x1bP+q' + 'B'.repeat(2_000_000) + '\x1b\\');
  em.write('\x1b_G' + 'C'.repeat(2_000_000) + '\x1b\\');
  // Huge parameter values and very many parameters.
  em.write('\x1b[999999999999999999999;999999999999999999999H');
  assert.deepEqual([em.cursor.x, em.cursor.y], [79, 23]);
  em.write('\x1b[' + '1;'.repeat(100000) + 'm');
  em.write('\x1b[' + '9'.repeat(100000) + 'b');
  em.write('\x1b[99999@\x1b[99999P\x1b[99999L\x1b[99999M\x1b[99999S\x1b[99999T\x1b[99999X\x1b[99999I\x1b[99999Z');
  // Many intermediates, many distinct clusters (the cluster table is compacted).
  em.write('\x1b[1!!!!!!!!!!p');
  for (let i = 0; i < 30000; i++) em.write('á' + String.fromCodePoint(0x300 + (i % 100)) + String.fromCodePoint(0x4e00 + (i % 5000)) + '̀'.repeat(i % 3));
  em.write('e' + '́'.repeat(100000));
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 200 * 1024 * 1024, `heap grew by ${grown}`);
  // Still works afterwards.
  em.write('\x1b[H\x1b[2Jfine');
  assert.equal(text(em), 'fine');
});

test('replay of 5 MB of mixed output is fast', () => {
  const fixture = (JSON.parse(readFileSync(join(FIXTURES, 'opencode-100x30.json'), 'utf8')) as string[]).join('');
  const shell = Array.from({ length: 200 }, (_, i) => `line ${i} \x1b[32mok\x1b[0m some text 日本 ${'x'.repeat(i % 60)}\r\n`).join('');
  const block = SAMPLE + fixture + shell;
  const parts: string[] = [];
  let size = 0;
  while (size < 5 * 1024 * 1024) {
    parts.push(block);
    size += block.length;
  }
  // Feed in chunks of about 4 KB, like a PTY would.
  const all = parts.join('');
  const chunks: string[] = [];
  for (let i = 0; i < all.length; i += 4096) chunks.push(all.slice(i, i + 4096));
  const { em } = make(100, 30, { now: () => 0 });
  const t0 = performance.now();
  for (const c of chunks) em.write(c);
  const ms = performance.now() - t0;
  console.log(`replay ${(all.length / 1024 / 1024).toFixed(2)} MB (code units) in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `took ${ms} ms`);
});
