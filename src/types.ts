// Shared contracts between src/core, src/term and src/tui.
//
// Owner: the planner. Do not change this file in a worker task. If a contract
// does not fit, report it and keep a local type in your own module instead.
//
// Only erasable TypeScript is permitted (Node runs these files directly):
// no `enum`, no `namespace`, no constructor parameter properties.

// ---------------------------------------------------------------------------
// Cells and colors (term emulator -> tui renderer)
// ---------------------------------------------------------------------------

/**
 * Color number.
 *   COLOR_DEFAULT (-1)      terminal default foreground or background
 *   0..255                  xterm 256-color palette index
 *   COLOR_RGB | 0xRRGGBB    24-bit color
 */
export type Color = number;
export const COLOR_DEFAULT = -1;
export const COLOR_RGB = 0x1000000;

/** Bit flags for `Cell.attrs`. */
export const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  inverse: 16,
  strike: 32,
  blink: 64,
  hidden: 128,
} as const;

export interface Cell {
  /** One grapheme. Empty string for a blank cell or for the right half of a wide character. */
  ch: string;
  /** 1 = normal, 2 = left half of a wide character, 0 = right half of a wide character. */
  width: number;
  fg: Color;
  bg: Color;
  attrs: number;
}

/** Read-only view of a character grid. The emulator implements it; the renderer copies from it. */
export interface ScreenView {
  readonly cols: number;
  readonly rows: number;
  /** Fill `out` with the cell at column x, row y (both 0-based) and return it. No allocation. */
  readCell(x: number, y: number, out: Cell): Cell;
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
}

// ---------------------------------------------------------------------------
// Terminal emulator (src/term)
// ---------------------------------------------------------------------------

export type MouseTracking = 'none' | 'x10' | 'button' | 'drag' | 'any';

/** Modes that the program inside the pane switched on. The TUI uses them to encode input. */
export interface TermModes {
  readonly altScreen: boolean;
  readonly appCursorKeys: boolean;
  readonly appKeypad: boolean;
  readonly bracketedPaste: boolean;
  readonly focusEvents: boolean;
  readonly mouse: MouseTracking;
  /** SGR mouse encoding (mode 1006). */
  readonly mouseSgr: boolean;
}

export interface Emulator extends ScreenView {
  /** Feed PTY output. Text is already decoded to a JS string. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Called with bytes that must go back to the PTY (answers to terminal queries). */
  onReply: ((data: string) => void) | null;
  readonly modes: TermModes;
  /** Window title set by the program (OSC 0 / OSC 2). Empty when not set. */
  readonly title: string;
  /** Increases each time the visible screen, the cursor or the modes change. */
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Input events (src/tui/input)
// ---------------------------------------------------------------------------

export type InputEvent =
  | {
      type: 'key';
      /**
       * Name of the key. One printable grapheme ("a", "A", "é", "/"), or one of:
       * enter tab backspace escape space up down left right home end pageup pagedown
       * insert delete f1..f12
       */
      key: string;
      ctrl: boolean;
      alt: boolean;
      shift: boolean;
      /** The exact bytes received. The pane sends these to the PTY unchanged. */
      raw: string;
    }
  | {
      type: 'mouse';
      /** 0-based column and row in the full terminal window. */
      x: number;
      y: number;
      button: 'left' | 'middle' | 'right' | 'none';
      action: 'down' | 'up' | 'move' | 'wheel-up' | 'wheel-down';
      ctrl: boolean;
      alt: boolean;
      shift: boolean;
      raw: string;
    }
  | { type: 'paste'; text: string }
  | { type: 'focus'; focused: boolean };

// ---------------------------------------------------------------------------
// Domain (src/core)
// ---------------------------------------------------------------------------

/** A folder that the user added to the Projects column. */
export interface Project {
  /** Stable id made by the store. */
  id: string;
  /** Absolute path, in the form of the host OS. */
  path: string;
  /** Label in the list. Default: last path segment. */
  name: string;
  /** 'git' when the folder is the main checkout of a Git repository, else 'dir'. */
  kind: 'git' | 'dir';
}

/** One row of the Git column: the root checkout, a linked worktree, or the plain folder. */
export interface Checkout {
  /** Absolute path of the working directory. */
  path: string;
  /** Branch name, or null when HEAD is detached or the project is not a Git repository. */
  branch: string | null;
  /** True for the main checkout of the repository and for the single row of a 'dir' project. */
  isRoot: boolean;
  /** Short commit hash. Null for a 'dir' project or an unborn branch. */
  head: string | null;
  /** True when the working tree has changes. Undefined until the check is complete. */
  dirty?: boolean;
  /** Commits ahead of / behind the upstream branch. Undefined when there is no upstream. */
  ahead?: number;
  behind?: number;
  /** True when Git reports the worktree as locked or prunable. */
  locked?: boolean;
  prunable?: boolean;
}

/** A pull request shown below a checkout. Source: a PR provider (Azure DevOps through `az`). */
export interface PullRequest {
  id: string;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  status: 'active' | 'draft' | 'completed' | 'abandoned';
}

/**
 * Status of a session row, in order of attention:
 *   needs-input  a permission request or a form waits for the user
 *   working      a turn is in progress
 *   unseen       the last turn ended after the user last looked at the session
 *   idle         nothing to do
 */
export type SessionStatus = 'needs-input' | 'working' | 'unseen' | 'idle';

/** The agent program that owns a session. */
export type AgentId = 'opencode' | 'copilot';

export const AGENT_NAMES: Record<AgentId, string> = { opencode: 'OpenCode', copilot: 'Copilot' };

export interface SessionRow {
  /**
   * Session id of the agent: OpenCode "ses_...", Copilot a UUID. The two forms cannot
   * collide, so the id alone is the key everywhere (lists, panes, marks in `state.json`).
   */
  id: string;
  agent: AgentId;
  title: string;
  /** Absolute path of the directory the session belongs to. */
  directory: string;
  /** Milliseconds since epoch. */
  created: number;
  updated: number;
  status: SessionStatus;
  archived: boolean;
  /** Result of the last turn, when OpenCode reports one. */
  outcome?: 'succeeded' | 'failed' | 'interrupted';
}

/** What a session source can do. The UI hides or explains an action that is not possible. */
export interface SessionCapabilities {
  /** The title can be changed from this program. */
  rename: boolean;
  /** The session can be deleted from this program. */
  remove: boolean;
  /**
   * 'agent': the agent has its own archive (OpenCode). 'local': the agent has none, so the
   * archive is the mark `archivedAt` in `state.json` (Copilot).
   */
  archive: 'agent' | 'local';
}

/**
 * The sessions of one agent. `src/core/sessions.ts` (OpenCode service) and
 * `src/core/copilot.ts` (Copilot CLI files) implement it; `src/core/session-hub.ts` joins
 * the sources behind the same interface, and the app talks only to the hub.
 * A method that takes an id is a no-op (or rejects, for a Promise) for an unknown id.
 */
export interface SessionSource {
  /** False when the agent cannot be used on this machine now (not installed, service down). */
  readonly available: boolean;
  /** Tells why `available` is false, for the UI. Null when available. */
  readonly unavailableReason: string | null;
  capabilities(agent: AgentId): SessionCapabilities;
  /** Set the directories to follow. New ones are read at once; dropped ones are forgotten. */
  watch(directories: readonly string[]): Promise<void>;
  /** Top-level sessions of a directory, sorted by attention, then by `updated` (newest first). */
  rows(directory: string): SessionRow[];
  /** One row by id, when the source knows the session. */
  row(id: string): SessionRow | undefined;
  /** Start or end of the last turn (see `InboxInput.activity`); 0 when unknown. */
  activity(id: string): number;
  status(id: string): SessionStatus;
  /** The user looked at the session now. */
  markSeen(id: string): void;
  /** Make a session in a directory and return its id. The row exists when the Promise resolves. */
  create(directory: string, title?: string): Promise<string>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Read the state again (all watched directories, or the given ones). */
  refresh(directories?: readonly string[]): Promise<void>;
  onChange(cb: () => void): () => void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Inbox view (src/core/inbox, src/tui/app)
// ---------------------------------------------------------------------------

/**
 * The program's own marks for one session, stored in `state.json` under the session id.
 * The agent knows nothing about them. All times are milliseconds since epoch.
 */
export interface SessionMarks {
  /** When the user last looked at the session in this program. */
  lastSeen?: number;
  /**
   * The session is hidden in the Snoozed section until this time.
   * The mark stays after the time passes, so the inbox can show that the session came back;
   * it is deleted when the user opens the session, snoozes again or removes the snooze.
   * It is deleted at once when the snooze ends early (see `InboxSection`).
   */
  snoozedUntil?: number;
  /** When the user set the snooze. Set and deleted together with `snoozedUntil`. */
  snoozedAt?: number;
  /** Archive mark for an agent that has no archive of its own (see `SessionCapabilities`). */
  archivedAt?: number;
  /**
   * When the user settled the session ("done for now"). It counts only while the session has
   * no activity later than this time, so a settled session comes back by itself.
   */
  settledAt?: number;
}

/**
 * One choice of the snooze menu, the same model as T3 Code:
 *   after  a number of minutes from now
 *   at     a local time of day on a day: 'today', 'tomorrow', or the next such weekday after
 *          today. `time` is 'HH:MM' in 24-hour form.
 * A choice whose time is not later than now is not offered.
 */
export type SnoozeDay = 'today' | 'tomorrow' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type SnoozePreset = { kind: 'after'; minutes: number } | { kind: 'at'; day: SnoozeDay; time: string };

/** The default choices (the defaults of T3 Code). `ui.snoozePresets` in `state.json` replaces them. */
export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
];

/**
 * Sections of the inbox, in display order. A session is in exactly one section.
 * The first rule that matches decides:
 *   needs-input  status 'needs-input' (always; it ends a snooze and overrides settled)
 *   snoozed      `snoozedUntil` is later than now, and the snooze did not end early
 *   working      status 'working'
 *   settled      `settledAt` is set, and the session has no activity later than it
 *   open         every other session
 * A snooze ends early, as in T3 Code, when the session needs input, or when a turn failed
 * after the snooze was set (`outcome` 'failed' and activity later than `snoozedAt`). A turn
 * that ends normally does not end it.
 * Archived sessions and child sessions are not in the inbox.
 */
export type InboxSection = 'needs-input' | 'working' | 'open' | 'snoozed' | 'settled';

export const INBOX_SECTIONS: readonly InboxSection[] = ['needs-input', 'working', 'open', 'snoozed', 'settled'];

/** What the inbox needs to know about one session. */
export interface InboxInput {
  row: SessionRow;
  /** Start or end of the last turn (`max(time.busy, time.idle)` of the session); 0 when none. */
  activity: number;
  marks: SessionMarks;
  project: Project;
  /** Checkout that holds the session, when the project's checkouts are loaded. */
  checkout?: Checkout;
}

export interface InboxEntry extends InboxInput {
  section: InboxSection;
  /** The snooze time passed and the user has not opened the session since. */
  woke: boolean;
}

// ---------------------------------------------------------------------------
// PTY in the OpenCode service (src/core/pty)
// ---------------------------------------------------------------------------

export interface PtySpawn {
  /** Program to start. Always a real executable, never a shell string. */
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  title?: string;
}

export interface PtyHandle {
  /** OpenCode PTY id ("pty_..."). */
  readonly id: string;
  /** Output from the program. Assign before the first data can arrive. */
  onData: ((data: string) => void) | null;
  /** Called one time when the program exits or the connection is lost for good. */
  onExit: ((info: { exitCode: number | null; reason: 'exited' | 'disconnected' | 'closed' }) => void) | null;
  /** Send input to the program. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Close the connection and remove the PTY from the service. Safe to call more than one time. */
  close(): Promise<void>;
}
