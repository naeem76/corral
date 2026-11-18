// Key bindings as strings: "ctrl+n", "shift+tab", "g", "G", "enter", "alt+left".
// A single printable character is case-sensitive ("g" and "G" differ) and ignores the shift
// flag, because terminals report shift for printable keys only through the character itself.

import type { InputEvent } from '../types.ts';

export interface Binding {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const ALIASES: Record<string, string> = {
  esc: 'escape', return: 'enter', cr: 'enter', pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown',
  del: 'delete', ins: 'insert', bs: 'backspace', ' ': 'space', arrowup: 'up', arrowdown: 'down',
  arrowleft: 'left', arrowright: 'right',
};

const cache = new Map<string, Binding>();

/** Parse a binding string. Throws on an empty key. */
export function parseBinding(text: string): Binding {
  const hit = cache.get(text);
  if (hit) return hit;
  let rest = text;
  let keyPart: string;
  if (rest.endsWith('++')) {
    keyPart = '+';
    rest = rest.slice(0, -2);
  } else {
    const at = rest.lastIndexOf('+');
    keyPart = at >= 0 ? rest.slice(at + 1) : rest;
    rest = at >= 0 ? rest.slice(0, at) : '';
  }
  const b: Binding = { key: '', ctrl: false, alt: false, shift: false };
  for (const m of rest.split('+')) {
    const mod = m.trim().toLowerCase();
    if (mod === '') continue;
    if (mod === 'ctrl' || mod === 'control' || mod === 'c') b.ctrl = true;
    else if (mod === 'alt' || mod === 'meta' || mod === 'opt' || mod === 'm') b.alt = true;
    else if (mod === 'shift' || mod === 's') b.shift = true;
    else throw new Error(`Unknown modifier "${m}" in key binding "${text}"`);
  }
  if (keyPart.length === 0) throw new Error(`Empty key in key binding "${text}"`);
  const single = [...keyPart].length === 1;
  if (single) {
    b.key = keyPart;
    if (b.ctrl) b.key = b.key.toLowerCase();
    else if (b.shift && b.key.toLowerCase() !== b.key.toUpperCase()) {
      // "shift+g" is the same as "G".
      b.key = b.key.toUpperCase();
      b.shift = false;
    }
  } else {
    const lower = keyPart.toLowerCase();
    b.key = ALIASES[lower] ?? lower;
  }
  if (b.key === ' ') b.key = 'space';
  cache.set(text, b);
  return b;
}

/** True when the event is a key press that matches one of the bindings. */
export function matches(event: InputEvent, binding: string | readonly string[]): boolean {
  if (event.type !== 'key') return false;
  const list = typeof binding === 'string' ? [binding] : binding;
  for (const text of list) {
    const b = parseBinding(text);
    if (b.ctrl !== event.ctrl || b.alt !== event.alt) continue;
    const single = [...b.key].length === 1;
    if (single) {
      const k = b.ctrl ? event.key.toLowerCase() : event.key;
      if (k === b.key && (!b.shift || event.shift)) return true;
      continue;
    }
    if (event.key === b.key && event.shift === b.shift) return true;
  }
  return false;
}

const NAMES: Record<string, string> = {
  enter: 'Enter', tab: 'Tab', backspace: 'Bksp', escape: 'Esc', space: 'Space', up: '↑', down: '↓',
  left: '←', right: '→', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn', insert: 'Ins',
  delete: 'Del',
};

/** Short label for footer hints: "Ctrl+n", "⇧Tab", "Esc", "↑", "G". */
export function formatBinding(binding: string): string {
  const b = parseBinding(binding);
  let name = NAMES[b.key] ?? (/^f\d+$/.test(b.key) ? b.key.toUpperCase() : b.key);
  if (b.shift) name = '⇧' + name;
  if (b.alt) name = 'Alt+' + name;
  if (b.ctrl) name = 'Ctrl+' + name;
  return name;
}
