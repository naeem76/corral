// Small text helpers for the views.

import path from 'node:path';

/** "now", "5m", "3h", "2d", "4w", "1y". */
export function relativeTime(then: number, now: number): string {
  if (!then) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 365)}y`;
}

/** Replace the home directory with "~" for display. */
export function tildify(p: string, home: string, platform: NodeJS.Platform): string {
  if (!home) return p;
  const a = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => (platform === 'win32' ? s.toLowerCase().replace(/\//g, '\\') : s);
  const h = a.normalize(home).replace(/[\\/]+$/, '');
  if (norm(p) === norm(h)) return '~';
  if (norm(p).startsWith(norm(h) + a.sep)) return '~' + p.slice(h.length);
  return p;
}

/** Remove control characters (an OpenCode title or a branch name could hold escapes). */
export function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
