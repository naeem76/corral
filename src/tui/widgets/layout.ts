// Split rectangles into columns or rows, and hit tests.

import type { Rect } from '../frame.ts';

export type { Rect };

/**
 * Size of one part of a split.
 *   number                      fixed cells
 *   { min, max, weight }        flexible: gets `min` first, then a share of the rest by
 *                               `weight` (default 1), never more than `max`
 */
export type SizeSpec = number | { min?: number; max?: number; weight?: number };

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Shrink a rectangle by `n` cells on every side (or by top/right/bottom/left). */
export function inset(r: Rect, top: number, right = top, bottom = top, left = right): Rect {
  return rect(r.x + left, r.y + top, r.w - left - right, r.h - top - bottom);
}

/**
 * Split `total` cells into parts. Fixed sizes come first, then each flexible part gets its
 * minimum, then the rest goes by weight. When the space is too small, parts at the end shrink
 * first. The result always sums to at most `total`.
 */
export function splitSizes(total: number, specs: readonly SizeSpec[], gap = 0): number[] {
  const n = specs.length;
  const sizes = new Array<number>(n).fill(0);
  let free = Math.max(0, total - gap * Math.max(0, n - 1));
  // Fixed and minimum parts, in order, until the space runs out.
  for (let i = 0; i < n; i++) {
    const s = specs[i]!;
    const want = typeof s === 'number' ? s : (s.min ?? 0);
    const got = Math.max(0, Math.min(free, Math.floor(want)));
    sizes[i] = got;
    free -= got;
  }
  // Weighted share of what is left, repeated while a part hits its maximum.
  let active = specs.map((s, i) => (typeof s === 'number' ? -1 : i)).filter((i) => i >= 0);
  while (free > 0 && active.length > 0) {
    const weights = active.map((i) => Math.max(0, (specs[i] as { weight?: number }).weight ?? 1));
    const sumW = weights.reduce((a, b) => a + b, 0);
    if (sumW <= 0) break;
    const shares = active.map((_, k) => Math.floor((free * weights[k]!) / sumW));
    let rest = free - shares.reduce((a, b) => a + b, 0);
    // Leftover cells go to the parts with the largest weights first, then from the end.
    const order = active.map((_, k) => k).sort((a, b) => weights[b]! - weights[a]! || b - a);
    for (const k of order) {
      if (rest <= 0) break;
      if (weights[k]! > 0) {
        shares[k]!++;
        rest--;
      }
    }
    let capped = false;
    const nextActive: number[] = [];
    let used = 0;
    active.forEach((i, k) => {
      const spec = specs[i] as { max?: number };
      const max = spec.max ?? Infinity;
      const add = Math.min(shares[k]!, Math.max(0, max - sizes[i]!));
      if (add < shares[k]!) capped = true;
      sizes[i]! += add;
      used += add;
      if (sizes[i]! < max) nextActive.push(i);
    });
    free -= used;
    if (!capped) break;
    active = nextActive;
  }
  return sizes;
}

/** Split a rectangle into side-by-side columns. */
export function splitColumns(r: Rect, specs: readonly SizeSpec[], gap = 0): Rect[] {
  const sizes = splitSizes(r.w, specs, gap);
  const out: Rect[] = [];
  let x = r.x;
  for (const w of sizes) {
    out.push(rect(x, r.y, w, r.h));
    x += w + gap;
  }
  return out;
}

/** Split a rectangle into stacked rows. */
export function splitRows(r: Rect, specs: readonly SizeSpec[], gap = 0): Rect[] {
  const sizes = splitSizes(r.h, specs, gap);
  const out: Rect[] = [];
  let y = r.y;
  for (const h of sizes) {
    out.push(rect(r.x, y, r.w, h));
    y += h + gap;
  }
  return out;
}

/** A rectangle of size w×h centered in `outer`, clamped to fit. */
export function centerRect(outer: Rect, w: number, h: number): Rect {
  const cw = Math.max(0, Math.min(w, outer.w));
  const ch = Math.max(0, Math.min(h, outer.h));
  return rect(outer.x + Math.floor((outer.w - cw) / 2), outer.y + Math.floor((outer.h - ch) / 2), cw, ch);
}
