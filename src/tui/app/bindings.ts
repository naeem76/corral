// The one table of key bindings. The footer hints and the help overlay are both generated
// from it, so what the user reads is what the dispatcher does.
//
// Keys follow the owner's Nebula keymap where the feature is in scope. Every key here must be
// encodable by a legacy terminal (Windows Terminal without the kitty protocol), so no
// Ctrl+Shift+letter and no Cmd.

import type { InputEvent } from '../../types.ts';
import { formatBinding, matches, parseBinding } from '../keys.ts';

export type Context = 'columns' | 'projects' | 'git' | 'sessions' | 'pane' | 'browser';

export type ActionId =
  | 'focus-next' | 'focus-prev' | 'focus-left' | 'focus-right' | 'move' | 'half-down' | 'half-up'
  | 'enter' | 'add-project' | 'next-attention' | 'prev-attention' | 'zoom' | 'refresh' | 'help'
  | 'switch-view' | 'quit'
  | 'project-add' | 'project-remove' | 'project-rename' | 'project-down' | 'project-up' | 'project-filter'
  | 'worktree-new' | 'worktree-delete'
  | 'session-new' | 'session-rename' | 'session-archive' | 'session-unarchive' | 'session-delete'
  | 'session-show-archived' | 'session-handoff'
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

    // Every column.
    b('enter', 'columns', ['enter'], 'open', 'Drill in; on a session: open it in the pane', { footer: true }),
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
    b('zoom', 'columns', ['z'], 'zoom', 'Zoom: the pane takes the whole window while it has focus'),
    b('refresh', 'columns', ['R'], 'refresh', 'Refresh Git status, worktrees, pull requests and sessions'),
    b('switch-view', 'columns', ['v'], 'view', 'Switch view (inbox: not available yet)'),
    b('help', 'columns', ['?'], 'help', 'Show this help', { footer: true }),
    b('quit', 'columns', ['q', 'ctrl+c'], 'quit', 'Quit (asks first; sessions keep running in OpenCode)', { footer: true }),

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

export function footerHints(table: readonly BindingDef[], ctx: Context): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const order: Context[] = ctx === 'pane' || ctx === 'browser' ? [ctx] : [ctx, 'columns'];
  for (const c of order) {
    for (const def of table) {
      if (def.ctx !== c || !def.footer) continue;
      const keys = def.action === 'project-down' ? 'J/K' : formatBinding(def.keys[0] as string);
      out.push({ key: keys, label: def.label });
    }
  }
  return out;
}

export const CONTEXT_TITLES: Record<Context, string> = {
  projects: 'Projects column',
  git: 'Git column',
  sessions: 'Sessions column',
  columns: 'Every column',
  pane: 'Pane (OpenCode)',
  browser: 'Add project prompt',
};

/** Lines of the help overlay, grouped by context. */
export function helpLines(table: readonly BindingDef[]): Array<{ heading?: string; key?: string; text?: string }> {
  const out: Array<{ heading?: string; key?: string; text?: string }> = [];
  const order: Context[] = ['columns', 'projects', 'git', 'sessions', 'pane', 'browser'];
  for (const ctx of order) {
    const defs = table.filter((d) => d.ctx === ctx);
    if (defs.length === 0) continue;
    if (out.length > 0) out.push({});
    out.push({ heading: CONTEXT_TITLES[ctx] });
    for (const d of defs) out.push({ key: keyLabel(d), text: d.help });
  }
  return out;
}
