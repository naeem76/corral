// The "Add project" prompt: a path field with a live directory list under it.
// Type to filter, Tab completes (bash style), ↓/↑ pick, → steps into the picked folder,
// ← steps up, Enter adds the picked (or typed) folder. Git repositories are marked.
//
// Paths follow the host platform: `C:\work\x`, `\\server\share\x` and `/home/x` all work,
// and both separators are accepted on Windows. File system access is injected.

import path from 'node:path';
import { graphemes } from '../../width.ts';
import { trimTrailingSep } from '../../core/paths.ts';
import type { InputEvent } from '../../types.ts';
import { createTextInput, handleTextInput, type TextInputState } from '../widgets/textinput.ts';
import { fuzzyMatch } from '../widgets/fuzzy.ts';

export interface BrowserFs {
  /** Names of the sub-folders of `dir` (symbolic links to folders included). */
  listDirs(dir: string): Promise<string[]>;
  /** True when `dir/.git` exists (a folder or a worktree file). */
  isGitRepo(dir: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
}

export interface BrowserEntry {
  name: string;
  /** Grapheme positions of the matched characters, for highlight. */
  positions: number[];
}

export interface BrowserState {
  input: TextInputState;
  /** The folder whose children are listed (from the typed text). */
  dir: string;
  /** The part after the last separator: the filter. */
  base: string;
  entries: BrowserEntry[];
  /** -1 = nothing picked: Enter adds the typed path. */
  picked: number;
  scrollTop: number;
  loading: boolean;
  /** The folder cannot be read. */
  error: string | null;
  /** Why the last Enter was refused. Cleared by the next edit. */
  notice: string | null;
  /** Folder -> sub-folder names. */
  cache: Map<string, string[] | { error: string }>;
  git: Map<string, boolean>;
}

export interface BrowserEnv {
  platform: NodeJS.Platform;
  homedir: string;
}

function api(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isSep(ch: string, platform: NodeJS.Platform): boolean {
  return ch === '/' || (platform === 'win32' && ch === '\\');
}

/** Expand "~" and make the text absolute where it is clearly meant to be. */
export function expandPath(text: string, env: BrowserEnv): string {
  const p = api(env.platform);
  let t = text;
  if (t === '~' || (t.startsWith('~') && isSep(t[1] ?? '', env.platform))) t = env.homedir + t.slice(1);
  if (env.platform === 'win32' && /^[A-Za-z]:$/.test(t)) t += '\\';
  return t === '' ? '' : p.isAbsolute(t) ? t : t;
}

/** Split typed text into the listed folder and the filter after the last separator. */
export function splitTyped(text: string, env: BrowserEnv): { dir: string; base: string } {
  const p = api(env.platform);
  const t = expandPath(text, env);
  let cut = -1;
  for (let i = t.length - 1; i >= 0; i--) {
    if (isSep(t[i] as string, env.platform)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    // "C:" style without a separator, or a bare name: list the home folder.
    if (env.platform === 'win32' && /^[A-Za-z]:$/.test(t)) return { dir: t + '\\', base: '' };
    return { dir: env.homedir, base: t };
  }
  let dir = t.slice(0, cut + 1);
  // Keep the root separator ("/" or "C:\"), drop a trailing one elsewhere.
  const root = p.parse(dir).root;
  if (dir.length > root.length) dir = dir.replace(/[\\/]+$/, '');
  if (dir === '') dir = env.platform === 'win32' ? '\\' : '/';
  return { dir, base: t.slice(cut + 1) };
}

export function withSep(dir: string, platform: NodeJS.Platform): string {
  const sep = api(platform).sep;
  return isSep(dir[dir.length - 1] ?? '', platform) ? dir : dir + sep;
}

export function createBrowser(start: string, env: BrowserEnv): BrowserState {
  const value = withSep(start || env.homedir, env.platform);
  const { dir, base } = splitTyped(value, env);
  return {
    input: createTextInput(value),
    dir,
    base,
    entries: [],
    picked: -1,
    scrollTop: 0,
    loading: true,
    error: null,
    notice: null,
    cache: new Map(),
    git: new Map(),
  };
}

/** Recompute `dir`, `base` and the filtered entries from the typed text and the cache. */
export function refilter(s: BrowserState, env: BrowserEnv): BrowserState {
  const { dir, base } = splitTyped(s.input.value, env);
  const cached = s.cache.get(dir);
  let entries: BrowserEntry[] = [];
  let error: string | null = null;
  if (Array.isArray(cached)) {
    const showHidden = base.startsWith('.');
    const names = cached.filter((n) => showHidden || !n.startsWith('.'));
    if (base === '') entries = names.map((name) => ({ name, positions: [] }));
    else {
      // Prefix matches first (what Tab completes), then fuzzy matches.
      const lower = base.toLowerCase();
      const pre: BrowserEntry[] = [];
      const fuzzy: Array<BrowserEntry & { score: number }> = [];
      for (const name of names) {
        if (name.toLowerCase().startsWith(lower)) {
          pre.push({ name, positions: [...Array(graphemes(base).length).keys()] });
          continue;
        }
        const m = fuzzyMatch(base, name);
        if (m) fuzzy.push({ name, positions: m.positions, score: m.score });
      }
      fuzzy.sort((a, b) => b.score - a.score);
      entries = [...pre, ...fuzzy.map(({ name, positions }) => ({ name, positions }))];
    }
  } else if (cached) error = cached.error;
  const sameDir = dir === s.dir;
  const picked = sameDir && s.picked >= 0 ? Math.min(s.picked, entries.length - 1) : -1;
  return { ...s, dir, base, entries, error, loading: cached === undefined, picked, scrollTop: sameDir ? s.scrollTop : 0 };
}

/** Load the listing of the current folder when it is not cached. Calls `done` after. */
export async function loadDir(s: BrowserState, fs: BrowserFs): Promise<void> {
  const dir = s.dir;
  if (s.cache.has(dir)) return;
  try {
    const names = await fs.listDirs(dir);
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    s.cache.set(dir, names);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    s.cache.set(dir, { error: code === 'ENOENT' ? 'no such folder' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : String((err as Error).message ?? err) });
  }
}

/** Mark Git repositories among the first `limit` entries. */
export async function loadGitMarks(s: BrowserState, fs: BrowserFs, env: BrowserEnv, limit = 60): Promise<boolean> {
  const p = api(env.platform);
  let changed = false;
  const todo = s.entries.slice(0, limit).map((e) => p.join(s.dir, e.name)).filter((full) => !s.git.has(full));
  await Promise.all(
    todo.map(async (full) => {
      let yes = false;
      try {
        yes = await fs.isGitRepo(full);
      } catch {}
      s.git.set(full, yes);
      if (yes) changed = true;
    }),
  );
  return changed || todo.length > 0;
}

export function entryPath(s: BrowserState, e: BrowserEntry, env: BrowserEnv): string {
  return api(env.platform).join(s.dir, e.name);
}

function setValue(s: BrowserState, value: string, env: BrowserEnv): BrowserState {
  return refilter({ ...s, input: createTextInput(value), picked: -1, notice: null }, env);
}

/** Longest common prefix (case-insensitive compare, case of the first name kept). */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  let pre = names[0] as string;
  for (const n of names) {
    let i = 0;
    while (i < pre.length && i < n.length && pre[i]!.toLowerCase() === n[i]!.toLowerCase()) i++;
    pre = pre.slice(0, i);
  }
  return pre;
}

export type BrowserAction =
  | { kind: 'none' }
  | { kind: 'changed' }
  | { kind: 'cancel' }
  | { kind: 'submit'; path: string };

/** Keys that the browser handles itself (the rest go to the text field). */
export function handleBrowserInput(s: BrowserState, ev: InputEvent, env: BrowserEnv, listRows: number): { state: BrowserState; action: BrowserAction } {
  const p = api(env.platform);
  if (ev.type === 'key' && !ev.ctrl && !ev.alt) {
    switch (ev.key) {
      case 'escape':
        return { state: s, action: { kind: 'cancel' } };
      case 'down':
      case 'up': {
        if (s.entries.length === 0) return { state: s, action: { kind: 'none' } };
        const n = s.entries.length;
        let picked = ev.key === 'down' ? s.picked + 1 : s.picked < 0 ? n - 1 : s.picked - 1;
        if (picked >= n) picked = n - 1;
        if (picked < -1) picked = -1;
        let top = s.scrollTop;
        if (picked >= 0) {
          if (picked < top) top = picked;
          if (picked >= top + listRows) top = picked - listRows + 1;
        }
        return { state: { ...s, picked, scrollTop: Math.max(0, top) }, action: { kind: 'changed' } };
      }
      case 'pagedown':
      case 'pageup': {
        if (s.entries.length === 0) return { state: s, action: { kind: 'none' } };
        const d = ev.key === 'pagedown' ? listRows : -listRows;
        const picked = Math.max(0, Math.min(s.entries.length - 1, (s.picked < 0 ? 0 : s.picked) + d));
        let top = s.scrollTop;
        if (picked < top) top = picked;
        if (picked >= top + listRows) top = picked - listRows + 1;
        return { state: { ...s, picked, scrollTop: Math.max(0, top) }, action: { kind: 'changed' } };
      }
      case 'right': {
        const e = s.entries[s.picked >= 0 ? s.picked : 0];
        if (!e || (s.picked < 0 && s.entries.length !== 1 && s.base === '')) return { state: s, action: { kind: 'none' } };
        return { state: setValue(s, withSep(entryPath(s, e, env), env.platform), env), action: { kind: 'changed' } };
      }
      case 'left': {
        const parent = p.dirname(s.dir);
        if (s.base === '' && parent === s.dir) return { state: s, action: { kind: 'none' } };
        // With a filter typed, ← first drops the filter; then it steps up.
        const target = s.base !== '' ? s.dir : parent;
        return { state: setValue(s, withSep(target, env.platform), env), action: { kind: 'changed' } };
      }
      case 'tab': {
        if (s.entries.length === 0) return { state: s, action: { kind: 'none' } };
        const lower = s.base.toLowerCase();
        const pre = s.entries.filter((e) => e.name.toLowerCase().startsWith(lower)).map((e) => e.name);
        if (pre.length === 1) {
          return { state: setValue(s, withSep(p.join(s.dir, pre[0] as string), env.platform), env), action: { kind: 'changed' } };
        }
        if (pre.length > 1) {
          const common = commonPrefix(pre);
          if (common.length > s.base.length) {
            return { state: setValue(s, withSep(s.dir, env.platform) + common, env), action: { kind: 'changed' } };
          }
          return { state: s, action: { kind: 'none' } };
        }
        // Only fuzzy matches: complete to the best one.
        const best = s.entries[0] as BrowserEntry;
        return { state: setValue(s, withSep(p.join(s.dir, best.name), env.platform), env), action: { kind: 'changed' } };
      }
      case 'enter': {
        if (s.picked >= 0 && s.entries[s.picked]) return { state: s, action: { kind: 'submit', path: entryPath(s, s.entries[s.picked] as BrowserEntry, env) } };
        const typed = expandPath(s.input.value.trim(), env);
        if (typed === '') return { state: s, action: { kind: 'none' } };
        return { state: s, action: { kind: 'submit', path: typed } };
      }
    }
  }
  const r = handleTextInput(s.input, ev);
  if (!r.handled) return { state: s, action: { kind: 'none' } };
  if (r.action === 'cancel') return { state: s, action: { kind: 'cancel' } };
  return { state: refilter({ ...s, input: r.state, notice: null }, env), action: { kind: 'changed' } };
}

/** Resolve what Enter typed: an existing folder, or the first match of the filter. */
export async function resolveSubmit(s: BrowserState, typed: string, fs: BrowserFs, env: BrowserEnv): Promise<string | null> {
  const p = api(env.platform);
  const abs = trimTrailingSep(p.normalize(p.isAbsolute(typed) ? typed : p.join(env.homedir, typed)), env.platform);
  if (await fs.isDir(abs).catch(() => false)) return abs;
  const first = s.entries[0];
  if (first && s.base !== '') return entryPath(s, first, env);
  return null;
}

export function createNodeBrowserFs(): BrowserFs {
  return {
    async listDirs(dir) {
      const { readdir, stat } = await import('node:fs/promises');
      const ents = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      const links: string[] = [];
      for (const e of ents) {
        if (e.isDirectory()) out.push(e.name);
        else if (e.isSymbolicLink()) links.push(e.name);
      }
      await Promise.all(
        links.map(async (n) => {
          try {
            if ((await stat(path.join(dir, n))).isDirectory()) out.push(n);
          } catch {}
        }),
      );
      return out;
    },
    async isGitRepo(dir) {
      const { stat } = await import('node:fs/promises');
      try {
        await stat(path.join(dir, '.git'));
        return true;
      } catch {
        return false;
      }
    },
    async isDir(p) {
      const { stat } = await import('node:fs/promises');
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
