// Snooze choices, as in T3 Code: a list of presets (from `ui.snoozePresets` or the defaults),
// resolved against now in local time, and the text form of a custom time. Pure functions; local
// time is read through `Date` only, so DST and month ends follow the machine's time zone.

import type { SnoozeDay, SnoozePreset } from '../types.ts';
import { dayDiff, MAX_SNOOZE_MS } from './inbox.ts';

const MINUTE = 60_000;
const MAX_PRESETS = 8;
const MAX_AFTER_MINUTES = 525_600;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS: readonly SnoozeDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SNOOZE_DAYS: ReadonlySet<string> = new Set<SnoozeDay>(['today', 'tomorrow', ...WEEKDAYS]);

/**
 * A valid preset list (copies of the items), or null. Rules: 1 to 8 items; `after` needs an
 * integer `minutes` from 1 to 525600; `at` needs a known `day` and a `time` 'HH:MM'. One bad
 * item makes the whole list invalid. Unknown extra keys are ignored.
 */
export function parseSnoozePresets(raw: unknown): SnoozePreset[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PRESETS) return null;
  const out: SnoozePreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    if (o.kind === 'after') {
      const m = o.minutes;
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MAX_AFTER_MINUTES) return null;
      out.push({ kind: 'after', minutes: m });
    } else if (o.kind === 'at') {
      if (typeof o.day !== 'string' || !SNOOZE_DAYS.has(o.day)) return null;
      if (typeof o.time !== 'string' || !TIME_RE.test(o.time)) return null;
      out.push({ kind: 'at', day: o.day as SnoozeDay, time: o.time });
    } else return null;
  }
  return out;
}

/** Days from today to the day of an `at` preset: 0, 1, or 1 to 7 for a weekday (never 0). */
function dayOffset(day: SnoozeDay, today: number): number {
  if (day === 'today') return 0;
  if (day === 'tomorrow') return 1;
  return (WEEKDAYS.indexOf(day) - today + 7) % 7 || 7;
}

/** The time of a preset, from `now`. */
export function resolveSnoozePreset(p: SnoozePreset, now: number): number {
  if (p.kind === 'after') return now + p.minutes * MINUTE;
  const d = new Date(now);
  const [h, m] = p.time.split(':').map(Number) as [number, number];
  // The Date constructor carries a day overflow into the next month and year.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset(p.day, d.getDay()), h, m, 0, 0).getTime();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The menu label of a preset (the words of T3 Code). `until` is its resolved time. */
export function snoozeLabel(p: SnoozePreset, until: number, now: number): string {
  if (p.kind === 'after') {
    const m = p.minutes;
    if (m % 1440 === 0) return `In ${plural(m / 1440, 'day')}`;
    if (m % 60 === 0) return `In ${plural(m / 60, 'hour')}`;
    return `In ${plural(m, 'minute')}`;
  }
  const t = new Date(until);
  if (p.day === 'today') {
    const h = t.getHours();
    return h < 12 ? 'This morning' : h < 17 ? 'This afternoon' : 'This evening';
  }
  const days = dayDiff(new Date(now), t);
  if (days === 1) return 'Tomorrow';
  if (p.day === 'monday') return 'Next week';
  const name = DAY_NAMES[t.getDay()] as string;
  return days === 7 ? `Next ${name}` : name;
}

export interface SnoozeChoice {
  preset: SnoozePreset;
  until: number;
  label: string;
}

/**
 * The menu choices: each preset resolved against now; a choice not later than now is dropped,
 * the rest sorted soonest first, and a choice in the same minute as an earlier one is dropped.
 */
export function snoozeChoices(presets: readonly SnoozePreset[], now: number): SnoozeChoice[] {
  const all = presets
    .map((preset) => {
      const until = resolveSnoozePreset(preset, now);
      return { preset, until, label: snoozeLabel(preset, until, now) };
    })
    .filter((c) => c.until > now)
    .sort((a, b) => a.until - b.until);
  const out: SnoozeChoice[] = [];
  for (const c of all) {
    const last = out[out.length - 1];
    if (last && Math.floor(last.until / MINUTE) === Math.floor(c.until / MINUTE)) continue;
    out.push(c);
  }
  return out;
}

/** The forms `parseSnoozeTime` accepts, for an error line. */
export const SNOOZE_TIME_FORMS = 'Use HH:MM, YYYY-MM-DD, YYYY-MM-DD HH:MM, or 30m, 2h, 3d, 1w.';

const UNIT_MS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE, w: 7 * 1440 * MINUTE };

/**
 * A custom snooze time in local time, or null when the text is not one of the forms or the time
 * is not later than now (or too far ahead to be a real snooze):
 *   HH:MM               today at that time, or tomorrow when that time is not later than now
 *   YYYY-MM-DD [HH:MM]  that day at that time (09:00 without a time)
 *   30m, 2h, 3d, 1w     a duration from now (a space before the unit is allowed)
 */
export function parseSnoozeTime(text: string, now: number): number | null {
  const s = text.trim().toLowerCase();
  let at: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    const d = new Date(now);
    at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, 0, 0).getTime();
    if (at <= now) at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, mi, 0, 0).getTime();
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t]+(\d{1,2}):(\d{2}))?$/.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const day = Number(m[3]);
    const h = m[4] === undefined ? 9 : Number(m[4]);
    const mi = m[5] === undefined ? 0 : Number(m[5]);
    if (h > 23 || mi > 59) return null;
    const d = new Date(y, mo, day, h, mi, 0, 0);
    // An impossible date (2026-02-31) rolls into the next month: the fields do not match.
    if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
    at = d.getTime();
  } else if ((m = /^(\d{1,6})\s*([mhdw])$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1) return null;
    at = now + n * (UNIT_MS[m[2] as string] as number);
  }
  if (at === null || at <= now || at > now + MAX_SNOOZE_MS) return null;
  return at;
}
