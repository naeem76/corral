// The inbox model: sections, order and snooze text. Snooze choices are in snooze.ts. Pure functions; the clock
// comes in as `now` (milliseconds since epoch). Local time is read through `Date` only, so the
// result follows the time zone of the machine (and its DST rules) without locale APIs.

import { INBOX_SECTIONS } from '../types.ts';
import type { InboxEntry, InboxInput, InboxSection, SessionMarks } from '../types.ts';

/** A snooze end later than this after now is not real (the "until input" value of an earlier build). */
export const MAX_SNOOZE_MS = 10 * 366 * 86_400_000;

/**
 * The snooze end of the marks, or undefined when there is none or it is not usable: not a
 * finite number, or more than 10 years after now. Such a value counts as no snooze, so no
 * session stays hidden for ever.
 */
export function snoozeEnd(marks: SessionMarks, now: number): number | undefined {
  const u = marks.snoozedUntil;
  return typeof u === 'number' && Number.isFinite(u) && u <= now + MAX_SNOOZE_MS ? u : undefined;
}

/**
 * True when a running snooze ended early (rules: see `InboxSection`): the session needs input,
 * or a turn failed after the snooze was set. A mark without `snoozedAt` (from an earlier
 * build) ends early only for input.
 */
export function snoozeEndedEarly(input: InboxInput): boolean {
  const { row, marks, activity } = input;
  if (row.status === 'needs-input') return true;
  const at = marks.snoozedAt;
  // Not while a turn runs: a state read from the service can still hold the outcome of the
  // turn before, and `activity` is then the start of the new turn.
  return row.outcome === 'failed' && row.status !== 'working' && typeof at === 'number' && activity > at;
}

/** The snooze end when the session is snoozed now, else undefined. */
export function activeSnooze(input: InboxInput, now: number): number | undefined {
  const until = snoozeEnd(input.marks, now);
  return until !== undefined && until > now && !snoozeEndedEarly(input) ? until : undefined;
}

/** The section of one session and whether its snooze ended unseen. Rules: see `InboxSection`. */
export function classify(input: InboxInput, now: number): InboxEntry {
  const { row, marks, activity } = input;
  const until = snoozeEnd(marks, now);
  let section: InboxSection;
  if (row.status === 'needs-input') section = 'needs-input';
  else if (activeSnooze(input, now) !== undefined) section = 'snoozed';
  else if (row.status === 'working') section = 'working';
  // 'unseen' means a turn ended that the user did not see: that is not "done for now".
  else if (marks.settledAt !== undefined && activity <= marks.settledAt && row.status === 'idle') section = 'settled';
  else section = 'open';
  const woke = section !== 'snoozed' && until !== undefined && until <= now && (marks.lastSeen ?? 0) < until;
  return { ...input, section, woke };
}

const ORDER: Record<InboxSection, number> = Object.fromEntries(INBOX_SECTIONS.map((s, i) => [s, i])) as Record<InboxSection, number>;

function byId(a: InboxEntry, b: InboxEntry): number {
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

function compareIn(section: InboxSection, a: InboxEntry, b: InboxEntry): number {
  switch (section) {
    case 'open': {
      const fa = a.woke || a.row.status === 'unseen' ? 0 : 1;
      const fb = b.woke || b.row.status === 'unseen' ? 0 : 1;
      return fa - fb || b.row.updated - a.row.updated;
    }
    case 'snoozed':
      return (a.marks.snoozedUntil ?? 0) - (b.marks.snoozedUntil ?? 0);
    case 'settled':
      return (b.marks.settledAt ?? 0) - (a.marks.settledAt ?? 0);
    default:
      return b.row.updated - a.row.updated;
  }
}

/** All entries, in section order, each section in its own order. */
export function buildInbox(inputs: readonly InboxInput[], now: number): InboxEntry[] {
  const out = inputs.map((i) => classify(i, now));
  out.sort((a, b) => ORDER[a.section] - ORDER[b.section] || compareIn(a.section, a, b) || byId(a, b));
  return out;
}

export interface MarkChange {
  id: string;
  /** A value of `undefined` deletes the key (as `Store.setSessionMeta` does). */
  patch: Partial<SessionMarks>;
}

const CLEAR_SNOOZE: Partial<SessionMarks> = { snoozedUntil: undefined, snoozedAt: undefined };

/**
 * Mark changes the app must store: a snooze that ended early ends for good (the pure rule
 * already moves such a session out of Snoozed; without the change it would go back to Snoozed
 * when the request is answered or a new turn starts), and an unusable snooze value is deleted.
 */
export function marksToClear(inputs: readonly InboxInput[], now: number): MarkChange[] {
  const out: MarkChange[] = [];
  for (const i of inputs) {
    const raw = i.marks.snoozedUntil;
    if (raw === undefined) continue;
    const until = snoozeEnd(i.marks, now);
    if (until === undefined || (until > now && snoozeEndedEarly(i))) out.push({ id: i.row.id, patch: { ...CLEAR_SNOOZE } });
  }
  return out;
}

/** The earliest snooze end later than `now`, or null. */
export function nextWake(entries: readonly InboxInput[], now: number): number | null {
  let best: number | null = null;
  for (const e of entries) {
    const u = snoozeEnd(e.marks, now);
    if (u === undefined || u <= now) continue;
    if (best === null || u < best) best = u;
  }
  return best;
}

// ---- text ------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Whole calendar days from the local day of `a` to the local day of `b`. */
export function dayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  // Round: a day with a DST change is 23 or 25 hours long.
  return Math.round((db - da) / 86_400_000);
}

/** Local time as short text: "14:30", "Tue 09:00", "3 Dec 09:00", "3 Jan 2027 09:00". */
export function formatTime(at: number, now: number): string {
  const t = new Date(at);
  const n = new Date(now);
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const days = dayDiff(n, t);
  if (days === 0) return hm;
  if (days > 0 && days < 7) return `${DAYS[t.getDay()]} ${hm}`;
  const year = t.getFullYear() !== n.getFullYear() ? ` ${t.getFullYear()}` : '';
  return `${t.getDate()} ${MONTHS[t.getMonth()]}${year} ${hm}`;
}

/** Text for a snoozed row: "until 14:30", "until Tue 09:00", "until 3 Dec 09:00". */
export function formatSnooze(until: number, now: number): string {
  return `until ${formatTime(until, now)}`;
}
