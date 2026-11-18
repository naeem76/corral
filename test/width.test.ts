import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePointWidth, graphemeWidth, graphemes, stringWidth } from '../src/width.ts';

test('ASCII is one cell per character', () => {
  assert.equal(stringWidth('hello world'), 11);
  assert.deepEqual(graphemes('abc'), ['a', 'b', 'c']);
});

test('control characters have no width', () => {
  assert.equal(codePointWidth(0x1b), 0);
  assert.equal(codePointWidth(0x07), 0);
  assert.equal(stringWidth('a\tb'), 2);
});

test('CJK, Hangul and fullwidth forms are two cells', () => {
  assert.equal(stringWidth('日本語'), 6);
  assert.equal(stringWidth('한'), 2);
  assert.equal(stringWidth('Ａ'), 2);
});

test('box drawing and Latin accents are one cell', () => {
  assert.equal(stringWidth('┌─┐│●◐○'), 7);
  assert.equal(stringWidth('é'), 1);
  assert.equal(stringWidth('é'), 1);
  assert.deepEqual(graphemes('éx'), ['é', 'x']);
});

test('emoji are two cells, including sequences', () => {
  assert.equal(graphemeWidth('🚀'), 2);
  assert.equal(graphemeWidth('👨‍👩‍👧'), 2);
  assert.equal(graphemeWidth('🇨🇦'), 2);
  assert.equal(graphemeWidth('❤'), 1);
  assert.equal(graphemeWidth('❤️'), 2);
  assert.equal(stringWidth('a🚀b'), 4);
});

test('zero-width characters', () => {
  assert.equal(codePointWidth(0x200b), 0);
  assert.equal(codePointWidth(0x0301), 0);
  assert.equal(codePointWidth(0xfe0f), 0);
});
