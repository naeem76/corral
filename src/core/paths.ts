// Path helpers. Every function takes the platform and environment as inputs, so tests
// can check Windows rules on Linux.

import path from 'node:path';

export type Env = Record<string, string | undefined>;

function api(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Read an environment variable. Windows variable names are not case sensitive. */
export function envGet(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== 'win32') return direct === '' ? undefined : direct;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) {
      const v = env[key];
      return v === '' ? undefined : v;
    }
  }
  return undefined;
}

/** Directory of the program's own state (`state.json`). */
export function stateDir(env: Env, platform: NodeJS.Platform, homedir: string): string {
  const p = api(platform);
  const override = envGet(env, 'NEBULA_STATE_DIR', platform);
  if (override) return p.resolve(override);
  if (platform === 'win32') {
    const local = envGet(env, 'LOCALAPPDATA', platform) ?? p.join(homedir, 'AppData', 'Local');
    return p.join(local, 'nebula-enterprise');
  }
  const xdg = envGet(env, 'XDG_STATE_HOME', platform);
  // XDG says a relative value is invalid and must be ignored.
  if (xdg && p.isAbsolute(xdg)) return p.join(xdg, 'nebula-enterprise');
  return p.join(homedir, '.local', 'state', 'nebula-enterprise');
}

/**
 * Normal form of a path for comparison: separators unified, trailing separator removed,
 * and on Windows lower case.
 */
export function pathKey(p: string, platform: NodeJS.Platform): string {
  const a = api(platform);
  let n = a.normalize(p);
  const root = a.parse(n).root;
  while (n.length > root.length && (n.endsWith(a.sep) || (platform === 'win32' && n.endsWith('/')))) {
    n = n.slice(0, -1);
  }
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** True when both strings name the same path (case and separator style ignored on Windows). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Remove a trailing separator, keep everything else. OpenCode matches directories exactly. */
export function trimTrailingSep(p: string, platform: NodeJS.Platform): string {
  const a = api(platform);
  const root = a.parse(p).root;
  let n = p;
  while (n.length > root.length && (n.endsWith('/') || (platform === 'win32' && n.endsWith('\\')))) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * Ordered list of places where the OpenCode service file `service.json` can be.
 * Linux/macOS: verified. Windows: NOT verified, so several candidates are tried.
 */
export function serviceFileCandidates(env: Env, platform: NodeJS.Platform, homedir: string): string[] {
  const p = api(platform);
  const override = envGet(env, 'NEBULA_OPENCODE_SERVICE_FILE', platform);
  if (override) return [p.resolve(override)];
  return opencodeStateDirs(env, platform, homedir).map((d) => p.join(d, 'service.json'));
}

/** Candidate OpenCode state directories, most likely first. */
export function opencodeStateDirs(env: Env, platform: NodeJS.Platform, homedir: string): string[] {
  const p = api(platform);
  const out: string[] = [];
  const xdg = envGet(env, 'XDG_STATE_HOME', platform);
  if (xdg && p.isAbsolute(xdg)) out.push(p.join(xdg, 'opencode'));
  out.push(p.join(homedir, '.local', 'state', 'opencode'));
  if (platform === 'win32') {
    const local = envGet(env, 'LOCALAPPDATA', platform);
    if (local) out.push(p.join(local, 'opencode'));
    const roaming = envGet(env, 'APPDATA', platform);
    if (roaming) out.push(p.join(roaming, 'opencode'));
  }
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = pathKey(d, platform);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Home folder of the GitHub Copilot CLI (holds `session-state/`).
 * `NEBULA_COPILOT_HOME` first (to point this program elsewhere without moving Copilot), then
 * Copilot's own `COPILOT_HOME`, then `~/.copilot`. Copilot ignores the XDG variables.
 */
export function copilotHome(env: Env, platform: NodeJS.Platform, homedir: string): string {
  const p = api(platform);
  const own = envGet(env, 'NEBULA_COPILOT_HOME', platform);
  if (own) return p.resolve(own);
  const cp = envGet(env, 'COPILOT_HOME', platform);
  if (cp) return p.resolve(cp);
  return p.join(homedir, '.copilot');
}
