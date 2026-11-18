// Remove PTYs that an earlier run of this program left in the service (after a crash or a
// kill). Every PTY we create has the title `nebula-enterprise:<pid>:<sessionId>`; a PTY is
// stale when that pid is no longer alive. PTYs without the prefix are never touched.
//
// `GET /api/pty` lists the PTYs of one location (directory) only; without a location it
// lists the home location. So we list each directory where we may have opened a PTY.

import type { OpenCodeApi } from '../../core/opencode.ts';
import { locationQuery } from '../../core/opencode.ts';

export const PTY_TITLE_PREFIX = 'nebula-enterprise:';

export function ptyTitle(pid: number, sessionId: string): string {
  return `${PTY_TITLE_PREFIX}${pid}:${sessionId}`;
}

/** Pid of the program that created the PTY, or null when the title is not ours. */
export function ptyOwner(title: unknown): number | null {
  if (typeof title !== 'string' || !title.startsWith(PTY_TITLE_PREFIX)) return null;
  const m = /^nebula-enterprise:(\d+):/.exec(title);
  return m ? Number(m[1]) : null;
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface CleanupResult {
  removed: string[];
  /** Directories that still hold PTYs of a live instance; keep them for the next start. */
  busyDirs: string[];
  errors: string[];
}

export async function cleanupStalePtys(
  client: OpenCodeApi,
  directories: readonly string[],
  opts: { pid: number; isAlive: (pid: number) => boolean },
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], busyDirs: [], errors: [] };
  const seen = new Set<string>();
  for (const dir of directories) {
    let list: Array<{ id?: unknown; title?: unknown }>;
    try {
      const r = await client.request<{ data?: Array<{ id?: unknown; title?: unknown }> }>('GET', '/api/pty', {
        query: locationQuery(dir),
        timeoutMs: 5000,
      });
      list = Array.isArray(r?.data) ? r.data : [];
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const p of list) {
      if (typeof p.id !== 'string' || seen.has(p.id)) continue;
      seen.add(p.id);
      const owner = ptyOwner(p.title);
      if (owner === null) continue;
      if (owner === opts.pid || opts.isAlive(owner)) {
        if (!result.busyDirs.includes(dir)) result.busyDirs.push(dir);
        continue;
      }
      try {
        await client.request('DELETE', `/api/pty/${encodeURIComponent(p.id)}`, { query: locationQuery(dir), timeoutMs: 5000 });
        result.removed.push(p.id);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return result;
}
