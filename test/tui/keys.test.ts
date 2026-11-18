import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBinding, matches, parseBinding } from '../../src/tui/keys.ts';
import { createInputDecoder } from '../../src/tui/input.ts';
import type { InputEvent } from '../../src/types.ts';

function ev(bytes: string): InputEvent {
  const d = createInputDecoder();
  const out = [...d.feed(bytes), ...d.flush()];
  assert.equal(out.length, 1, JSON.stringify(bytes));
  return out[0]!;
}

test('parseBinding', () => {
  assert.deepEqual(parseBinding('ctrl+n'), { key: 'n', ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseBinding('shift+tab'), { key: 'tab', ctrl: false, alt: false, shift: true });
  assert.deepEqual(parseBinding('G'), { key: 'G', ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseBinding('shift+g'), { key: 'G', ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseBinding('Esc'), { key: 'escape', ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseBinding('ctrl++'), { key: '+', ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseBinding('alt+PgDn'), { key: 'pagedown', ctrl: false, alt: true, shift: false });
  assert.throws(() => parseBinding('hyper+x'));
});

test('matches decoded events', () => {
  assert.ok(matches(ev('\x0e'), 'ctrl+n'));
  assert.ok(!matches(ev('n'), 'ctrl+n'));
  assert.ok(matches(ev('\x1b[Z'), 'shift+tab'));
  assert.ok(!matches(ev('\t'), 'shift+tab'));
  assert.ok(matches(ev('\t'), 'tab'));
  assert.ok(matches(ev('g'), 'g'));
  assert.ok(!matches(ev('G'), 'g'));
  assert.ok(matches(ev('G'), 'G'));
  assert.ok(matches(ev('\x1b[97;2u'), 'G') === false); // kitty shift+a is "A"
  assert.ok(matches(ev('\x1b[97;2u'), 'A'));
  assert.ok(matches(ev('\r'), 'enter'));
  assert.ok(matches(ev('\x1b'), 'escape'));
  assert.ok(matches(ev('\x1b[1;3D'), 'alt+left'));
  assert.ok(!matches(ev('\x1b[D'), 'alt+left'));
  assert.ok(matches(ev('j'), ['down', 'j']));
  assert.ok(matches(ev('\x1b[B'), ['down', 'j']));
  assert.ok(matches(ev(' '), 'space'));
  assert.ok(!matches({ type: 'focus', focused: true }, 'enter'));
});

test('formatBinding', () => {
  assert.equal(formatBinding('ctrl+n'), 'Ctrl+n');
  assert.equal(formatBinding('shift+tab'), '⇧Tab');
  assert.equal(formatBinding('escape'), 'Esc');
  assert.equal(formatBinding('up'), '↑');
  assert.equal(formatBinding('G'), 'G');
  assert.equal(formatBinding('f5'), 'F5');
  assert.equal(formatBinding('alt+enter'), 'Alt+Enter');
});
