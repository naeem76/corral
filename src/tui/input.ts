// Input decoder for the outer terminal, and encoders that turn input events back into bytes
// for the program inside the pane.
//
// stdin arrives as arbitrary string chunks: one escape sequence can be split across chunks and
// one chunk can hold many events. The decoder keeps the unfinished tail and reports whether it
// waits for more bytes, so the caller can run a short timer and call `flush()` (a lone ESC is
// only distinguishable from the start of a sequence by time).

import type { InputEvent, TermModes } from '../types.ts';
import { graphemes } from '../width.ts';

export type KeyEvent = Extract<InputEvent, { type: 'key' }>;
export type MouseEvent = Extract<InputEvent, { type: 'mouse' }>;

export interface InputDecoderOptions {
  /** Wait this long for the rest of an escape sequence before `flush()`. Default 30 ms. */
  escTimeoutMs?: number;
  /** Largest paste kept, in UTF-16 units. Longer pastes are cut. Default 4 MiB. */
  maxPaste?: number;
  /**
   * Treat every `CSI row;col R` as a cursor position report. Default false: `CSI 1;mod R`
   * is then Ctrl/Alt/Shift+F3, because this program does not query the outer cursor.
   */
  cursorReports?: boolean;
  /** Called with sequences that were consumed and dropped (unknown CSI, terminal replies). */
  onUnknown?: (seq: string) => void;
}

export interface InputDecoder {
  /** Decode a chunk. Returns the events that are complete. */
  feed(chunk: string): InputEvent[];
  /** Give up waiting: decode what is pending (a lone ESC becomes the Escape key). */
  flush(): InputEvent[];
  /** True when bytes wait for more input. */
  readonly pending: boolean;
  /** Milliseconds the caller should wait before `flush()`, or null when nothing is pending. */
  pendingTimeout(): number | null;
}

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// A slow paste must not be cut by the short ESC timer.
const PASTE_TIMEOUT_MS = 1000;
// A CSI or string sequence longer than this is garbage; drop it instead of waiting forever.
const MAX_SEQ = 4096;

function key(name: string, raw: string, ctrl = false, alt = false, shift = false): KeyEvent {
  return { type: 'key', key: name, ctrl, alt, shift, raw };
}

/** xterm modifier parameter (1 + bits) to flags. Bit 8 (meta) counts as Alt. */
function mods(param: number): { ctrl: boolean; alt: boolean; shift: boolean } {
  const m = Math.max(0, (param || 1) - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0 || (m & 8) !== 0, ctrl: (m & 4) !== 0 };
}

/** Key for a C0 control character or DEL. Null for one that has no key meaning. */
function controlKey(code: number, raw: string, alt: boolean): KeyEvent | null {
  switch (code) {
    case 0x0d:
    case 0x0a:
      return key('enter', raw, false, alt);
    case 0x09:
      return key('tab', raw, false, alt);
    case 0x7f:
      return key('backspace', raw, false, alt);
    // Windows Terminal and most Linux terminals send 0x08 for Ctrl+Backspace.
    case 0x08:
      return key('backspace', raw, true, alt);
    case 0x1b:
      return key('escape', raw, false, alt);
    case 0x00:
      return key('space', raw, true, alt);
    case 0x1c:
      return key('\\', raw, true, alt);
    case 0x1d:
      return key(']', raw, true, alt);
    case 0x1e:
      return key('^', raw, true, alt);
    case 0x1f:
      return key('_', raw, true, alt);
  }
  if (code >= 0x01 && code <= 0x1a) return key(String.fromCharCode(code + 0x60), raw, true, alt);
  return null;
}

const TILDE_KEYS: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9',
  21: 'f10', 23: 'f11', 24: 'f12',
};

const LETTER_KEYS: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
};

// Windows virtual-key codes for win32-input-mode (only sent when an app asks for ?9001h).
const VK_KEYS: Record<number, string> = {
  0x08: 'backspace', 0x09: 'tab', 0x0d: 'enter', 0x1b: 'escape', 0x20: 'space',
  0x21: 'pageup', 0x22: 'pagedown', 0x23: 'end', 0x24: 'home', 0x25: 'left', 0x26: 'up',
  0x27: 'right', 0x28: 'down', 0x2d: 'insert', 0x2e: 'delete',
  0x70: 'f1', 0x71: 'f2', 0x72: 'f3', 0x73: 'f4', 0x74: 'f5', 0x75: 'f6', 0x76: 'f7',
  0x77: 'f8', 0x78: 'f9', 0x79: 'f10', 0x7a: 'f11', 0x7b: 'f12',
};

/** Key for a Unicode code point reported by kitty `CSI u` or modifyOtherKeys. */
function codepointKey(
  code: number,
  text: string | null,
  m: { ctrl: boolean; alt: boolean; shift: boolean },
  raw: string,
): KeyEvent | null {
  switch (code) {
    case 13: return key('enter', raw, m.ctrl, m.alt, m.shift);
    case 9: return key('tab', raw, m.ctrl, m.alt, m.shift);
    case 127: case 8: return key('backspace', raw, m.ctrl, m.alt, m.shift);
    case 27: return key('escape', raw, m.ctrl, m.alt, m.shift);
    case 32: return key('space', raw, m.ctrl, m.alt, m.shift);
  }
  if (code < 32) return controlKey(code, raw, m.alt);
  // Private-use codes are kitty functional keys (keypad, media, lone modifiers): drop them.
  if (code >= 0xe000 && code <= 0xf8ff) return null;
  if (code > 0x10ffff) return null;
  let name = text && text.length > 0 ? text : String.fromCodePoint(code);
  if (!text && m.shift && !m.ctrl && name.length === 1 && name >= 'a' && name <= 'z') name = name.toUpperCase();
  if (m.ctrl && name.length === 1 && name >= 'A' && name <= 'Z') name = name.toLowerCase();
  return key(name, raw, m.ctrl, m.alt, m.shift);
}

/** Parse "1;5" or "97:65;2" into numbers per field (sub-parameters after ':'). */
function parseParams(s: string): number[][] {
  if (s.length === 0) return [];
  return s.split(';').map((f) => f.split(':').map((n) => (n === '' ? 0 : Number.parseInt(n, 10) || 0)));
}

function p(params: number[][], i: number, def = 0): number {
  const v = params[i]?.[0];
  return v === undefined || Number.isNaN(v) ? def : v;
}

function mouseFromButton(
  cb: number,
  x: number,
  y: number,
  release: boolean,
  raw: string,
  releaseUnknown: boolean,
): MouseEvent | null {
  const low = cb & 3;
  const shift = (cb & 4) !== 0;
  const alt = (cb & 8) !== 0;
  const ctrl = (cb & 16) !== 0;
  const motion = (cb & 32) !== 0;
  if (cb & 128) return null; // buttons 8-11
  if (cb & 64) {
    if (motion) return null;
    if (low === 0) return { type: 'mouse', x, y, button: 'none', action: 'wheel-up', ctrl, alt, shift, raw };
    if (low === 1) return { type: 'mouse', x, y, button: 'none', action: 'wheel-down', ctrl, alt, shift, raw };
    return null; // horizontal wheel
  }
  const names = ['left', 'middle', 'right', 'none'] as const;
  const button = names[low]!;
  let action: MouseEvent['action'];
  if (motion) action = 'move';
  else if (release || (releaseUnknown && low === 3)) action = 'up';
  else action = 'down';
  if (action === 'down' && button === 'none') return null;
  return { type: 'mouse', x: Math.max(0, x), y: Math.max(0, y), button, action, ctrl, alt, shift, raw };
}

type Step =
  | { kind: 'events'; len: number; events: InputEvent[] }
  | { kind: 'incomplete' }
  | { kind: 'paste-start'; len: number };

export function createInputDecoder(options: InputDecoderOptions = {}): InputDecoder {
  const escTimeout = options.escTimeoutMs ?? 30;
  const maxPaste = options.maxPaste ?? 4 * 1024 * 1024;
  const cursorReports = options.cursorReports ?? false;
  const onUnknown = options.onUnknown;

  let buf = '';
  let inPaste = false;
  let pasteParts: string[] = [];
  let pasteLen = 0;

  function drop(seq: string): void {
    if (onUnknown) {
      try {
        onUnknown(seq);
      } catch {
        // A debug hook must never break input.
      }
    }
  }

  function addPaste(text: string): void {
    if (pasteLen >= maxPaste) return;
    const room = maxPaste - pasteLen;
    const part = text.length > room ? text.slice(0, room) : text;
    pasteParts.push(part);
    pasteLen += part.length;
  }

  function endPaste(out: InputEvent[]): void {
    out.push({ type: 'paste', text: pasteParts.join('') });
    inPaste = false;
    pasteParts = [];
    pasteLen = 0;
  }

  /** Decode a CSI sequence whose full text is `seq` (from ESC to the final byte). */
  function decodeCsi(seq: string, prefix: string, paramStr: string, inter: string, final: string): InputEvent[] {
    const params = parseParams(paramStr);
    // Replies to queries (DA, DECRPM, kitty flags, XTVERSION in CSI form) carry a prefix
    // or an intermediate byte. They are never input.
    if (prefix === '<' && (final === 'M' || final === 'm') && inter === '') {
      const ev = mouseFromButton(p(params, 0), p(params, 1, 1) - 1, p(params, 2, 1) - 1, final === 'm', seq, false);
      if (ev) return [ev];
      drop(seq);
      return [];
    }
    if (prefix !== '' || inter !== '') {
      drop(seq);
      return [];
    }
    const n = params.length;
    switch (final) {
      case '~': {
        const code = p(params, 0);
        if (code === 27 && n >= 3) {
          // xterm modifyOtherKeys: CSI 27 ; mod ; code ~
          const ev = codepointKey(p(params, 2), null, mods(p(params, 1, 1)), seq);
          if (ev) return [ev];
          drop(seq);
          return [];
        }
        const name = TILDE_KEYS[code];
        if (name) {
          const m = mods(p(params, 1, 1));
          // kitty reports key release as event type 3 in the sub-parameter.
          if ((params[1]?.[1] ?? 1) === 3) return [];
          return [key(name, seq, m.ctrl, m.alt, m.shift)];
        }
        drop(seq);
        return [];
      }
      case 'u': {
        const code = p(params, 0);
        const mod = params[1]?.[0] ?? 1;
        const evType = params[1]?.[1] ?? 1;
        if (evType === 3) return [];
        const textField = params[2];
        const text = textField && textField.length > 0 && textField[0]! > 0
          ? String.fromCodePoint(...textField.filter((c) => c > 0 && c <= 0x10ffff))
          : null;
        const ev = codepointKey(code, text, mods(mod), seq);
        if (ev) return [ev];
        drop(seq);
        return [];
      }
      case 'Z':
        return [key('tab', seq, false, false, true)];
      case 'I':
        if (n === 0) return [{ type: 'focus', focused: true }];
        break;
      case 'O':
        if (n === 0) return [{ type: 'focus', focused: false }];
        break;
      case 'M':
        if (n === 3) {
          // urxvt 1015 mouse: CSI Cb ; Cx ; Cy M, button with +32 offset.
          const ev = mouseFromButton(p(params, 0) - 32, p(params, 1, 1) - 1, p(params, 2, 1) - 1, false, seq, true);
          if (ev) return [ev];
        }
        break;
      case 'R':
        {
          // CSI 1;mod R with a modifier is F3; any other row;col is a cursor position report.
          const mod = p(params, 1, 1);
          const isKey = n < 2 || (!cursorReports && p(params, 0) === 1 && mod >= 2 && mod <= 16);
          if (!isKey) break;
          const m = mods(mod);
          return [key('f3', seq, m.ctrl, m.alt, m.shift)];
        }
      case '_':
        // win32-input-mode: CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
        if (n >= 4) {
          if (p(params, 3) !== 1) return [];
          const vk = p(params, 0);
          const uc = p(params, 2);
          const cs = p(params, 4);
          const ctrl = (cs & 0x0c) !== 0;
          const alt = (cs & 0x03) !== 0;
          const shift = (cs & 0x10) !== 0;
          const named = VK_KEYS[vk];
          if (named) return [key(named, seq, ctrl, alt, shift)];
          if (uc > 0) {
            const ev = uc < 32 ? controlKey(uc, seq, alt) : codepointKey(uc, null, { ctrl, alt, shift: false }, seq);
            if (ev) return [{ ...ev, ctrl: ev.ctrl || ctrl, alt: ev.alt || alt, shift }];
          }
          return [];
        }
        break;
      default: {
        const name = LETTER_KEYS[final];
        if (name) {
          const m = mods(p(params, n >= 2 ? 1 : 0, 1));
          return [key(name, seq, m.ctrl, m.alt, m.shift)];
        }
      }
    }
    drop(seq);
    return [];
  }

  /** Try to parse a CSI starting at buf[i] (buf[i] = ESC, buf[i+1] = '['). */
  function parseCsi(i: number): Step {
    let j = i + 2;
    if (j >= buf.length) return { kind: 'incomplete' };
    // Legacy X10 mouse: CSI M followed by three raw bytes.
    if (buf[j] === 'M') {
      if (buf.length < j + 4) return { kind: 'incomplete' };
      const raw = buf.slice(i, j + 4);
      const cb = buf.charCodeAt(j + 1) - 32;
      const cx = buf.codePointAt(j + 2)! - 33;
      const cy = buf.codePointAt(j + 3)! - 33;
      const ev = mouseFromButton(cb, cx, cy, false, raw, true);
      if (!ev) drop(raw);
      return { kind: 'events', len: raw.length, events: ev ? [ev] : [] };
    }
    let prefix = '';
    const c0 = buf.charCodeAt(j);
    if (c0 >= 0x3c && c0 <= 0x3f) {
      prefix = buf[j]!;
      j++;
    }
    const paramStart = j;
    while (j < buf.length) {
      const c = buf.charCodeAt(j);
      if (c >= 0x30 && c <= 0x3f) j++;
      else break;
    }
    const paramEnd = j;
    while (j < buf.length) {
      const c = buf.charCodeAt(j);
      if (c >= 0x20 && c <= 0x2f) j++;
      else break;
    }
    if (j >= buf.length) {
      if (j - i > MAX_SEQ) {
        drop(buf.slice(i, j));
        return { kind: 'events', len: j - i, events: [] };
      }
      return { kind: 'incomplete' };
    }
    const fc = buf.charCodeAt(j);
    if (fc < 0x40 || fc > 0x7e) {
      // Not a valid CSI: drop the broken introducer and parameters, keep the rest.
      drop(buf.slice(i, j));
      return { kind: 'events', len: j - i, events: [] };
    }
    const seq = buf.slice(i, j + 1);
    if (seq === PASTE_START) return { kind: 'paste-start', len: seq.length };
    const events = decodeCsi(seq, prefix, buf.slice(paramStart, paramEnd), buf.slice(paramEnd, j), buf[j]!);
    return { kind: 'events', len: seq.length, events };
  }

  /** String sequences (OSC, DCS, APC): consume up to BEL or ST. */
  function parseString(i: number, introLen: number, allowBel: boolean): Step {
    for (let j = i + introLen; j < buf.length; j++) {
      const c = buf.charCodeAt(j);
      if (allowBel && c === 0x07) {
        drop(buf.slice(i, j + 1));
        return { kind: 'events', len: j + 1 - i, events: [] };
      }
      if (c === 0x9c) {
        drop(buf.slice(i, j + 1));
        return { kind: 'events', len: j + 1 - i, events: [] };
      }
      if (c === 0x1b) {
        if (j + 1 >= buf.length) return { kind: 'incomplete' };
        if (buf[j + 1] === '\\') {
          drop(buf.slice(i, j + 2));
          return { kind: 'events', len: j + 2 - i, events: [] };
        }
      }
    }
    if (buf.length - i > MAX_SEQ) {
      drop(buf.slice(i));
      return { kind: 'events', len: buf.length - i, events: [] };
    }
    return { kind: 'incomplete' };
  }

  /** Decode one key from a single printable grapheme or control character at buf[i]. */
  function parsePlain(i: number, alt: boolean, rawStart: number): Step {
    const c = buf.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      const raw = buf.slice(rawStart, i + 1);
      const ev = controlKey(c, raw, alt);
      return { kind: 'events', len: i + 1 - rawStart, events: ev ? [ev] : [] };
    }
    // A high surrogate at the very end waits for its pair.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 >= buf.length) return { kind: 'incomplete' };
    if (c >= 0x80 && c < 0xa0) {
      // C1 control characters are not keys.
      drop(buf.slice(rawStart, i + 1));
      return { kind: 'events', len: i + 1 - rawStart, events: [] };
    }
    if (alt) {
      const g = firstGrapheme(i);
      const name = g === ' ' ? 'space' : g;
      return { kind: 'events', len: i + g.length - rawStart, events: [key(name, buf.slice(rawStart, i + g.length), false, true)] };
    }
    // A run of printable text becomes one event per grapheme.
    let j = i;
    while (j < buf.length) {
      const d = buf.charCodeAt(j);
      if (d < 0x20 || (d >= 0x7f && d < 0xa0)) break;
      j++;
    }
    // Keep a lone high surrogate at the end for the next chunk.
    if (j === buf.length && j > i) {
      const last = buf.charCodeAt(j - 1);
      if (last >= 0xd800 && last <= 0xdbff) j--;
    }
    const events: InputEvent[] = [];
    for (const g of graphemes(buf.slice(i, j))) events.push(key(g === ' ' ? 'space' : g, g));
    return { kind: 'events', len: j - i, events };
  }

  function firstGrapheme(i: number): string {
    // Look at a short window; graphemes are short.
    const window = buf.slice(i, i + 32);
    let end = 0;
    while (end < window.length) {
      const d = window.charCodeAt(end);
      if (d < 0x20 || (d >= 0x7f && d < 0xa0)) break;
      end++;
    }
    const gs = graphemes(window.slice(0, Math.max(1, end)));
    return gs[0] ?? window[0]!;
  }

  function parseOne(i: number): Step {
    const c = buf.charCodeAt(i);
    if (c !== 0x1b) return parsePlain(i, false, i);
    if (i + 1 >= buf.length) return { kind: 'incomplete' };
    const n = buf[i + 1]!;
    switch (n) {
      case '[':
        return parseCsi(i);
      case 'O': {
        if (i + 2 >= buf.length) return { kind: 'incomplete' };
        // SS3 may carry a modifier digit (old xterm: ESC O 5 A).
        let j = i + 2;
        let mod = 1;
        while (j < buf.length && buf.charCodeAt(j) >= 0x30 && buf.charCodeAt(j) <= 0x39) j++;
        if (j >= buf.length) return { kind: 'incomplete' };
        if (j > i + 2) mod = Number.parseInt(buf.slice(i + 2, j), 10) || 1;
        const final = buf[j]!;
        const seq = buf.slice(i, j + 1);
        const name = LETTER_KEYS[final];
        if (name) {
          const m = mods(mod);
          return { kind: 'events', len: seq.length, events: [key(name, seq, m.ctrl, m.alt, m.shift)] };
        }
        // Keypad in application mode: ESC O M is keypad Enter.
        if (final === 'M') return { kind: 'events', len: seq.length, events: [key('enter', seq)] };
        drop(seq);
        return { kind: 'events', len: seq.length, events: [] };
      }
      case ']':
        return parseString(i, 2, true);
      case 'P': {
        // DCS reply (XTVERSION "ESC P > | ...", DECRQSS "ESC P 1 $ r ..."); otherwise Alt+P.
        if (i + 2 >= buf.length) return { kind: 'incomplete' };
        if (/[0-9>!|=$+;]/.test(buf[i + 2]!)) return parseString(i, 2, false);
        return parsePlain(i + 1, true, i);
      }
      case '_': {
        // kitty graphics reply "ESC _ G ..."; otherwise Alt+_.
        if (i + 2 >= buf.length) return { kind: 'incomplete' };
        if (buf[i + 2] === 'G') return parseString(i, 2, false);
        return parsePlain(i + 1, true, i);
      }
      case '\x1b': {
        // ESC ESC [ A: Alt + a sequence (some terminals send Alt+arrow like this).
        if (i + 2 >= buf.length) return { kind: 'incomplete' };
        const third = buf[i + 2]!;
        if (third === '[' || third === 'O') {
          const inner = parseOne(i + 1);
          if (inner.kind !== 'events') return inner.kind === 'incomplete' ? inner : { kind: 'events', len: 1, events: [key('escape', ESC, false, true)] };
          const events = inner.events.map((ev) =>
            ev.type === 'key' ? { ...ev, alt: true, raw: ESC + ev.raw } : ev.type === 'mouse' ? { ...ev, raw: ESC + ev.raw } : ev,
          );
          return { kind: 'events', len: inner.len + 1, events };
        }
        return { kind: 'events', len: 2, events: [key('escape', buf.slice(i, i + 2), false, true)] };
      }
      default:
        return parsePlain(i + 1, true, i);
    }
  }

  function run(out: InputEvent[], final: boolean): void {
    for (;;) {
      if (inPaste) {
        const end = buf.indexOf(PASTE_END);
        if (end >= 0) {
          addPaste(buf.slice(0, end));
          buf = buf.slice(end + PASTE_END.length);
          endPaste(out);
          continue;
        }
        if (final) {
          addPaste(buf);
          buf = '';
          endPaste(out);
          return;
        }
        // Keep a tail that could be the start of the end marker.
        let keep = 0;
        for (let k = Math.min(PASTE_END.length - 1, buf.length); k > 0; k--) {
          if (PASTE_END.startsWith(buf.slice(buf.length - k))) {
            keep = k;
            break;
          }
        }
        addPaste(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        return;
      }
      if (buf.length === 0) return;
      let step: Step;
      try {
        step = parseOne(0);
      } catch {
        // Garbage must never stop input: drop one unit and continue.
        drop(buf[0]!);
        buf = buf.slice(1);
        continue;
      }
      if (step.kind === 'incomplete') {
        if (!final) return;
        // Timed out: the leading ESC is the Escape key (or Alt+ what follows, if decodable).
        if (buf[0] === ESC) {
          if (buf.length === 1) {
            out.push(key('escape', ESC));
            buf = '';
            continue;
          }
          const second = buf.charCodeAt(1);
          if (second === 0x1b) {
            out.push(key('escape', ESC));
            buf = buf.slice(1);
            continue;
          }
          const alt = parsePlain(1, true, 0);
          if (alt.kind === 'events') {
            out.push(...alt.events);
            buf = buf.slice(alt.len);
            continue;
          }
          out.push(key('escape', ESC));
          buf = buf.slice(1);
          continue;
        }
        // A lone high surrogate.
        drop(buf[0]!);
        buf = buf.slice(1);
        continue;
      }
      if (step.kind === 'paste-start') {
        buf = buf.slice(step.len);
        inPaste = true;
        pasteParts = [];
        pasteLen = 0;
        continue;
      }
      out.push(...step.events);
      buf = buf.slice(Math.max(1, step.len));
    }
  }

  return {
    feed(chunk: string): InputEvent[] {
      const out: InputEvent[] = [];
      buf += chunk;
      run(out, false);
      return out;
    },
    flush(): InputEvent[] {
      const out: InputEvent[] = [];
      run(out, true);
      return out;
    },
    get pending(): boolean {
      return inPaste || buf.length > 0;
    },
    pendingTimeout(): number | null {
      if (inPaste) return PASTE_TIMEOUT_MS;
      return buf.length > 0 ? escTimeout : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Encoders for the program inside the pane
// ---------------------------------------------------------------------------

/**
 * Re-encode a mouse event for the PTY. Coordinates are shifted by the pane origin.
 * Returns null when the inner program does not want this event, or it lies left/above the pane.
 */
export function encodeMouseForPty(event: MouseEvent, offsetX: number, offsetY: number, modes: TermModes): string | null {
  const x = event.x - offsetX;
  const y = event.y - offsetY;
  if (x < 0 || y < 0) return null;
  const mode = modes.mouse;
  if (mode === 'none') return null;
  const isWheel = event.action === 'wheel-up' || event.action === 'wheel-down';
  if (event.action === 'move') {
    if (mode === 'x10' || mode === 'button') return null;
    if (mode === 'drag' && event.button === 'none') return null;
  }
  if (mode === 'x10' && event.action === 'up') return null;

  let cb: number;
  if (isWheel) cb = event.action === 'wheel-up' ? 64 : 65;
  else cb = event.button === 'left' ? 0 : event.button === 'middle' ? 1 : event.button === 'right' ? 2 : 3;
  if (event.action === 'move') cb += 32;
  if (mode !== 'x10') {
    if (event.shift) cb += 4;
    if (event.alt) cb += 8;
    if (event.ctrl) cb += 16;
  }
  if (modes.mouseSgr) {
    const final = event.action === 'up' ? 'm' : 'M';
    return `\x1b[<${cb};${x + 1};${y + 1}${final}`;
  }
  // Legacy encoding: release has no button, coordinates stop at 223.
  if (event.action === 'up') cb = (cb & ~3) | 3;
  if (x + 1 + 32 > 255 || y + 1 + 32 > 255) return null;
  return `\x1b[M${String.fromCharCode(32 + cb)}${String.fromCharCode(32 + x + 1)}${String.fromCharCode(32 + y + 1)}`;
}

/** Wrap pasted text for the PTY. Paste markers inside the text are removed so it cannot break out. */
export function encodePasteForPty(text: string, modes: TermModes): string {
  let clean = text;
  for (;;) {
    const next = clean.split(PASTE_END).join('').split(PASTE_START).join('');
    if (next === clean) break;
    clean = next;
  }
  return modes.bracketedPaste ? PASTE_START + clean + PASTE_END : clean;
}

/** Focus report for the PTY, or null when the program did not ask for focus events. */
export function encodeFocusForPty(focused: boolean, modes: TermModes): string | null {
  if (!modes.focusEvents) return null;
  return focused ? '\x1b[I' : '\x1b[O';
}

const CURSOR_FINAL: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE_CODE: Record<string, number> = {
  insert: 2, delete: 3, pageup: 5, pagedown: 6,
  f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};
const SS3_F: Record<string, string> = { f1: 'P', f2: 'Q', f3: 'R', f4: 'S' };

/**
 * Bytes for a key event in the form a program in an xterm-compatible terminal expects,
 * respecting application cursor keys. Prefer this over `event.raw`: the outer terminal may
 * use another encoding (kitty, win32-input-mode) or another cursor-key mode than the pane.
 */
export function encodeKeyForPty(event: KeyEvent, modes: TermModes): string {
  const { ctrl, alt, shift } = event;
  const modParam = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const k = event.key;
  const cur = CURSOR_FINAL[k];
  if (cur) {
    if (modParam > 1) return `\x1b[1;${modParam}${cur}`;
    return (modes.appCursorKeys ? '\x1bO' : '\x1b[') + cur;
  }
  const t = TILDE_CODE[k];
  if (t !== undefined) return modParam > 1 ? `\x1b[${t};${modParam}~` : `\x1b[${t}~`;
  const f = SS3_F[k];
  if (f) return modParam > 1 ? `\x1b[1;${modParam}${f}` : `\x1bO${f}`;
  const pre = alt ? ESC : '';
  switch (k) {
    case 'enter': return pre + '\r';
    case 'tab': return shift && !ctrl && !alt ? '\x1b[Z' : pre + '\t';
    case 'backspace': return pre + (ctrl ? '\x08' : '\x7f');
    case 'escape': return pre + ESC;
    case 'space': return pre + (ctrl ? '\x00' : ' ');
  }
  if (ctrl) {
    const ch = k.length === 1 ? k.toLowerCase() : '';
    if (ch >= 'a' && ch <= 'z') return pre + String.fromCharCode(ch.charCodeAt(0) - 0x60);
    switch (ch) {
      case '@': case '2': return pre + '\x00';
      case '[': case '3': return pre + ESC;
      case '\\': case '4': return pre + '\x1c';
      case ']': case '5': return pre + '\x1d';
      case '^': case '6': return pre + '\x1e';
      case '_': case '/': case '7': return pre + '\x1f';
    }
    return event.raw;
  }
  return pre + k;
}
