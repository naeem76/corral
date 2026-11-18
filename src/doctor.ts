// `doctor`: check this machine and print a report that is safe to paste into a chat.
//
// The owner runs it on a locked-down Windows machine that nobody else can reach, so one run
// must answer every "does X work here?" question. Rules:
// - Never print the service password, the authorization header, tokens, or environment values
//   other than TERM, COLORTERM and TERM_PROGRAM. A final scrub removes the secrets again from
//   every output string, in case an error message carried one.
// - Every check has a timeout and runs even when earlier checks failed; a check that depends
//   on a failed one is SKIP with the reason.
// - Live checks change only what they create, in a new scratch directory, and clean up.
// - Plain ASCII layout (no box drawing), so the output survives copy/paste from PowerShell.

import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InputEvent, Project } from './types.ts';
import { describeResolveFailure, resolveExecutable, run as defaultRun, type ResolveResult, type Runner } from './core/exe.ts';
import { discoverService, OpenCodeClient, OpenCodeError, type OpenCodeApi, type ServiceInfo } from './core/opencode.ts';
import { subscribeEvents } from './core/events.ts';
import { openPty, type WsFactory } from './core/pty.ts';
import { createGit } from './core/git.ts';
import { samePath, serviceFileCandidates, stateDir, type Env } from './core/paths.ts';
import { createAzurePrProvider, type AzurePrProvider } from './core/pr-azure.ts';
import { detectColorDepth } from './tui/style.ts';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckResult {
  group: string;
  name: string;
  status: Status;
  /** One line. */
  detail: string;
  /** One line: what to do. Only for non-PASS results. */
  fix?: string;
  /** Extra indented lines (for example each service.json candidate). */
  notes?: string[];
}

export interface DoctorStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(s: string): unknown;
}

/** Everything with a side effect. Tests replace parts of it. */
export interface DoctorDeps {
  env: Env;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  osVersion: string;
  homedir: string;
  tmpdir: string;
  nodeVersion: string;
  typescript: unknown;
  hasWebSocket: boolean;
  hasFetch: boolean;
  execPath: string;
  stdin: { isTTY?: boolean };
  stdout: DoctorStream;
  resolve: (name: string) => ResolveResult;
  run: Runner;
  exists: (p: string) => Promise<boolean>;
  discover: () => Promise<ServiceInfo | null>;
  fetch: typeof fetch;
  webSocket?: WsFactory;
  azure: () => AzurePrProvider;
  /** The interactive `--keys` check. */
  keys: (deps: DoctorDeps) => Promise<CheckResult[]>;
  now: () => number;
  /** Multiplies every timeout. Tests use a small value. */
  timeScale: number;
  version: string;
}

export interface DoctorFlags {
  json: boolean;
  fullPaths: boolean;
  keys: boolean;
  opencodePty: boolean;
  only: Set<string> | null;
  help: boolean;
}

export const GROUPS = ['runtime', 'terminal', 'cli', 'service', 'events', 'pty', 'sessions', 'git', 'azure', 'state'] as const;

const TITLES: Record<string, string> = {
  runtime: 'Runtime',
  terminal: 'Terminal',
  cli: 'OpenCode CLI',
  service: 'OpenCode service',
  events: 'Events',
  pty: 'PTY',
  sessions: 'Sessions',
  git: 'Git',
  azure: 'Azure DevOps',
  state: 'State',
  cleanup: 'Cleanup',
};

/** Operations of the service that this program uses. */
export const REQUIRED_OPERATIONS = [
  'session.list', 'session.active', 'session.create', 'session.update', 'session.remove',
  'permission.request.list', 'form.list', 'event.subscribe',
  'pty.create', 'pty.update', 'pty.remove', 'pty.connect',
] as const;

const USAGE = `Usage: node src/main.ts doctor [options]

Checks this machine and prints a report that is safe to paste into a chat.

Options:
  --json            print the results as JSON
  --full-paths      do not replace the home folder with ~
  --keys            also run the interactive keyboard/mouse/paste check
  --opencode-pty    also start the real OpenCode TUI in a PTY for a few seconds
  --only <groups>   run only these groups (comma list): ${GROUPS.join(',')}
  -h, --help        show this text
`;

export function parseFlags(args: string[]): DoctorFlags | string {
  const f: DoctorFlags = { json: false, fullPaths: false, keys: false, opencodePty: false, only: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--json') f.json = true;
    else if (a === '--full-paths') f.fullPaths = true;
    else if (a === '--keys') f.keys = true;
    else if (a === '--opencode-pty') f.opencodePty = true;
    else if (a === '-h' || a === '--help') f.help = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a === '--only' ? args[++i] : a.slice(7);
      if (!v) return '--only needs a list of groups';
      const set = new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
      for (const g of set) if (!(GROUPS as readonly string[]).includes(g)) return `unknown group: ${g}`;
      f.only = set;
    } else return `unknown option: ${a}`;
  }
  return f;
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export function defaultDeps(): DoctorDeps {
  const env = process.env;
  const platform = process.platform;
  return {
    env,
    platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : '',
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    nodeVersion: process.versions.node,
    typescript: (process.features as unknown as Record<string, unknown>).typescript,
    hasWebSocket: typeof (globalThis as Record<string, unknown>).WebSocket === 'function',
    hasFetch: typeof globalThis.fetch === 'function',
    execPath: process.execPath,
    stdin: process.stdin,
    stdout: process.stdout,
    resolve: (name) => resolveExecutable(name, { env, platform }),
    run: defaultRun,
    exists: async (p) => {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    },
    discover: () => discoverService({ env, platform }),
    fetch: globalThis.fetch,
    azure: () => createAzurePrProvider({ env, platform }),
    keys: (d) => runKeysCheck(d),
    now: Date.now,
    timeScale: 1,
    version: readVersion(),
  };
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

type Outcome = Omit<CheckResult, 'group' | 'name'>;

const pass = (detail: string, notes?: string[]): Outcome => ({ status: 'PASS', detail, notes });
const warn = (detail: string, fix: string, notes?: string[]): Outcome => ({ status: 'WARN', detail, fix, notes });
const fail = (detail: string, fix: string, notes?: string[]): Outcome => ({ status: 'FAIL', detail, fix, notes });
const skip = (detail: string): Outcome => ({ status: 'SKIP', detail });

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new TimeoutError(`${label}: no answer within ${Math.round(ms / 100) / 10} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

class Report {
  results: CheckResult[] = [];
  #group = '';
  #scale: number;
  constructor(scale: number) {
    this.#scale = scale;
  }
  group(g: string): void {
    this.#group = g;
  }
  add(name: string, o: Outcome): Outcome {
    this.results.push({ group: this.#group, name, ...o });
    return o;
  }
  /** Run one check with a timeout. A throw or a timeout becomes FAIL. */
  async check(name: string, timeoutMs: number, fn: () => Promise<Outcome> | Outcome, fix = 'see the message'): Promise<Outcome> {
    let o: Outcome;
    try {
      o = await withTimeout(Promise.resolve().then(fn), timeoutMs * this.#scale, name);
    } catch (err) {
      o = fail(errText(err), err instanceof TimeoutError ? 'check whether the program or service hangs; send this output back' : fix);
    }
    return this.add(name, o);
  }
}

// ---------------------------------------------------------------------------
// Shared state between groups (each piece computed once, on demand)
// ---------------------------------------------------------------------------

interface Ctx {
  d: DoctorDeps;
  flags: DoctorFlags;
  r: Report;
  /** Secrets seen during the run; scrubbed from the output. */
  secrets: Set<string>;
  cli: Promise<{ path: string | null; version: string | null; reason: string }> | null;
  service: Promise<{ info: ServiceInfo; client: OpenCodeClient } | { error: string }> | null;
  auth: Promise<string | null> | null;
  serviceVersion: Promise<string | null> | null;
  scratch: Promise<string> | null;
  scratchDirs: string[];
}

function ms(ctx: Ctx, n: number): number {
  return n * ctx.d.timeScale;
}

function getCli(ctx: Ctx) {
  ctx.cli ??= (async () => {
    const r = ctx.d.resolve('opencode');
    if (!r.ok) return { path: null, version: null, reason: describeResolveFailure('opencode', r) };
    const v = await ctx.d.run(r.path, ['--version'], { timeoutMs: ms(ctx, 15_000) });
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(v.stdout);
    return { path: r.path, version: v.code === 0 && m ? (m[1] as string) : null, reason: v.error?.message ?? (v.stderr.trim().split(/\r?\n/).pop() || `exit code ${v.code}`) };
  })();
  return ctx.cli;
}

function getService(ctx: Ctx) {
  ctx.service ??= (async () => {
    let info: ServiceInfo | null;
    try {
      info = await withTimeout(ctx.d.discover(), ms(ctx, 5000), 'service discovery');
    } catch (err) {
      return { error: errText(err) };
    }
    if (!info) return { error: 'the OpenCode service is not running (no service.json found)' };
    if (info.password) {
      ctx.secrets.add(info.password);
      const auth = Buffer.from('opencode:' + info.password).toString('base64');
      ctx.secrets.add(auth);
      ctx.secrets.add('Basic ' + auth);
    }
    const found = info;
    const client = new OpenCodeClient({ discover: async () => found, fetch: ctx.d.fetch });
    return { info, client };
  })();
  return ctx.service;
}

/** Null when an authenticated request works, else the reason. */
function getAuth(ctx: Ctx) {
  ctx.auth ??= (async () => {
    const s = await getService(ctx);
    if ('error' in s) return s.error;
    try {
      await s.client.request('GET', '/api/session/active', { timeoutMs: ms(ctx, 8000) });
      return null;
    } catch (err) {
      return errText(err);
    }
  })();
  return ctx.auth;
}

/** Version from `GET /api/info`, else from service.json. */
function getServiceVersion(ctx: Ctx) {
  ctx.serviceVersion ??= (async () => {
    const s = await getService(ctx);
    if ('error' in s) return null;
    try {
      const v = await s.client.request<{ version?: unknown }>('GET', '/api/info', { timeoutMs: ms(ctx, 5000) });
      if (typeof v?.version === 'string' && v.version) return v.version;
    } catch {}
    return s.info.version ?? null;
  })();
  return ctx.serviceVersion;
}

function getScratch(ctx: Ctx) {
  ctx.scratch ??= (async () => {
    const dir = await fsp.mkdtemp(path.join(ctx.d.tmpdir, 'nebula-doctor-'));
    ctx.scratchDirs.push(dir);
    // OpenCode keys sessions by the directory string; use the canonical form.
    return fsp.realpath(dir).catch(() => dir);
  })();
  return ctx.scratch;
}

const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

async function groupRuntime(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('Node.js version', 1000, () => {
    const major = parseInt(d.nodeVersion, 10);
    return major >= 26 ? pass(`v${d.nodeVersion}`) : fail(`v${d.nodeVersion} (needs 26 or later)`, 'install Node.js 26 and run with it');
  });
  await r.check('TypeScript type stripping', 1000, () =>
    d.typescript ? pass(`process.features.typescript = ${String(d.typescript)}`) : fail('not available in this Node.js', 'use Node.js 26 (it runs .ts files directly)'),
  );
  await r.check('Platform', 1000, () => pass(`${d.platform} ${d.arch}, release ${d.osRelease}${d.osVersion ? `, ${d.osVersion}` : ''}`));
  await r.check('Built-in WebSocket and fetch', 1000, () => {
    const miss = [d.hasWebSocket ? '' : 'WebSocket', d.hasFetch ? '' : 'fetch'].filter(Boolean);
    return miss.length === 0 ? pass('both present') : fail(`missing: ${miss.join(', ')}`, 'use Node.js 26');
  });
}

async function groupTerminal(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('stdin / stdout are terminals', 1000, () => {
    const i = !!d.stdin.isTTY;
    const o = !!d.stdout.isTTY;
    const text = `stdin ${i ? 'yes' : 'no'}, stdout ${o ? 'yes' : 'no'}`;
    return i && o ? pass(text) : warn(text, 'normal when the output is redirected to a file; the TUI itself needs a real terminal window');
  });
  await r.check('Window size', 1000, () =>
    d.stdout.columns && d.stdout.rows ? pass(`${d.stdout.columns} x ${d.stdout.rows}`) : warn('unknown (stdout is not a terminal)', 'run in Windows Terminal without redirection to see it'),
  );
  await r.check('Terminal variables', 1000, () => {
    const show = (n: string) => `${n}=${d.env[n] ?? '(unset)'}`;
    return pass(`${show('TERM')}, ${show('COLORTERM')}, ${show('TERM_PROGRAM')}, WT_SESSION ${d.env.WT_SESSION ? 'present' : 'absent'}`);
  });
  await r.check('Color depth the program will use', 1000, () => pass(detectColorDepth(d.env)));
  if (!ctx.flags.keys) {
    r.add('Keys, mouse, paste, resize', skip('interactive; run `doctor --keys` in Windows Terminal'));
  } else if (!d.stdin.isTTY || !d.stdout.isTTY) {
    r.add('Keys, mouse, paste, resize', skip('stdin or stdout is not a terminal'));
  } else {
    let list: CheckResult[];
    try {
      list = await d.keys(d);
    } catch (err) {
      list = [{ group: '', name: 'Keys, mouse, paste, resize', status: 'FAIL', detail: errText(err), fix: 'send this output back' }];
    }
    for (const c of list) r.add(c.name, { status: c.status, detail: c.detail, fix: c.fix, notes: c.notes });
  }
}

async function groupCli(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('opencode on PATH', 3000, () => {
    const res = d.resolve('opencode');
    if (res.ok) return pass(res.path);
    if (res.reason === 'shim') {
      return warn(
        `only a script shim: ${res.path} (a .cmd/.ps1 shim needs a shell; cmd.exe is disabled)`,
        'put the folder of the real opencode.exe on PATH (with npm it is inside node_modules\\opencode-windows-x64\\bin), or install the standalone opencode.exe',
      );
    }
    return fail('not found on PATH', 'install OpenCode 2.x and put the folder of opencode.exe on PATH');
  });
  await r.check('opencode --version', 20_000, async () => {
    const c = await getCli(ctx);
    if (!c.path) return skip(c.reason);
    return c.version ? pass(c.version) : fail(`no version: ${c.reason}`, 'run `opencode --version` by hand and send the output');
  });
}

async function groupService(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('service.json location', 5000, async () => {
    const cands = serviceFileCandidates(d.env, d.platform, d.homedir);
    const notes: string[] = [];
    let found: string | null = null;
    for (const c of cands) {
      const ok = await d.exists(c);
      if (ok && !found) found = c;
      notes.push(`${ok ? 'exists ' : 'missing'}  ${c}${ok && found === c ? '   <- used' : ''}`);
    }
    if (d.env.NEBULA_OPENCODE_URL) return pass('NEBULA_OPENCODE_URL is set; the service file is not used', notes);
    if (found) return pass(`found: ${found}`, notes);
    return fail('no service.json in any known place', 'run `opencode service start`, then run doctor again; if it still fails, find service.json and set NEBULA_OPENCODE_SERVICE_FILE', notes);
  });
  await r.check('Environment overrides', 1000, () => {
    const names = Object.keys(d.env).filter((k) => /^NEBULA_/i.test(k)).sort();
    return pass(names.length ? `in use (names only): ${names.join(', ')}` : 'none');
  });
  const svc = await getService(ctx);
  await r.check('Service reachable', 8000, async () => {
    if ('error' in svc) return fail(svc.error, 'run `opencode service start`');
    const res = await d.fetch(svc.info.url + '/api/session/active', { signal: AbortSignal.timeout(ms(ctx, 5000)) }).catch((err: unknown) => {
      const e = err as { cause?: { code?: string } };
      throw new Error(`cannot connect to ${svc.info.url} (${e.cause?.code ?? errText(err)})`);
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) return pass(`${svc.info.url} (answers 401 without the password, as expected)`);
    if (res.ok) return warn(`${svc.info.url} answers without a password`, 'the service should require a password; send this output back');
    return warn(`${svc.info.url} answers HTTP ${res.status}`, 'send this output back');
  });
  await r.check('Authenticated request', 10_000, async () => {
    if ('error' in svc) return skip('service not found');
    const err = await getAuth(ctx);
    if (err) return fail(err, 'the password in service.json does not work; restart the OpenCode service yourself, then run doctor again');
    const v = await svc.client.request<{ data?: Record<string, unknown> }>('GET', '/api/session/active', { timeoutMs: ms(ctx, 8000) });
    return pass(`GET /api/session/active works; ${Object.keys(v?.data ?? {}).length} session(s) running now`);
  });
  await r.check('Service version vs CLI version', 20_000, async () => {
    if ('error' in svc) return skip('service not found');
    const cli = await getCli(ctx);
    const sv = await getServiceVersion(ctx);
    if (!sv) return skip('service version unknown');
    if (!cli.version) return skip(`service ${sv}; CLI version unknown`);
    const a = sv.replace(/^v/, '');
    const b = cli.version.replace(/^v/, '');
    if (a === b) return pass(`both ${a}`);
    return warn(`service ${a}, CLI ${b}`, 'starting the OpenCode TUI with a different CLI version restarts the service; update so both match');
  });
  await r.check('Projects (GET /api/project)', 10_000, async () => {
    if ((await getAuth(ctx)) !== null) return skip('authenticated request failed');
    if ('error' in svc) return skip('service not found');
    const v = await svc.client.request<unknown>('GET', '/api/project', { timeoutMs: ms(ctx, 8000) });
    const list = Array.isArray(v) ? v : Array.isArray((v as { data?: unknown })?.data) ? (v as { data: unknown[] }).data : null;
    return list ? pass(`${list.length} project(s)`) : warn('unexpected answer shape', 'send this output back');
  });
  await r.check('OpenAPI operations', 15_000, async () => {
    if ('error' in svc) return skip('service not found');
    const conn = await svc.client.connection();
    const tried: string[] = [];
    for (const p of ['/openapi.json', '/api/openapi.json', '/doc/openapi.json']) {
      let res: Response;
      try {
        res = await d.fetch(conn.url + p, { headers: { authorization: conn.authorization, accept: 'application/json' }, signal: AbortSignal.timeout(ms(ctx, 8000)) });
      } catch (err) {
        tried.push(`${p}: ${errText(err)}`);
        continue;
      }
      const text = await res.text();
      let doc: { paths?: Record<string, Record<string, { operationId?: string }>>; info?: { version?: string } };
      try {
        doc = JSON.parse(text) as typeof doc;
      } catch {
        tried.push(`${p}: HTTP ${res.status}, not JSON`);
        continue;
      }
      if (!res.ok || !doc.paths) {
        tried.push(`${p}: HTTP ${res.status}`);
        continue;
      }
      const ops = new Set<string>();
      for (const m of Object.values(doc.paths)) for (const o of Object.values(m ?? {})) if (o && typeof o.operationId === 'string') ops.add(o.operationId);
      const missing = REQUIRED_OPERATIONS.filter((o) => !ops.has(o));
      const where = `${p} (${ops.size} operations${doc.info?.version ? `, API ${doc.info.version}` : ''})`;
      if (missing.length === 0) return pass(`all ${REQUIRED_OPERATIONS.length} needed operations present in ${where}`);
      return fail(`missing in ${where}: ${missing.join(', ')}`, 'this OpenCode version lacks API parts the program needs; send this output back');
    }
    return warn(`no OpenAPI document found (${tried.join('; ')})`, 'send this output back');
  });
}

async function groupEvents(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('Event stream (GET /api/event)', 12_000, async () => {
    const svc = await getService(ctx);
    if ('error' in svc) return skip('service not found');
    if ((await getAuth(ctx)) !== null) return skip('authenticated request failed');
    const t0 = d.now();
    let connected = -1;
    let lastErr = '';
    const sub = subscribeEvents(svc.client, {
      onEvent: () => {},
      onConnect: () => {
        if (connected < 0) connected = d.now() - t0;
      },
      onError: (e) => (lastErr = e.message),
      fetch: d.fetch,
    });
    try {
      await waitUntil(() => connected >= 0, ms(ctx, 8000));
    } finally {
      sub.close();
    }
    if (connected >= 0) return pass(`connected in ${connected} ms`);
    return fail(`not connected within ${8 * d.timeScale} s${lastErr ? `: ${lastErr}` : ''}`, 'send this output back');
  });
}

// The PTY probe program. No spaces, double quotes or backslashes, so no command-line quoting
// rule on any platform can change it. Prints a marker and its size, echoes one input line,
// then reports the size once it changes (or after 8 s) and exits with code 7.
const PTY_SCRIPT = [
  'o=process.stdout;N=String.fromCharCode(13,10);',
  'w=()=>o.getWindowSize?o.getWindowSize():[o.columns,o.rows];s=w();',
  "o.write('NEBULA-DOCTOR-READY:'+s[0]+'x'+s[1]+N);",
  "b='';e=0;process.stdin.setEncoding('utf8');",
  'process.stdin.on(\'data\',d=>{if(e)return;b+=d;',
  'k=[b.indexOf(String.fromCharCode(13)),b.indexOf(String.fromCharCode(10))].filter(x=>x>=0);',
  'if(!k.length)return;e=1;',
  "o.write('NEBULA-DOCTOR-ECHO:'+b.slice(0,Math.min(...k))+N);",
  "o.write('NEBULA-DOCTOR-WAITING'+N);s=w();t=Date.now();",
  'p=setInterval(()=>{z=w();if(z[0]!==s[0]||z[1]!==s[1]||Date.now()-t>8000){clearInterval(p);',
  "o.write('NEBULA-DOCTOR-SIZE:'+z[0]+'x'+z[1]+N);setTimeout(()=>process.exit(7),300)}},100)});",
].join('');

export { PTY_SCRIPT };

async function groupPty(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  const svc = await getService(ctx);
  const authErr = 'error' in svc ? svc.error : await getAuth(ctx);
  const names = ['Scratch directory', 'Create PTY (Node probe)', 'Output arrives', 'Input echo', 'Resize', 'Exit code', 'Delete PTY'];
  if (authErr !== null || 'error' in svc) {
    for (const n of names) r.add(n, skip(`service not usable: ${authErr}`));
    if (ctx.flags.opencodePty) r.add('OpenCode TUI in a PTY', skip('service not usable'));
    return;
  }
  let dir = '';
  const sd = await r.check(names[0] as string, 5000, async () => {
    dir = await getScratch(ctx);
    return pass(dir);
  }, 'check that the temp folder is writable');
  if (sd.status !== 'PASS') {
    for (const n of names.slice(1)) r.add(n, skip('no scratch directory'));
    return;
  }
  let out = '';
  let exit: { exitCode: number | null; reason: string } | null = null;
  let pty: Awaited<ReturnType<typeof openPty>> | null = null;
  const errors: string[] = [];
  try {
    const created = await r.check(names[1] as string, 15_000, async () => {
      pty = await openPty(svc.client, { command: d.execPath, args: ['-e', PTY_SCRIPT], cwd: dir, cols: 80, rows: 24, title: 'nebula-doctor' }, {
        webSocket: d.webSocket,
        onError: (e) => errors.push(e.message),
      });
      pty.onData = (s) => (out += s);
      pty.onExit = (i) => (exit = i);
      return pass(`${pty.id}, running ${path.basename(d.execPath)} -e <probe>`);
    }, 'send this output back');
    if (created.status !== 'PASS' || !pty) {
      for (const n of names.slice(2, 6)) r.add(n, skip('PTY not created'));
    } else {
      const p = pty as Awaited<ReturnType<typeof openPty>>;
      const ready = await r.check(names[2] as string, 15_000, async () => {
        if (await waitUntil(() => out.includes('NEBULA-DOCTOR-READY:'), ms(ctx, 10_000))) {
          const m = /NEBULA-DOCTOR-READY:(\d+)x(\d+)/.exec(out);
          return pass(`marker received; program saw ${m ? `${m[1]}x${m[2]}` : 'an unknown size'} at start`);
        }
        return fail(`no marker within 10 s${exit ? ` (exited: ${JSON.stringify(exit)})` : ''}; got ${out.length} chars${errors.length ? `; errors: ${errors.join('; ')}` : ''}`, 'send this output back');
      });
      if (ready.status !== 'PASS') {
        for (const n of names.slice(3, 6)) r.add(n, skip('no output from the PTY'));
      } else {
        await r.check(names[3] as string, 10_000, async () => {
          p.write('ping-123\r');
          if (await waitUntil(() => out.includes('NEBULA-DOCTOR-ECHO:'), ms(ctx, 5000))) {
            const ok = out.includes('NEBULA-DOCTOR-ECHO:ping-123');
            return ok ? pass('line sent and echoed back') : warn('echo arrived with different text', 'send this output back');
          }
          return fail('no echo within 5 s', 'send this output back');
        });
        await r.check(names[4] as string, 15_000, async () => {
          if (!(await waitUntil(() => out.includes('NEBULA-DOCTOR-WAITING'), ms(ctx, 3000)))) return skip('probe did not reach the resize step');
          p.resize(100, 30);
          if (await waitUntil(() => out.includes('NEBULA-DOCTOR-SIZE:'), ms(ctx, 10_000))) {
            const m = /NEBULA-DOCTOR-SIZE:(\d+)x(\d+)/.exec(out);
            const got = m ? `${m[1]}x${m[2]}` : '?';
            return got === '100x30' ? pass('program saw 100x30') : warn(`program saw ${got}, expected 100x30`, 'resize does not reach the program; send this output back');
          }
          return fail('no size report within 10 s', 'send this output back');
        });
        await r.check(names[5] as string, 10_000, async () => {
          await waitUntil(() => exit !== null, ms(ctx, 5000));
          const e = exit as { exitCode: number | null; reason: string } | null;
          if (!e) return fail('no exit reported within 5 s', 'send this output back');
          if (e.exitCode === 7) return pass('exit code 7 reported');
          return warn(`reported ${JSON.stringify(e)}, expected exit code 7`, 'send this output back');
        });
      }
    }
  } finally {
    const id = pty ? (pty as { id: string }).id : null;
    await r.check(names[6] as string, 10_000, async () => {
      if (!pty || !id) return skip('no PTY');
      await (pty as { close(): Promise<void> }).close();
      try {
        await svc.client.request('GET', `/api/pty/${encodeURIComponent(id)}`, { query: { 'location[directory]': dir }, timeoutMs: ms(ctx, 5000) });
        return fail(`${id} still exists after delete`, 'delete it in OpenCode; send this output back');
      } catch (err) {
        if (err instanceof OpenCodeError && err.status === 404) return pass(`${id} deleted`);
        throw err;
      }
    });
  }
  if (ctx.flags.opencodePty) await opencodePty(ctx, svc.client, dir);
  else r.add('OpenCode TUI in a PTY', skip('optional; run `doctor --opencode-pty`'));
}

async function listSessionIds(client: OpenCodeApi, dir: string, timeoutMs: number): Promise<string[]> {
  const v = await client.request<{ data?: Array<{ id: string }> }>('GET', '/api/session', { query: { directory: dir }, timeoutMs });
  return (v?.data ?? []).map((s) => s.id);
}

async function opencodePty(ctx: Ctx, client: OpenCodeClient, dir: string): Promise<void> {
  const { d, r } = ctx;
  const name = 'OpenCode TUI in a PTY';
  const cli = await getCli(ctx);
  if (!cli.path) return void r.add(name, skip(cli.reason));
  const sv = await getServiceVersion(ctx);
  if (!cli.version || !sv || cli.version.replace(/^v/, '') !== sv.replace(/^v/, '')) {
    return void r.add(name, skip(`CLI and service versions differ or are unknown (CLI ${cli.version ?? '?'}, service ${sv ?? '?'}); starting it would restart the service`));
  }
  const { createEmulator, screenToText } = await import('./term/index.ts');
  const before = new Set(await listSessionIds(client, dir, ms(ctx, 8000)).catch(() => []));
  let pty: Awaited<ReturnType<typeof openPty>> | null = null;
  try {
    await r.check(name, 30_000, async () => {
      const cols = 100;
      const rows = 30;
      const emu = createEmulator(cols, rows);
      let bytes = 0;
      pty = await openPty(client, { command: cli.path as string, args: [], cwd: dir, cols, rows, title: 'nebula-doctor-opencode' }, { webSocket: d.webSocket });
      const p = pty;
      emu.onReply = (s) => p.write(s);
      p.onData = (s) => {
        bytes += s.length;
        emu.write(s);
      };
      let exited = false;
      p.onExit = () => (exited = true);
      const version = cli.version as string;
      const drawn = () => {
        const text = screenToText(emu);
        return text.includes('Ask anything') || text.includes(version);
      };
      await waitUntil(() => drawn() || exited, ms(ctx, 15_000));
      const text = screenToText(emu);
      const hits = ['Ask anything', version].filter((s) => text.includes(s));
      if (hits.length) return pass(`home screen drawn (${hits.map((h) => JSON.stringify(h)).join(', ')} found; ${bytes} chars of output)`);
      return fail(`home screen not seen in 15 s (${bytes} chars of output${exited ? ', program exited' : ''})`, 'send this output back');
    });
  } finally {
    await r.check('OpenCode TUI cleanup', 20_000, async () => {
      if (pty) await (pty as { close(): Promise<void> }).close();
      // The TUI must not create a session by itself; delete any it did make in our scratch dir.
      const after = await listSessionIds(client, dir, ms(ctx, 8000));
      const extra = after.filter((id) => !before.has(id));
      for (const id of extra) await client.request('DELETE', `/api/session/${encodeURIComponent(id)}`, { timeoutMs: ms(ctx, 8000) });
      if (extra.length) return warn(`the TUI created ${extra.length} session(s); deleted`, 'none expected; send this output back');
      return pass(`${pty ? 'PTY deleted; ' : ''}no session was created`);
    });
  }
}

async function groupSessions(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  const steps = ['Create session', 'Listed by directory', 'Directory path forms', 'Rename', 'Archive', 'Remove'];
  const svc = await getService(ctx);
  const authErr = 'error' in svc ? svc.error : await getAuth(ctx);
  if (authErr !== null || 'error' in svc) {
    for (const s of steps) r.add(s, skip(`service not usable: ${authErr}`));
    return;
  }
  const client = svc.client;
  let dir = '';
  try {
    dir = await getScratch(ctx);
  } catch (err) {
    for (const s of steps) r.add(s, skip(`no scratch directory: ${errText(err)}`));
    return;
  }
  const t = ms(ctx, 8000);
  let id: string | null = null;
  let removed = false;
  try {
    const c = await r.check(steps[0] as string, 10_000, async () => {
      const v = await client.request<{ data: { id: string } }>('POST', '/api/session', { body: { location: { directory: dir }, title: 'nebula-doctor probe' }, timeoutMs: t });
      id = v.data.id;
      return pass(`${id} in the scratch directory`);
    });
    if (c.status !== 'PASS' || !id) {
      for (const s of steps.slice(1)) r.add(s, skip('session not created'));
      return;
    }
    const sid = id as string;
    await r.check(steps[1] as string, 10_000, async () => {
      const ids = await listSessionIds(client, dir, t);
      return ids.includes(sid) ? pass('session.list returns it') : fail(`not in session.list for the directory (${ids.length} other)`, 'send this output back');
    });
    await r.check(steps[2] as string, 20_000, async () => {
      const forms = pathForms(dir, d.platform);
      const notes: string[] = [];
      let found = 0;
      for (const [label, form] of forms) {
        let res: string;
        try {
          res = (await listSessionIds(client, form, t)).includes(sid) ? 'found' : 'not found';
        } catch (err) {
          res = `error: ${errText(err)}`;
        }
        if (res === 'found') found++;
        notes.push(`${res.padEnd(9)}  ${label}: ${form}`);
      }
      return pass(`${found} of ${forms.length} forms return the session`, notes);
    });
    await r.check(steps[3] as string, 10_000, async () => {
      await client.request('PATCH', `/api/session/${encodeURIComponent(sid)}`, { body: { title: 'nebula-doctor renamed' }, timeoutMs: t });
      const v = await client.request<{ data?: { title?: string } }>('GET', `/api/session/${encodeURIComponent(sid)}`, { timeoutMs: t });
      return v?.data?.title === 'nebula-doctor renamed' ? pass('title changed') : warn('update accepted, but the title did not change', 'send this output back');
    });
    await r.check(steps[4] as string, 10_000, async () => {
      await client.request('PATCH', `/api/session/${encodeURIComponent(sid)}`, { body: { archived: true }, timeoutMs: t });
      const v = await client.request<{ data?: { time?: { archived?: number } } }>('GET', `/api/session/${encodeURIComponent(sid)}`, { timeoutMs: t });
      return v?.data?.time?.archived ? pass('archived') : warn('update accepted, but time.archived is not set', 'send this output back');
    });
    await r.check(steps[5] as string, 10_000, async () => {
      await client.request('DELETE', `/api/session/${encodeURIComponent(sid)}`, { timeoutMs: t });
      removed = true;
      try {
        await client.request('GET', `/api/session/${encodeURIComponent(sid)}`, { timeoutMs: t });
        return fail('still exists after delete', 'send this output back');
      } catch (err) {
        if (err instanceof OpenCodeError && err.status === 404) return pass('deleted');
        throw err;
      }
    });
  } finally {
    if (id && !removed) {
      await client.request('DELETE', `/api/session/${encodeURIComponent(id)}`, { timeoutMs: t }).catch(() => {});
    }
  }
}

/** The directory written in the forms that matter on Windows. */
export function pathForms(dir: string, platform: NodeJS.Platform): Array<[string, string]> {
  const sep = platform === 'win32' ? '\\' : '/';
  const forms: Array<[string, string]> = [['as given', dir], ['trailing separator', dir + sep]];
  if (platform === 'win32') {
    const m = /^([A-Za-z]):/.exec(dir);
    if (m) {
      const letter = m[1] as string;
      forms.push(['lower-case drive letter', letter.toLowerCase() + dir.slice(1)]);
      forms.push(['upper-case drive letter', letter.toUpperCase() + dir.slice(1)]);
    }
    forms.push(['forward slashes', dir.replace(/\\/g, '/')]);
    forms.push(['lower case', dir.toLowerCase()]);
  }
  const seen = new Set<string>();
  return forms.filter(([label, f]) => {
    if (seen.has(f) && label !== 'as given') return false;
    seen.add(f);
    return true;
  });
}

async function groupGit(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  const res = d.resolve('git');
  let gitPath: string | null = null;
  await r.check('git --version', 10_000, async () => {
    if (!res.ok) {
      return res.reason === 'shim'
        ? fail(`only a script shim: ${res.path}`, 'install Git for Windows and put the folder of git.exe on PATH')
        : fail('git not found on PATH', 'install Git for Windows (projects then work only as plain folders)');
    }
    const v = await d.run(res.path, ['--version'], { timeoutMs: ms(ctx, 8000) });
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.stdout);
    if (v.code !== 0 || !m) return fail(`${res.path}: ${v.error?.message ?? 'no version'}`, 'run `git --version` by hand and send the output');
    gitPath = res.path;
    const ver = v.stdout.trim().replace(/^git version /, '');
    if (cmpVersion(`${m[1]}.${m[2]}.${m[3] ?? 0}`, '2.31.0') < 0) {
      return warn(`${ver} at ${res.path} (older than 2.31)`, 'update Git: project detection needs `git rev-parse --path-format`');
    }
    return pass(`${ver} at ${res.path}`);
  });
  const steps = ['Temp repository (init, commit)', 'Detect repository kind', 'Worktree add', 'Worktree list parse', 'Worktree remove'];
  if (!gitPath) {
    for (const s of steps) r.add(s, skip('git not usable'));
    return;
  }
  const g = gitPath as string;
  let root = '';
  try {
    root = await fsp.mkdtemp(path.join(d.tmpdir, 'nebula-doctor-git-'));
    root = await fsp.realpath(root).catch(() => root);
  } catch (err) {
    for (const s of steps) r.add(s, skip(`cannot create a temp folder: ${errText(err)}`));
    return;
  }
  const repo = path.join(root, 'repo');
  const git = createGit({ gitPath: g, run: d.run, platform: d.platform });
  const project: Project = { id: 'doctor', path: repo, name: 'repo', kind: 'git' };
  const t = ms(ctx, 15_000);
  const runGit = async (args: string[]) => {
    const v = await d.run(g, ['-C', repo, ...args], { timeoutMs: t, env: { ...d.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    if (v.code !== 0) throw new Error(`git ${args[0]}: ${(v.error?.message ?? v.stderr.trim().split(/\r?\n/).pop()) || `exit code ${v.code}`}`);
    return v.stdout;
  };
  let wt = '';
  try {
    const init = await r.check(steps[0] as string, 30_000, async () => {
      await fsp.mkdir(repo);
      await runGit(['init', '-q']);
      // Only this temporary repository's config is changed.
      await runGit(['config', 'user.name', 'nebula doctor']);
      await runGit(['config', 'user.email', 'doctor@example.invalid']);
      await runGit(['config', 'commit.gpgsign', 'false']);
      await runGit(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'doctor']);
      return pass(repo);
    });
    if (init.status !== 'PASS') {
      for (const s of steps.slice(1)) r.add(s, skip('temp repository not created'));
      return;
    }
    await r.check(steps[1] as string, 15_000, async () => {
      const k = await git.detectKind(repo);
      return k === 'git' ? pass("detected as 'git'") : fail(`detected as '${k}'`, 'update Git to 2.31 or later; send this output back');
    });
    const add = await r.check(steps[2] as string, 30_000, async () => {
      wt = await git.createWorktree(project, 'doctor/probe', { newBranch: true });
      return pass(wt);
    });
    await r.check(steps[3] as string, 15_000, async () => {
      if (add.status !== 'PASS') return skip('no worktree');
      const list = await git.listCheckouts(project);
      const hit = list.find((c) => !c.isRoot && samePath(c.path, wt, d.platform));
      if (list.length === 2 && hit && hit.branch === 'doctor/probe') return pass(`2 checkouts; worktree path and branch match (${hit.path})`);
      return fail(`unexpected: ${JSON.stringify(list.map((c) => ({ path: c.path, branch: c.branch })))}`, 'send this output back (Git path output differs from what the parser expects)');
    });
    await r.check(steps[4] as string, 30_000, async () => {
      if (add.status !== 'PASS') return skip('no worktree');
      await git.removeWorktree(project, wt, { force: true });
      const list = await git.listCheckouts(project);
      return list.length === 1 ? pass('removed') : fail(`${list.length} checkouts remain`, 'send this output back');
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function groupAzure(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  const az = d.azure();
  const res = d.resolve('az');
  await r.check('az on PATH', 3000, () => {
    if (res.ok) return pass(res.path);
    if (res.reason === 'not-found') return warn('not found', 'install the Azure CLI to see pull requests (optional)');
    const l = az.launch();
    if (l.ok && l.launch.kind === 'python') return pass(`script shim ${res.path}; will start the bundled Python directly: ${l.launch.file} ${l.launch.args.join(' ')}`);
    return warn(`script shim ${res.path}; ${l.ok ? '' : l.reason}`, 'pull requests stay off: a shim needs cmd.exe; send this output back');
  });
  const l = az.launch();
  let ext: string | null = null;
  const ver = await r.check('az version', 30_000, async () => {
    if (!l.ok) return skip(l.reason);
    const v = await az.az(['version', '--output', 'json'], { timeoutMs: ms(ctx, 25_000) });
    if (v.code !== 0) return fail(`az did not run: ${v.error?.message ?? (v.stderr.trim().split(/\r?\n/).pop() || `exit code ${v.code}`)}`, 'send this output back');
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(v.stdout) as Record<string, unknown>;
    } catch {
      return fail('output is not JSON', 'send this output back');
    }
    const exts = (j.extensions ?? {}) as Record<string, unknown>;
    ext = typeof exts['azure-devops'] === 'string' ? (exts['azure-devops'] as string) : null;
    return pass(`azure-cli ${String(j['azure-cli'] ?? '?')}`);
  });
  await r.check('azure-devops extension', 1000, () => {
    if (ver.status !== 'PASS') return skip('az version did not run');
    return ext ? pass(ext) : warn('not installed', 'run: az extension add --name azure-devops');
  });
  await r.check('Signed in (az account show)', 30_000, async () => {
    if (ver.status !== 'PASS') return skip('az version did not run');
    // Exit code only: the output names the account and tenant.
    const v = await az.az(['account', 'show', '--output', 'none'], { timeoutMs: ms(ctx, 25_000) });
    return v.code === 0 ? pass('yes') : warn(`no (exit code ${v.code ?? v.error?.code})`, 'run: az login');
  });
}

async function groupState(ctx: Ctx): Promise<void> {
  const { d, r } = ctx;
  await r.check('State directory', 5000, async () => {
    const dir = stateDir(d.env, d.platform, d.homedir);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.doctor-${process.pid}.tmp`);
    const fin = path.join(dir, `.doctor-${process.pid}.json`);
    try {
      await fsp.writeFile(tmp, '{"doctor":true}\n');
      await fsp.rename(tmp, fin);
      const back = await fsp.readFile(fin, 'utf8');
      if (!back.includes('doctor')) return fail(`${dir}: read back differs`, 'send this output back');
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      await fsp.rm(fin, { force: true }).catch(() => {});
    }
    return pass(`${dir} (write + rename work)`);
  }, 'set NEBULA_STATE_DIR to a writable folder');
}

// ---------------------------------------------------------------------------
// Interactive check: keys, mouse, paste, resize (`doctor --keys`)
// ---------------------------------------------------------------------------

/** Bytes in a visible form: `ESC [ A`, `^]`, `0x7F`. */
export function visible(raw: string): string {
  const parts: string[] = [];
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x1b) parts.push('ESC');
    else if (c < 0x20) parts.push('^' + String.fromCharCode(c + 64));
    else if (c === 0x20) parts.push('SP');
    else if (c === 0x7f) parts.push('DEL');
    else if (c > 0x7e) parts.push('U+' + c.toString(16).toUpperCase().padStart(4, '0'));
    else if (/[0-9]/.test(ch) && /^[0-9]+$/.test(parts[parts.length - 1] ?? '')) parts[parts.length - 1] += ch;
    else parts.push(ch);
  }
  return parts.join(' ');
}

/** One event in a form that is safe to print. Pasted text is never shown, only its length. */
export function describeEvent(e: InputEvent): string {
  if (e.type === 'paste') return `paste of ${e.text.length} chars`;
  if (e.type === 'focus') return `focus ${e.focused ? 'in' : 'out'}`;
  const mods = `${e.ctrl ? 'Ctrl+' : ''}${e.alt ? 'Alt+' : ''}${e.shift ? 'Shift+' : ''}`;
  if (e.type === 'key') return `key ${mods}${e.key} (${visible(e.raw)})`;
  return `mouse ${mods}${e.button} ${e.action} at ${e.x},${e.y} (${visible(e.raw)})`;
}

interface KeyStep {
  name: string;
  prompt: string;
  match: (e: InputEvent) => boolean;
  resize?: boolean;
}

const KEY_STEPS: KeyStep[] = [
  { name: 'Arrow key', prompt: 'Press an arrow key.', match: (e) => e.type === 'key' && ['up', 'down', 'left', 'right'].includes(e.key) },
  { name: 'Ctrl+]', prompt: 'Press Ctrl+] (Control and the right square bracket).', match: (e) => e.type === 'key' && (e.raw === '\x1d' || (e.ctrl && e.key === ']')) },
  { name: 'Tab', prompt: 'Press Tab.', match: (e) => e.type === 'key' && e.key === 'tab' },
  { name: 'Mouse click', prompt: 'Click with the left mouse button anywhere in this window.', match: (e) => e.type === 'mouse' && e.action === 'down' },
  { name: 'Mouse wheel', prompt: 'Scroll the mouse wheel.', match: (e) => e.type === 'mouse' && (e.action === 'wheel-up' || e.action === 'wheel-down') },
  { name: 'Paste', prompt: 'Paste any text (Ctrl+V or right click). Only its length is recorded.', match: (e) => e.type === 'paste' },
  { name: 'Window resize', prompt: 'Change the size of this window (or of the pane).', match: () => false, resize: true },
];

export async function runKeysCheck(d: DoctorDeps): Promise<CheckResult[]> {
  const { openTerminal } = await import('./tui/terminal.ts');
  const unknown: string[] = [];
  const term = openTerminal({
    stdin: d.stdin as Parameters<typeof openTerminal>[0]['stdin'],
    stdout: d.stdout as Parameters<typeof openTerminal>[0]['stdout'],
    platform: d.platform,
    env: d.env,
    mouse: true,
    decoder: { onUnknown: (seq) => unknown.push(visible(seq)) },
  });
  const out: CheckResult[] = [];
  const add = (name: string, o: Outcome) => out.push({ group: 'terminal', name: `Keys: ${name}`, ...o });
  try {
    const say = (text: string) => term.write(text.replace(/\n/g, '\r\n'));
    say('\x1b[H\x1b[2Jnebula-enterprise doctor --keys\n\nEach step waits 10 s. Press s to skip a step, Ctrl+C to stop.\n\n');
    let aborted = false;
    for (const step of KEY_STEPS) {
      if (aborted) {
        add(step.name, skip('stopped with Ctrl+C'));
        continue;
      }
      say(`${step.prompt}  `);
      const seen: string[] = [];
      unknown.length = 0;
      const result = await new Promise<Outcome>((resolve) => {
        let done = false;
        const finish = (o: Outcome) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          offInput();
          offResize();
          resolve(o);
        };
        const timer = setTimeout(() => {
          const got = seen.length ? `; other input: ${seen.slice(0, 6).join(', ')}` : '';
          const unk = unknown.length ? `; unknown sequences: ${unknown.slice(0, 4).join(' | ')}` : '';
          finish(warn(`nothing matching arrived in 10 s${got}${unk}`, 'send this output back'));
        }, 10_000 * d.timeScale);
        const offInput = term.onInput((events) => {
          for (const e of events) {
            if (e.type === 'key' && e.ctrl && e.key === 'c') {
              aborted = true;
              return finish(skip('stopped with Ctrl+C'));
            }
            if (step.match(e)) return finish(pass(describeEvent(e)));
            if (e.type === 'key' && e.key === 's' && !e.ctrl && !e.alt) return finish(skip('skipped by the user'));
            if (e.type !== 'focus') seen.push(describeEvent(e));
          }
        });
        const before = term.size();
        const offResize = term.onResize((sz) => {
          if (step.resize) finish(pass(`resize event: ${before.cols}x${before.rows} -> ${sz.cols}x${sz.rows}`));
        });
      });
      say(`${result.status === 'PASS' ? 'ok' : result.status.toLowerCase()}\n`);
      add(step.name, result);
    }
  } finally {
    term.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Make one output string safe: no secrets, no control characters, home as `~`. */
export function makeTidy(opts: { secrets: Iterable<string>; homedir: string; platform: NodeJS.Platform; fullPaths: boolean }): (s: string) => string {
  const secrets = [...opts.secrets].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  const home = opts.homedir.replace(/[\\/]+$/, '');
  let homeRe: RegExp | null = null;
  if (!opts.fullPaths && home.length > 1) {
    const body = opts.platform === 'win32' ? escapeRe(home).replace(/\\\\|\//g, '[\\\\/]') : escapeRe(home);
    // Only at a path boundary, so /home/ann does not match inside /home/anna.
    homeRe = new RegExp(body + '(?=$|[\\\\/\\s:;,)\'"])', opts.platform === 'win32' ? 'gi' : 'g');
  }
  return (s) => {
    let out = s;
    for (const sec of secrets) out = out.split(sec).join('***');
    out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
    if (homeRe) out = out.replace(homeRe, '~');
    return out;
  };
}

function tidyResult(c: CheckResult, tidy: (s: string) => string): CheckResult {
  const o: CheckResult = { group: c.group, name: tidy(c.name), status: c.status, detail: tidy(c.detail) };
  if (c.fix) o.fix = tidy(c.fix);
  if (c.notes && c.notes.length) o.notes = c.notes.map(tidy);
  return o;
}

export function summarize(results: CheckResult[]): Record<'pass' | 'warn' | 'fail' | 'skip', number> {
  const s = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) s[r.status.toLowerCase() as keyof typeof s]++;
  return s;
}

function formatText(results: CheckResult[], header: string, color: boolean): string {
  const paint = (st: Status) => {
    if (!color) return st;
    const c = st === 'PASS' ? 32 : st === 'WARN' ? 33 : st === 'FAIL' ? 31 : 90;
    return `\x1b[${c}m${st}\x1b[0m`;
  };
  const width = Math.min(44, Math.max(...results.map((r) => r.name.length), 10));
  const lines: string[] = [header, ''];
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      if (group) lines.push('');
      group = r.group;
      lines.push(TITLES[group] ?? group);
    }
    lines.push(`  ${paint(r.status)}  ${r.name.padEnd(width)}  ${r.detail}`);
    for (const n of r.notes ?? []) lines.push(`        ${' '.repeat(width)}  ${n}`);
    if (r.status !== 'PASS' && r.fix) lines.push(`        ${' '.repeat(width)}  -> ${r.fix}`);
  }
  const s = summarize(results);
  lines.push('', `Summary: ${s.pass} PASS, ${s.warn} WARN, ${s.fail} FAIL, ${s.skip} SKIP`, 'Send this whole output back.', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runDoctor(args: string[], deps: Partial<DoctorDeps> = {}): Promise<number> {
  const d: DoctorDeps = { ...defaultDeps(), ...deps };
  const flags = parseFlags(args);
  if (typeof flags === 'string') {
    d.stdout.write(`doctor: ${flags}\n\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    d.stdout.write(USAGE);
    return 0;
  }
  const r = new Report(d.timeScale);
  const ctx: Ctx = { d, flags, r, secrets: new Set(), cli: null, service: null, auth: null, serviceVersion: null, scratch: null, scratchDirs: [] };
  for (const name of ['NEBULA_OPENCODE_PASSWORD']) {
    const v = d.env[name];
    if (v) ctx.secrets.add(v);
  }
  const groups: Record<(typeof GROUPS)[number], (c: Ctx) => Promise<void>> = {
    runtime: groupRuntime,
    terminal: groupTerminal,
    cli: groupCli,
    service: groupService,
    events: groupEvents,
    pty: groupPty,
    sessions: groupSessions,
    git: groupGit,
    azure: groupAzure,
    state: groupState,
  };
  try {
    for (const g of GROUPS) {
      if (flags.only && !flags.only.has(g)) continue;
      r.group(g);
      try {
        await groups[g](ctx);
      } catch (err) {
        r.add('(internal error)', fail(errText(err), 'send this output back'));
      }
    }
  } finally {
    if (ctx.scratchDirs.length) {
      r.group('cleanup');
      for (const dir of ctx.scratchDirs) {
        await r.check('Remove scratch directory', 10_000, async () => {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
          return (await d.exists(dir)) ? warn(`${dir} still exists`, 'delete it by hand') : pass(dir);
        });
      }
    }
  }
  // Secrets found during the run (the password) are known only now.
  const svc = ctx.service ? await ctx.service : null;
  if (svc && 'info' in svc && svc.info.password) ctx.secrets.add(svc.info.password);
  const tidy = makeTidy({ secrets: ctx.secrets, homedir: d.homedir, platform: d.platform, fullPaths: flags.fullPaths });
  const results = r.results.map((c) => tidyResult(c, tidy));
  const s = summarize(results);
  const code = s.fail > 0 ? 1 : 0;
  let text: string;
  if (flags.json) {
    text = JSON.stringify(
      { tool: 'nebula-enterprise doctor', version: d.version, platform: d.platform, arch: d.arch, results, summary: s, exitCode: code },
      null,
      2,
    ) + '\n';
  } else {
    const color = !!d.stdout.isTTY && d.env.NO_COLOR === undefined;
    text = formatText(results, `nebula-enterprise doctor ${d.version} (${d.platform} ${d.arch}, Node ${d.nodeVersion})`, color);
  }
  // Last net: scrub the whole text again (a secret could be split across fields only in theory).
  for (const sec of ctx.secrets) if (sec.length >= 4) text = text.split(sec).join('***');
  d.stdout.write(text);
  return code;
}
