// Fuzzy subsequence matcher for list filters. Positions are grapheme indexes into the text.
// Smart case: a query with an upper-case letter matches case-sensitively.

import { graphemes } from '../../width.ts';
import type { Frame } from '../frame.ts';
import type { Style } from '../style.ts';

export interface FuzzyMatch {
  score: number;
  /** Grapheme indexes of the matched characters, ascending. */
  positions: number[];
}

const SCORE_MATCH = 16;
const BONUS_START = 12;
const BONUS_BOUNDARY = 10;
const BONUS_CAMEL = 8;
const BONUS_CONSECUTIVE = 10;
const PENALTY_GAP = 1;
const PENALTY_LEADING = 0.5;
// Longer texts use the greedy match only, to keep the cost bounded.
const MAX_DP = 512 * 32;

const SEPARATORS = new Set([' ', '/', '\\', '-', '_', '.', ':', ',', '(', '[', '"', "'"]);

function bonusAt(gs: readonly string[], j: number): number {
  if (j === 0) return BONUS_START;
  const prev = gs[j - 1]!;
  if (SEPARATORS.has(prev)) return BONUS_BOUNDARY;
  const cur = gs[j]!;
  if (prev.toLowerCase() === prev && prev.toUpperCase() !== prev && cur.toUpperCase() === cur && cur.toLowerCase() !== cur) {
    return BONUS_CAMEL;
  }
  return 0;
}

/** Match `query` against `text`. Null when the query is not a subsequence. Empty query matches with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const qg = graphemes(query.trim());
  if (qg.length === 0) return { score: 0, positions: [] };
  const tg = graphemes(text);
  const sensitive = query !== query.toLowerCase();
  const norm = (g: string): string => (sensitive ? g : g.toLowerCase());
  const q = qg.map(norm);
  const t = tg.map(norm);
  const m = q.length;
  const n = t.length;
  if (m > n) return null;

  // Greedy check, also the fallback for long texts.
  const greedy: number[] = [];
  for (let j = 0, i = 0; j < n && i < m; j++) {
    if (t[j] === q[i]) {
      greedy.push(j);
      i++;
    }
  }
  if (greedy.length < m) return null;
  if (m * n > MAX_DP) return { score: scorePositions(tg, greedy), positions: greedy };

  // D[i][j]: best score with q[i] matched at t[j]. From[i][j]: where q[i-1] was matched.
  const NEG = -Infinity;
  const D: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NEG);
    const fr = new Int32Array(n).fill(-1);
    let best = NEG; // max over k <= j-2 of D[i-1][k] + k * PENALTY_GAP
    let bestK = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        const v = D[i - 1]![k]! + k * PENALTY_GAP;
        if (v > best) {
          best = v;
          bestK = k;
        }
      }
      if (t[j] !== q[i]) continue;
      const s = SCORE_MATCH + bonusAt(tg, j);
      if (i === 0) {
        row[j] = s - j * PENALTY_LEADING;
        continue;
      }
      let v = NEG;
      let f = -1;
      if (j >= 1 && D[i - 1]![j - 1]! > NEG) {
        v = D[i - 1]![j - 1]! + BONUS_CONSECUTIVE;
        f = j - 1;
      }
      if (best > NEG) {
        const g = best - (j - 1) * PENALTY_GAP;
        if (g > v) {
          v = g;
          f = bestK;
        }
      }
      if (f >= 0) {
        row[j] = v + s;
        fr[j] = f;
      }
    }
    D.push(row);
    from.push(fr);
  }
  let endJ = -1;
  let score = NEG;
  for (let j = 0; j < n; j++) {
    if (D[m - 1]![j]! > score) {
      score = D[m - 1]![j]!;
      endJ = j;
    }
  }
  if (endJ < 0) return { score: scorePositions(tg, greedy), positions: greedy };
  const positions = new Array<number>(m);
  let j = endJ;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = j;
    j = from[i]![j]!;
  }
  // A small preference for shorter texts among equal matches.
  return { score: score - n * 0.01, positions };
}

function scorePositions(tg: readonly string[], pos: readonly number[]): number {
  let s = 0;
  for (let k = 0; k < pos.length; k++) {
    const j = pos[k]!;
    s += SCORE_MATCH + bonusAt(tg, j);
    if (k === 0) s -= j * PENALTY_LEADING;
    else if (pos[k - 1] === j - 1) s += BONUS_CONSECUTIVE;
    else s -= (j - pos[k - 1]! - 1) * PENALTY_GAP;
  }
  return s - tg.length * 0.01;
}

/** Filter and sort items by match score (best first; ties keep the input order). */
export function fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; i: number }[] = [];
  items.forEach((item, i) => {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match, i });
  });
  if (query.trim().length > 0) out.sort((a, b) => b.match.score - a.match.score || a.i - b.i);
  return out.map(({ item, match }) => ({ item, match }));
}

/** Draw `text` with the matched graphemes in `matchStyle`. Returns the column after the text. */
export function drawHighlighted(
  frame: Frame,
  x: number,
  y: number,
  text: string,
  positions: readonly number[],
  st: Style,
  matchStyle: Style,
  maxWidth = Infinity,
): number {
  const set = new Set(positions);
  const limit = x + maxWidth;
  let cx = x;
  graphemes(text).forEach((g, i) => {
    if (cx < limit) cx = frame.text(cx, y, g, set.has(i) ? matchStyle : st, limit - cx);
  });
  return cx;
}
