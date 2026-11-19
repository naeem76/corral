// The one table of key bindings. The footer hints and the help overlay are both generated
// from it, so what the user reads is what the dispatcher does.
//
// Keys follow the owner's Nebula keymap where the feature is in scope. Every key here must be
// encodable by a legacy terminal (Windows Terminal without the kitty protocol), so no
// Ctrl+Shift+letter and no Cmd.

import type { InputEvent } from '../../types.ts';
import { formatBinding, matches, parseBinding } from '../keys.ts';

/**
 * Where a binding applies. 'columns': every column of the projects view. 'inbox': the list of
 * the inbox view. 'global': the lists of both views.
 */
export type Context = 'global' | 'columns' | 'projects' | 'git' | 'sessions' | 'inbox' | 'pane' | 'browser';

export type ActionId =
  | 'focus-next' | 'focus-prev' | 'focus-left' | 'focus-right' | 'move' | 'half-down' | 'half-up'
  | 'enter' | 'add-project' | 'next-attention' | 'prev-attention' | 'zoom' | 'refresh' | 'help'
  | 'switch-view' | 'quit'
  | 'project-add' | 'project-remove' | 'project-rename' | 'project-down' | 'project-up' | 'project-filter'
  | 'worktree-new' | 'worktree-delete'
  | 'session-new' | 'session-rename' | 'session-archive' | 'session-unarchive' | 'session-delete'
  | 'session-show-archived' | 'session-handoff'
  | 'session-snooze' | 'session-settle' | 'session-unmark' | 'inbox-show-settled' | 'inbox-goto' | 'inbox-pane'
  | 'pane-leave'
  | 'browser-complete' | 'browser-pick' | 'browser-in' | 'browser-up' | 'browser-add' | 'browser-cancel';

export interface BindingDef {
  action: ActionId;
  ctx: Context;
  keys: string[];
  /** Short text for the footer. */
  label: string;
  /** Longer text for the help overlay. */
  help: string;
  /** Shown in the footer of its context. */
  footer?: boolean;
  /** Listed in help only; the list widget or the input handles the keys itself. */
  passive?: boolean;
}

export const DEFAULT_LEAVE_KEY = 'ctrl+q';

/** A leave chord from the store, or the default when it is missing or cannot be parsed. */
export function validLeaveKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_LEAVE_KEY;
  try {
    const b = parseBinding(value.trim());
    // A plain printable key would make the letter impossible to type in OpenCode.
    if (!b.ctrl && !b.alt && [...b.key].length === 1) return DEFAULT_LEAVE_KEY;
    return value.trim();
  } catch {
    return DEFAULT_LEAVE_KEY;
  }
}

export function buildBindings(leaveKey: string = DEFAULT_LEAVE_KEY): BindingDef[] {
  const b = (action: ActionId, ctx: Context, keys: string[], label: string, help: string, extra: Partial<BindingDef> = {}): BindingDef => ({
    action, ctx, keys, label, help, ...extra,
  });
  return [
    // Projects column. Column-specific bindings come before the shared ones: the first match wins.
    b('project-add', 'projects', ['n'], 'add', 'Add a project (a folder, with or without Git)', { footer: true }),
    b('project-remove', 'projects', ['d', 'delete', 'backspace'], 'remove', 'Remove the project from the list (files stay)', { footer: true }),
    b('project-rename', 'projects', ['r'], 'rename', 'Rename the label of the project', { footer: true }),
    b('project-down', 'projects', ['J'], 'move', 'Move the project one place down', { footer: true }),
    b('project-up', 'projects', ['K'], 'move', 'Move the project one place up'),
    b('project-filter', 'projects', ['/'], 'filter', 'Filter the projects (fuzzy); Esc clears', { footer: true }),

    // Git column.
    b('worktree-new', 'git', ['n'], 'new worktree', 'New worktree: a new branch from the default branch, or an existing branch', { footer: true }),
    b('worktree-delete', 'git', ['d', 'delete', 'backspace'], 'delete', 'Delete the worktree (typed confirm; deletes files)', { footer: true }),

    // Sessions column.
    b('session-new', 'sessions', ['n'], 'new', 'New OpenCode session in the selected checkout', { footer: true }),
    b('session-rename', 'sessions', ['r'], 'rename', 'Rename the session', { footer: true }),
    b('session-archive', 'sessions', ['a'], 'archive', 'Archive the session (unarchive when it is archived)', { footer: true }),
    b('session-unarchive', 'sessions', ['u'], 'unarchive', 'Unarchive the session'),
    b('session-delete', 'sessions', ['d', 'delete', 'backspace'], 'delete', 'Delete the session in OpenCode (confirm)', { footer: true }),
    b('session-show-archived', 'sessions', ['A'], 'archived', 'Show or hide archived sessions', { footer: true }),
    b('session-handoff', 'sessions', ['O'], 'full window', 'Open the session in the full window (suspends this program)'),
    b('session-snooze', 'sessions', ['s'], 'snooze', 'Snooze the session (an inbox mark, shown as zz)'),
    b('session-settle', 'sessions', ['e'], 'settle', 'Settle or unsettle the session (an inbox mark, shown as ✓)'),

    // Every column.
    b('enter', 'columns', ['enter'], 'open', 'Drill in; on a session: open it in the pane (also a double click; one click selects)', { footer: true }),
    b('move', 'columns', ['j', 'k', 'down', 'up'], 'move', 'Move the selection (also PgUp/PgDn, Home/End, mouse wheel)', { passive: true }),
    b('half-down', 'columns', ['ctrl+d'], 'half down', 'Half a column down'),
    b('half-up', 'columns', ['ctrl+u'], 'half up', 'Half a column up'),
    b('focus-next', 'columns', ['tab'], 'next', 'Focus the next column (from Sessions: the pane)'),
    b('focus-prev', 'columns', ['shift+tab'], 'previous', 'Focus the previous column'),
    b('focus-left', 'columns', ['h', 'left'], 'left', 'Focus the column at the left'),
    b('focus-right', 'columns', ['l', 'right'], 'right', 'Focus the column at the right (from Sessions: the pane)'),
    b('add-project', 'columns', ['o'], 'add project', 'Add a project from any column'),
    b('next-attention', 'columns', [']'], 'next', 'Next session that needs attention (needs input, working, unseen, rest)', { footer: true }),
    b('prev-attention', 'columns', ['['], 'previous', 'Previous session in attention order'),

    // Inbox view: one list of the sessions of all projects, in sections.
    b('enter', 'inbox', ['enter'], 'open', 'Open the session in the pane and focus it (also a double click; one click selects)', { footer: true }),
    b('move', 'inbox', ['j', 'k', 'down', 'up'], 'move', 'Move the selection; headers are skipped (also PgUp/PgDn, Home/End, wheel)', { passive: true }),
    b('half-down', 'inbox', ['ctrl+d'], 'half down', 'Half a list down'),
    b('half-up', 'inbox', ['ctrl+u'], 'half up', 'Half a list up'),
    b('inbox-pane', 'inbox', ['l', 'right', 'tab'], 'pane', 'Focus the pane when the session is open there'),
    b('session-snooze', 'inbox', ['s'], 'snooze', 'Snooze: hide the session until a time (1-8 a choice, c a custom time)', { footer: true }),
    b('session-settle', 'inbox', ['e'], 'settle', 'Settle ("done for now") or unsettle; new activity brings it back', { footer: true }),
    b('session-unmark', 'inbox', ['u'], 'reopen', 'Back to Open: remove the snooze or the settle mark', { footer: true }),
    b('inbox-show-settled', 'inbox', ['E'], 'settled', 'Show or hide the Settled section'),
    b('session-new', 'inbox', ['n'], 'new', 'New session in the folder of the selected session'),
    b('session-rename', 'inbox', ['r'], 'rename', 'Rename the session (inbox)'),
    b('session-archive', 'inbox', ['a'], 'archive', 'Archive the session; it leaves the inbox'),
    b('session-delete', 'inbox', ['d', 'delete', 'backspace'], 'delete', 'Delete the session in OpenCode and its inbox marks (confirm)'),
    b('session-handoff', 'inbox', ['O'], 'full window', 'Open the session in the full window (inbox)'),
    b('inbox-goto', 'inbox', ['g'], 'go to', 'Show the session in the projects view'),
    b('next-attention', 'inbox', [']'], 'next', 'Next session that wants attention (needs input, then unseen or back), wrapping', { footer: true }),
    b('prev-attention', 'inbox', ['['], 'previous', 'Previous session that wants attention'),

    // Both views.
    b('zoom', 'global', ['z'], 'zoom', 'Zoom: the pane takes the whole window while it has focus'),
    b('refresh', 'global', ['R'], 'refresh', 'Refresh Git status, worktrees, pull requests and sessions'),
    b('switch-view', 'global', ['v'], 'view', 'Switch between the projects view and the inbox view (saved)', { footer: true }),
    b('help', 'global', ['?'], 'help', 'Show this help', { footer: true }),
    b('quit', 'global', ['q', 'ctrl+c'], 'quit', 'Quit (asks first; sessions keep running in OpenCode)', { footer: true }),

    // The pane: everything else goes to OpenCode.
    b('pane-leave', 'pane', [leaveKey], 'leave pane', 'Leave the pane (every other key goes to OpenCode); a click on a column also leaves', { footer: true }),

    // Add-project prompt.
    b('browser-complete', 'browser', ['tab'], 'complete', 'Complete the typed name', { footer: true }),
    b('browser-pick', 'browser', ['down', 'up'], 'pick', 'Pick a folder in the list', { footer: true }),
    b('browser-in', 'browser', ['right'], 'step in', 'Step into the picked folder', { footer: true }),
    b('browser-up', 'browser', ['left'], 'step up', 'Step up to the parent folder', { footer: true }),
    b('browser-add', 'browser', ['enter'], 'add', 'Add the picked (or typed) folder', { footer: true }),
    b('browser-cancel', 'browser', ['escape'], 'cancel', 'Close the prompt', { footer: true }),
  ];
}

/** The first active binding of the given contexts (in order) that matches the event. */
export function findAction(table: readonly BindingDef[], contexts: readonly Context[], ev: InputEvent): ActionId | null {
  if (ev.type !== 'key') return null;
  for (const ctx of contexts) {
    for (const def of table) {
      if (def.ctx !== ctx || def.passive) continue;
      if (matches(ev, def.keys)) return def.action;
    }
  }
  return null;
}

export function keyLabel(def: BindingDef): string {
  // Group "j k ↓ ↑" style lists, but keep the footer short: the first key only.
  return def.keys.map(formatBinding).join(' ');
}

/** The contexts the dispatcher and the footer search, in order, when the keyboard is in `ctx`. */
export function listContexts(ctx: Context): Context[] {
  if (ctx === 'pane' || ctx === 'browser' || ctx === 'global') return [ctx];
  if (ctx === 'inbox') return ['inbox', 'global'];
  if (ctx === 'columns') return ['columns', 'global'];
  return [ctx, 'columns', 'global'];
}

export function footerHints(table: readonly BindingDef[], ctx: Context): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const c of listContexts(ctx)) {
    for (const def of table) {
      if (def.ctx !== c || !def.footer) continue;
      const keys = def.action === 'project-down' ? 'J/K' : formatBinding(def.keys[0] as string);
      out.push({ key: keys, label: def.label });
    }
  }
  return out;
}

export const CONTEXT_TITLES: Record<Context, string> = {
  global: 'Both views',
  inbox: 'Inbox view',
  projects: 'Projects column',
  git: 'Git column',
  sessions: 'Sessions column',
  columns: 'Every column of the projects view',
  pane: 'Pane (OpenCode)',
  browser: 'Add project prompt',
};

/** Lines of the help overlay, grouped by context. */
export function helpLines(table: readonly BindingDef[]): Array<{ heading?: string; key?: string; text?: string }> {
  const out: Array<{ heading?: string; key?: string; text?: string }> = [];
  const order: Context[] = ['global', 'columns', 'projects', 'git', 'sessions', 'inbox', 'pane', 'browser'];
  for (const ctx of order) {
    const defs = table.filter((d) => d.ctx === ctx);
    if (defs.length === 0) continue;
    if (out.length > 0) out.push({});
    out.push({ heading: CONTEXT_TITLES[ctx] });
    for (const d of defs) out.push({ key: keyLabel(d), text: d.help });
  }
  return out;
}
