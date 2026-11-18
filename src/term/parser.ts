// VT500-series parser (after Paul Williams' state diagram), working on UTF-16 code units.
// Input can be split anywhere between write() calls: all state lives in the instance.
// Printable runs go to the handler as (data, start, end) ranges so the hot path does not copy.

/** Maximum number of CSI/DCS parameters kept. Further parameters are parsed and dropped. */
export const MAX_PARAMS = 32;
/** Maximum kept length of an OSC or DCS string. Longer strings are consumed and dropped. */
export const MAX_STRING = 65536;
/** Parameter values are clamped to this, so huge numbers cannot overflow or drive huge loops. */
export const MAX_PARAM_VALUE = 65535;

export interface ParserHandler {
  /** Printable text in data[start, end). Never contains C0, DEL or C1 code units. */
  print(data: string, start: number, end: number): void;
  /** A C0 control (other than ESC, CAN, SUB inside sequences). */
  execute(code: number): void;
  /**
   * CSI sequence. params[i] is -1 when the parameter was empty. subs[i] is 1 when parameter i
   * followed a ':' (a sub-parameter of the one before). prefix is the private marker
   * ('<' '=' '>' '?') or 0. inter holds up to two intermediates packed as (first << 8) | second.
   */
  csi(params: Int32Array, subs: Uint8Array, count: number, prefix: number, inter: number, final: number): void;
  esc(inter: number, final: number): void;
  osc(data: string): void;
  dcs(params: Int32Array, count: number, prefix: number, inter: number, final: number, data: string): void;
}

const GROUND = 0;
const ESCAPE = 1;
const ESC_INTER = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTER = 5;
const CSI_IGNORE = 6;
const OSC_STRING = 7;
const DCS_ENTRY = 8;
const DCS_PARAM = 9;
const DCS_INTER = 10;
const DCS_PASS = 11;
const DCS_IGNORE = 12;
const STRING_IGNORE = 13; // SOS, PM, APC

function isPrintable(c: number): boolean {
  return c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f);
}

export class Parser {
  state = GROUND;
  readonly params = new Int32Array(MAX_PARAMS);
  readonly subs = new Uint8Array(MAX_PARAMS);
  private count = 0;
  private cur = -1;
  private nextSub = 0;
  private prefix = 0;
  private inter = 0;
  private interCount = 0;
  private parts: string[] = [];
  private strLen = 0;
  private strOverflow = false;
  private dcsFinal = 0;
  private handler: ParserHandler;

  constructor(handler: ParserHandler) {
    this.handler = handler;
  }

  reset(): void {
    this.state = GROUND;
    this.clear();
    this.parts = [];
    this.strLen = 0;
    this.strOverflow = false;
  }

  private clear(): void {
    this.count = 0;
    this.cur = -1;
    this.nextSub = 0;
    this.prefix = 0;
    this.inter = 0;
    this.interCount = 0;
  }

  private collect(c: number): void {
    this.interCount++;
    if (this.interCount <= 2) this.inter = (this.inter << 8) | c;
  }

  private param(c: number): void {
    if (c === 0x3b || c === 0x3a) {
      this.pushParam();
      this.nextSub = c === 0x3a ? 1 : 0;
      return;
    }
    const v = (this.cur < 0 ? 0 : this.cur) * 10 + (c - 0x30);
    this.cur = v > MAX_PARAM_VALUE ? MAX_PARAM_VALUE : v;
  }

  private pushParam(): void {
    if (this.count < MAX_PARAMS) {
      this.params[this.count] = this.cur;
      this.subs[this.count] = this.nextSub;
      this.count++;
    }
    this.cur = -1;
  }

  private startString(): void {
    this.parts.length = 0;
    this.strLen = 0;
    this.strOverflow = false;
  }

  private appendString(data: string, start: number, end: number): void {
    if (end <= start || this.strOverflow) return;
    if (this.strLen + (end - start) > MAX_STRING) {
      this.strOverflow = true;
      this.parts.length = 0;
      return;
    }
    this.parts.push(data.slice(start, end));
    this.strLen += end - start;
  }

  private takeString(): string | null {
    if (this.strOverflow) {
      this.startString();
      return null;
    }
    const s = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
    this.startString();
    return s;
  }

  write(data: string): void {
    const len = data.length;
    const h = this.handler;
    let i = 0;
    while (i < len) {
      const state = this.state;
      if (state === GROUND) {
        let j = i;
        while (j < len && isPrintable(data.charCodeAt(j))) j++;
        if (j > i) {
          h.print(data, i, j);
          i = j;
          if (i >= len) break;
        }
        const c = data.charCodeAt(i++);
        if (c === 0x1b) {
          this.clear();
          this.state = ESCAPE;
        } else if (c < 0x20) {
          h.execute(c);
        }
        // DEL and C1 code points are ignored in ground.
        continue;
      }
      if (state === OSC_STRING || state === DCS_PASS || state === DCS_IGNORE || state === STRING_IGNORE) {
        let j = i;
        for (; j < len; j++) {
          const c = data.charCodeAt(j);
          if (c === 0x1b || c === 0x18 || c === 0x1a || (c === 0x07 && state === OSC_STRING)) break;
        }
        if (state === OSC_STRING || state === DCS_PASS) this.appendString(data, i, j);
        if (j >= len) break;
        const c = data.charCodeAt(j);
        i = j + 1;
        if (c === 0x18 || c === 0x1a) {
          this.startString();
          this.state = GROUND;
          continue;
        }
        // BEL (OSC only) or ESC: the string ends here. ESC then starts a new sequence, which
        // is ST ("ESC \") in the normal case and is ignored by the escape dispatch.
        if (state === OSC_STRING) {
          const s = this.takeString();
          if (s !== null) h.osc(s);
        } else if (state === DCS_PASS) {
          const s = this.takeString();
          if (s !== null) h.dcs(this.params, this.count, this.prefix, this.inter, this.dcsFinal, s);
        }
        if (c === 0x1b) {
          this.clear();
          this.state = ESCAPE;
        } else {
          this.state = GROUND;
        }
        continue;
      }
      const c = data.charCodeAt(i);
      if (this.step(c)) i++;
    }
  }

  /** Handle one code unit in an escape, CSI or DCS header state. Returns false to reprocess c in ground. */
  private step(c: number): boolean {
    const h = this.handler;
    if (c === 0x18 || c === 0x1a) {
      this.state = GROUND;
      return true;
    }
    if (c === 0x1b) {
      this.clear();
      this.state = ESCAPE;
      return true;
    }
    if (c >= 0x80) {
      // Not part of any 7-bit sequence: abort it and print the character.
      if (c <= 0x9f) return true;
      this.state = GROUND;
      return false;
    }
    switch (this.state) {
      case ESCAPE:
        if (c < 0x20) h.execute(c);
        else if (c < 0x30) {
          this.collect(c);
          this.state = ESC_INTER;
        } else if (c === 0x5b) {
          this.clear();
          this.state = CSI_ENTRY;
        } else if (c === 0x5d) {
          this.startString();
          this.state = OSC_STRING;
        } else if (c === 0x50) {
          this.clear();
          this.state = DCS_ENTRY;
        } else if (c === 0x58 || c === 0x5e || c === 0x5f) {
          this.state = STRING_IGNORE;
        } else if (c < 0x7f) {
          this.state = GROUND;
          h.esc(0, c);
        }
        return true;
      case ESC_INTER:
        if (c < 0x20) h.execute(c);
        else if (c < 0x30) this.collect(c);
        else if (c < 0x7f) {
          this.state = GROUND;
          if (this.interCount <= 2) h.esc(this.inter, c);
        }
        return true;
      case CSI_ENTRY:
      case CSI_PARAM:
        if (c < 0x20) h.execute(c);
        else if (c < 0x30) {
          this.collect(c);
          this.state = CSI_INTER;
        } else if (c <= 0x3b) {
          this.param(c);
          this.state = CSI_PARAM;
        } else if (c <= 0x3f) {
          if (this.state === CSI_ENTRY) {
            this.prefix = c;
            this.state = CSI_PARAM;
          } else this.state = CSI_IGNORE;
        } else if (c < 0x7f) this.dispatchCsi(c);
        return true;
      case CSI_INTER:
        if (c < 0x20) h.execute(c);
        else if (c < 0x30) this.collect(c);
        else if (c < 0x40) this.state = CSI_IGNORE;
        else if (c < 0x7f) this.dispatchCsi(c);
        return true;
      case CSI_IGNORE:
        if (c < 0x20) h.execute(c);
        else if (c >= 0x40 && c < 0x7f) this.state = GROUND;
        return true;
      case DCS_ENTRY:
      case DCS_PARAM:
        if (c < 0x20) return true;
        if (c < 0x30) {
          this.collect(c);
          this.state = DCS_INTER;
        } else if (c <= 0x3b) {
          this.param(c);
          this.state = DCS_PARAM;
        } else if (c <= 0x3f) {
          if (this.state === DCS_ENTRY) {
            this.prefix = c;
            this.state = DCS_PARAM;
          } else this.state = DCS_IGNORE;
        } else if (c < 0x7f) this.hookDcs(c);
        return true;
      case DCS_INTER:
        if (c < 0x20) return true;
        if (c < 0x30) this.collect(c);
        else if (c < 0x40) this.state = DCS_IGNORE;
        else if (c < 0x7f) this.hookDcs(c);
        return true;
    }
    return true;
  }

  private dispatchCsi(final: number): void {
    this.state = GROUND;
    this.pushParam();
    if (this.interCount > 2) return;
    this.handler.csi(this.params, this.subs, this.count, this.prefix, this.inter, final);
  }

  private hookDcs(final: number): void {
    this.pushParam();
    this.dcsFinal = final;
    this.startString();
    this.state = this.interCount > 2 ? DCS_IGNORE : DCS_PASS;
  }
}
