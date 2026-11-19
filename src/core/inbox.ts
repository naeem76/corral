// The inbox model: sections, order, snooze presets and snooze text. Pure functions; the clock
// comes in as `now` (milliseconds since epoch). Local time is read through `Date` only, so the
// result follows the time zone of the machine (and its DST rules) without locale APIs.

import { INBOX_SECTIONS, SNOOZE_UNTIL_INPUT } from '../types.ts';
import type { InboxEntry, InboxInput, InboxSection, SessionMarks } from '../types.ts';

/** The section of one session and whether its snooze ended unseen. Rules: see `InboxSection`. */
export function classify(input: InboxInput, now: number): InboxEntry {
  const { row, marks, activity } = input;
  const until = marks.snoozedUntil;
  let section: InboxSection;
  if (row.status === 'needs-input') section = 'needs-input';
  else if (until !== undefined && until > now) section = 'snoozed';
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
      return (a.marks.snoozedUntil ?? SNOOZE_UNTIL_INPUT) - (b.marks.snoozedUntil ?? SNOOZE_UNTIL_INPUT);
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

/**
 * Mark changes the app must store: a request for input ends a running snooze for good.
 * (The pure rule already puts such a session in Needs input; without the change it would go
 * back to Snoozed when the request is answered.)
 */
export function marksToClear(inputs: readonly InboxInput[], now: number): MarkChange[] {
  const out: MarkChange[] = [];
  for (const i of inputs) {
    const until = i.marks.snoozedUntil;
    if (i.row.status === 'needs-input' && until !== undefined && until > now) out.push({ id: i.row.id, patch: { snoozedUntil: undefined } });
  }
  return out;
}

/** The earliest snooze end later than `now` (a real time, not "until input"), or null. */
export function nextWake(entries: readonly InboxInput[], now: number): number | null {
  let best: number | null = null;
  for (const e of entries) {
    const u = e.marks.snoozedUntil;
    if (u === undefined || u <= now || u >= SNOOZE_UNTIL_INPUT) continue;
    if (best === null || u < best) best = u;
  }
  return best;
}

// ---- snooze presets --------------------------------------------------------

export type SnoozePresetId = 'hour' | 'three-hours' | 'tomorrow' | 'monday' | 'input';

export interface SnoozePreset {
  id: SnoozePresetId;
  /** The key in the snooze menu. */
  key: string;
  label: string;
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: 'hour', key: '1', label: '1 hour' },
  { id: 'three-hours', key: '3', label: '3 hours' },
  { id: 'tomorrow', key: 't', label: 'Tomorrow 09:00' },
  { id: 'monday', key: 'w', label: 'Next Monday 09:00' },
  { id: 'input', key: 'i', label: 'Until it needs input' },
];

const HOUR = 3_600_000;

/** The `snoozedUntil` value of a preset. Calendar presets use local time. */
export function snoozeUntil(id: SnoozePresetId, now: number): number {
  const d = new Date(now);
  switch (id) {
    case 'hour':
      return now + HOUR;
    case 'three-hours':
      return now + 3 * HOUR;
    case 'tomorrow':
      // The Date constructor carries a day overflow into the next month and year.
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0, 0).getTime();
    case 'monday': {
      // Days to the next Monday; on a Monday that is the Monday of next week.
      const days = (8 - d.getDay()) % 7 || 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 9, 0, 0, 0).getTime();
    }
    case 'input':
      return SNOOZE_UNTIL_INPUT;
  }
}

// ---- text ------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Whole calendar days from the local day of `a` to the local day of `b`. */
function dayDiff(a: Date, b: Date): number {
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

/** Text for a snoozed row: "until 14:30", "until Tue 09:00", "until 3 Dec 09:00", "until input". */
export function formatSnooze(until: number, now: number): string {
  if (until >= SNOOZE_UNTIL_INPUT) return 'until input';
  return `until ${formatTime(until, now)}`;
}
