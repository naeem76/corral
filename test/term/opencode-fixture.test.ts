// Replays output recorded from the real OpenCode TUI (see fixtures/record-opencode.ts) and checks
// the final screen against the OpenCode home screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLOR_RGB } from '../../src/types.ts';
import type { Cell, Emulator } from '../../src/types.ts';
import { createEmulator, screenToText } from '../../src/term/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function load(name: string): string[] {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as string[];
}

const FIRST = load('opencode-100x30.json');
const SECOND = load('opencode-80x24.json');

const LOGO = [
  '█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█',
  '█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀',
  '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
];

function replay(chunks: string[], em = createEmulator(100, 30)): Emulator {
  for (const c of chunks) em.write(c);
  return em;
}

function checkHomeScreen(em: Emulator): void {
  const screen = screenToText(em);
  const lines = screen.split('\n');
  assert.equal(lines.length, em.rows);

  // No escape-sequence garbage in the grid.
  assert.doesNotMatch(screen, /\x1b/);
  assert.doesNotMatch(screen, /[\x00-\x08\x0b-\x1f\x7f]/);
  for (const bad of ['[?', '$y', 'rgb:', '$p', ';1R', '62;22', 'corral', '\\', 'opentui', 'i=31337', 'w=1;']) {
    assert.ok(!screen.includes(bad), `grid contains ${JSON.stringify(bad)}`);
  }

  // The logo: three rows in order, horizontally centered.
  const logoRow = lines.findIndex((l) => l.includes(LOGO[0]!));
  assert.ok(logoRow > 0, 'logo present');
  const left = Math.ceil((em.cols - LOGO[0]!.length) / 2);
  for (let k = 0; k < 3; k++) assert.equal(lines[logoRow + k], ' '.repeat(left) + LOGO[k], `logo row ${k}`);
  assert.match(lines[logoRow - 1]!, /^ +▄$/);

  // Prompt box below the logo with the placeholder, the agent line and the bottom edge.
  const prompt = lines.findIndex((l) => l.includes('Ask anything'));
  assert.ok(prompt > logoRow + 2, 'prompt below the logo');
  assert.match(lines[prompt]!, /^ +┃  Ask anything… /);
  assert.match(lines[prompt - 1]!, /^ +┃$/);
  assert.match(lines[prompt + 2]!, /^ +┃  Build · /);
  assert.match(lines[prompt + 3]!, /^ +╹▀{40,}$/);
  const bar = lines[prompt]!.indexOf('┃');
  for (const d of [-1, 0, 1, 2]) assert.equal(lines[prompt + d]!.indexOf('┃'), bar, 'left bar aligned');
  assert.equal(lines[prompt + 3]!.indexOf('╹'), bar);
  // Hints under the box: directory on the left, commands on the right.
  assert.match(lines[prompt + 4]!, /^ +\/tmp\/ne-fixture +shift\+tab agents  ctrl\+p commands$/);
  assert.equal(lines[prompt + 4]!.indexOf('/tmp'), bar);
  assert.ok(lines[prompt + 3]!.length >= lines[prompt + 4]!.length - 1, 'hint row ends under the box edge');

  // Footer status line: second to last row, version at the right edge with a margin of 2.
  const footer = lines[em.rows - 2]!;
  assert.match(footer, /^  ⊙ \d+ MCP \/mcps/);
  assert.ok(footer.endsWith('2.3.2'), footer);
  assert.equal(footer.length, em.cols - 2);
  assert.equal(lines[em.rows - 1], '');

  // Cursor visible, inside the grid, on the first character of the placeholder.
  assert.ok(em.cursor.x >= 0 && em.cursor.x < em.cols && em.cursor.y >= 0 && em.cursor.y < em.rows);
  assert.equal(em.cursor.visible, true);
  assert.equal(em.cursor.y, prompt);
  assert.equal(em.cursor.x, lines[prompt]!.indexOf('Ask'));

  // OpenCode paints every cell with a truecolor background.
  const cell: Cell = { ch: '', width: 1, fg: 0, bg: 0, attrs: 0 };
  for (let y = 0; y < em.rows; y++) {
    for (let x = 0; x < em.cols; x++) {
      em.readCell(x, y, cell);
      assert.ok((cell.bg & COLOR_RGB) !== 0, `cell ${x},${y} has no RGB background`);
    }
  }
  em.readCell(0, 0, cell);
  const pageBg = cell.bg;
  em.readCell(em.cursor.x, em.cursor.y, cell);
  assert.notEqual(cell.bg, pageBg, 'the prompt box has its own background');

  // Modes OpenCode switches on.
  assert.deepEqual({ ...em.modes }, {
    altScreen: true,
    appCursorKeys: false,
    appKeypad: false,
    bracketedPaste: true,
    focusEvents: true,
    mouse: 'any',
    mouseSgr: true,
  });
  assert.equal(em.title, 'OpenCode');
}

test('OpenCode home screen at 100x30', () => {
  const em = replay(FIRST);
  checkHomeScreen(em);
  // The plugin-error toast in the top right corner of this recording.
  const lines = screenToText(em).split('\n');
  const toast = lines.findIndex((l) => l.includes('Plugin failed'));
  assert.ok(toast >= 0 && toast < 5);
  assert.match(lines[toast]!, /┃  Plugin failed: .* › Open plugins  ┃$/);
  assert.equal(lines[toast]!.length, 98);
});

test('OpenCode home screen after a resize to 80x24', () => {
  const em = replay(FIRST);
  em.resize(80, 24);
  replay(SECOND, em);
  assert.equal(em.cols, 80);
  checkHomeScreen(em);
  assert.ok(!screenToText(em).includes('Plugin failed'), 'the toast is gone');
});

test('OpenCode replay is the same when split into small pieces', () => {
  const whole = screenToText(replay(FIRST));
  const em = createEmulator(100, 30);
  for (const c of FIRST) for (let i = 0; i < c.length; i += 3) em.write(c.slice(i, i + 3));
  assert.equal(screenToText(em), whole);
});

test('OpenCode replay sends the expected replies', () => {
  const em = createEmulator(100, 30);
  const replies: string[] = [];
  em.onReply = (d) => replies.push(d);
  replay(FIRST, em);
  const unique = [...new Set(replies)];
  for (const r of [
    '\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\',
    '\x1b]11;rgb:1010/1010/1010\x1b\\',
    '\x1bP>|corral\x1b\\',
    '\x1b[1;1R',
    '\x1bP0+r\x1b\\',
    '\x1b[?2026;2$y',
    '\x1b[?2027;2$y',
    '\x1b[?62;22c',
    '\x1b[4;480;800t',
  ]) {
    assert.ok(unique.includes(r), `reply ${JSON.stringify(r)}`);
  }
});
