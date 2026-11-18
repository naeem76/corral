// Display width of text in terminal cells. Shared by src/term and src/tui so the emulator and
// the renderer always agree on how many columns a character takes.
//
// Owner: the planner. Do not change this file in a worker task; report problems instead.

// East Asian Wide / Fullwidth ranges plus emoji with default emoji presentation.
// Flat list of inclusive [start, end] pairs in ascending order.
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3,
  0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1,
  0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b,
  0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797,
  0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x2e80, 0x303e,
  0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xa000, 0xa4cf, 0xa960, 0xa97f, 0xac00, 0xd7a3,
  0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe6f, 0xff00, 0xff60, 0xffe0, 0xffe6,
  0x16fe0, 0x16fe4, 0x17000, 0x18aff, 0x1b000, 0x1b2ff, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf,
  0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f1e6, 0x1f1ff, 0x1f200, 0x1f202, 0x1f210, 0x1f23b,
  0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335,
  0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0,
  0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d,
  0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4,
  0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7,
  0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0,
  0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa89,
  0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf, 0x1fae9, 0x1faf0, 0x1faf8, 0x20000, 0x2fffd,
  0x30000, 0x3fffd,
];

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}​]$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const VS16 = '️';

function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid * 2]!) hi = mid - 1;
    else if (cp > WIDE[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Width of one code point: 0, 1 or 2 cells. Control characters count as 0. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (isWide(cp)) return 2;
  if (ZERO_WIDTH.test(String.fromCodePoint(cp))) return 0;
  return 1;
}

/** Width of one grapheme cluster: 0, 1 or 2 cells. */
export function graphemeWidth(grapheme: string): 0 | 1 | 2 {
  if (grapheme.length === 0) return 0;
  const cp = grapheme.codePointAt(0)!;
  if (grapheme.length === 1) return codePointWidth(cp);
  const base = codePointWidth(cp);
  // "❤" + VS16 asks for emoji presentation, which terminals draw two cells wide.
  if (base === 1 && grapheme.includes(VS16) && PICTOGRAPH.test(grapheme)) return 2;
  return base;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** Split text into grapheme clusters. */
export function graphemes(text: string): string[] {
  if (ASCII_ONLY.test(text)) return text.split('');
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/** Width of a string in cells. Control characters count as 0. */
export function stringWidth(text: string): number {
  if (ASCII_ONLY.test(text)) return text.length;
  let width = 0;
  for (const part of segmenter.segment(text)) width += graphemeWidth(part.segment);
  return width;
}
