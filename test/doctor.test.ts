// Tests of `doctor` with a fake OpenCode service (test/core/fake-server.ts) and fake programs.
// No real OpenCode service, no real `opencode` or `az` is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  describeEvent,
  makeTidy,
  pathForms,
  REQUIRED_OPERATIONS,
  runDoctor,
  runKeysCheck,
  visible,
  type CheckResult,
  type DoctorDeps,
} from '../src/doctor.ts';
import { createAzurePrProvider } from '../src/core/pr-azure.ts';
import { resolveExecutable, run as realRun, type ResolveResult, type Runner } from '../src/core/exe.ts';
import { AUTH, PASSWORD, startFakeServer, type FakeServer, type FakeSocket } from './core/fake-server.ts';
import type { CopilotLaunch } from '../src/core/copilot-launch.ts';

const B64 = AUTH.slice(6);
const TMP = os.tmpdir();

interface FakeOpts {
  serviceVersion?: string;
  ops?: readonly string[];
  /** Exit code the fake PTY program reports. */
  exitCode?: number;
}

/** A fake service that behaves like OpenCode 2.3.2 for every call `doctor` makes. */
async function fakeService(o: FakeOpts = {}): Promise<FakeServer & { sessions: Map<string, any>; ptys: Set<string> }> {
  const sessions = new Map<string, any>();
  const ptys = new Set<string>();
  let pty: { status: string; exitCode?: number } = { status: 'running' };
  let sock: FakeSocket | null = null;
  const ops = o.ops ?? REQUIRED_OPERATIONS;
  const fake = await startFakeServer((r) => {
    const m = `${r.method} ${r.path}`;
    if (m === 'GET /api/session/active') return { json: { data: {} } };
    if (m === 'GET /api/info') return { json: { version: o.serviceVersion ?? '2.3.2', pid: 1, urls: [], paths: { tmp: '/tmp' } } };
    if (m === 'GET /api/project') return { json: [{ id: 'p1' }, { id: 'p2' }] };
    if (m === 'GET /openapi.json') {
      const paths: Record<string, Record<string, { operationId: string }>> = {};
      ops.forEach((op, i) => (paths[`/x${i}`] = { get: { operationId: op } }));
      return { json: { openapi: '3.1.0', info: { version: '0.0.1' }, paths } };
    }
    if (m === 'POST /api/pty') {
      ptys.add('pty_1');
      pty = { status: 'running' };
      return { json: { data: { id: 'pty_1', ...r.body, status: 'running', pid: 1 } } };
    }
    if (m === 'PUT /api/pty/pty_1') {
      if (r.body?.size?.cols === 100 && sock) {
        const s = sock as FakeSocket;
        s.sendText(`CORRAL-DOCTOR-SIZE:${r.body.size.cols}x${r.body.size.rows}\r\n`);
        pty = { status: 'exited', exitCode: o.exitCode ?? 7 };
        setTimeout(() => s.close(1000), 20);
      }
      return { json: { data: { id: 'pty_1' } } };
    }
    if (m === 'GET /api/pty/pty_1') {
      if (!ptys.has('pty_1')) return { status: 404, json: { _tag: 'PtyNotFoundError', message: 'PTY session not found' } };
      return { json: { data: { id: 'pty_1', ...pty } } };
    }
    if (m === 'DELETE /api/pty/pty_1') {
      ptys.delete('pty_1');
      return { status: 204 };
    }
    if (m === 'POST /api/session') {
      const id = `ses_${sessions.size + 1}`;
      sessions.set(id, { id, title: r.body.title, directory: r.body.location.directory, time: {} });
      return { json: { data: sessions.get(id) } };
    }
    if (m === 'GET /api/session') {
      const dir = r.query.get('directory');
      return { json: { data: [...sessions.values()].filter((s) => s.directory === dir) } };
    }
    const sm = /^\/api\/session\/(ses_\d+)$/.exec(r.path);
    if (sm) {
      const s = sessions.get(sm[1]!);
      if (!s) return { status: 404, json: { _tag: 'SessionNotFoundError', message: 'not found' } };
      if (r.method === 'GET') return { json: { data: s } };
      if (r.method === 'PATCH') {
        if (typeof r.body.title === 'string') s.title = r.body.title;
        if (r.body.archived === true) s.time.archived = 123;
        return { json: { data: s } };
      }
      if (r.method === 'DELETE') {
        sessions.delete(s.id);
        return { status: 204 };
      }
    }
    return undefined;
  });
  fake.onSocket = (s) => {
    sock = s;
    s.sendBinary(Buffer.concat([Buffer.from([0]), Buffer.from('{"cursor":0}')]));
    s.sendText('CORRAL-DOCTOR-READY:80x24\r\n');
    s.onMessage = (msg) => {
      const t = msg.data.toString('utf8');
      if (t.includes('\r')) s.sendText(`ping-123\r\nCORRAL-DOCTOR-ECHO:${t.trim()}\r\nCORRAL-DOCTOR-WAITING\r\n`);
    };
  };
  return Object.assign(fake, { sessions, ptys });
}

interface Out {
  text: string;
  write(s: string): void;
  isTTY: boolean;
  columns: number;
  rows: number;
}

function out(): Out {
  return {
    text: '',
    isTTY: true,
    columns: 120,
    rows: 40,
    write(s: string) {
      this.text += s;
    },
  };
}

const fakeResolve = (map: Record<string, ResolveResult>) => (name: string): ResolveResult => map[name] ?? { ok: false, reason: 'not-found' };

function fakeRun(extra: Record<string, (args: string[]) => { code: number; stdout?: string; stderr?: string }> = {}): Runner {
  return async (file, args, opts) => {
    if (extra[file]) {
      const r = extra[file]!(args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (file === '/opt/oc/opencode' && args[0] === '--version') return { code: 0, stdout: '2.3.2\n', stderr: '' };
    return realRun(file, args, opts);
  };
}

async function deps(fake: FakeServer | null, over: Partial<DoctorDeps> = {}, stateDir?: string): Promise<{ d: Partial<DoctorDeps>; stdout: Out }> {
  const stdout = over.stdout ? (over.stdout as Out) : out();
  const svcFile = path.join(TMP, '.local', 'state', 'opencode', 'service.json');
  const resolve = fakeResolve({ opencode: { ok: true, path: '/opt/oc/opencode' } });
  const d: Partial<DoctorDeps> = {
    env: { NO_COLOR: '1', TERM: 'xterm-256color', CORRAL_STATE_DIR: stateDir ?? path.join(TMP, 'unused-state') },
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    homedir: TMP,
    tmpdir: TMP,
    nodeVersion: '26.1.0',
    typescript: 'strip',
    stdin: { isTTY: true },
    stdout,
    resolve,
    run: fakeRun(),
    exists: async (p) => fake !== null && p === svcFile,
    discover: async () => (fake ? { url: fake.url, password: PASSWORD, version: '2.3.2', source: svcFile } : null),
    azure: () => createAzurePrProvider({ resolve, run: fakeRun() }),
    keys: async () => [],
    timeScale: 0.5,
    ...over,
  };
  return { d, stdout };
}

function assertNoSecret(text: string): void {
  assert.ok(!text.includes(PASSWORD), 'password in output');
  assert.ok(!text.includes(B64), 'authorization value in output');
}

async function leftovers(): Promise<string[]> {
  return (await readdir(TMP)).filter((n) => n.startsWith('corral-doctor-'));
}

function line(text: string, name: string): string {
  return text.split('\n').find((l) => l.includes(`  ${name}  `) || l.includes(`  ${name} `)) ?? '';
}

test('doctor: all checks pass against a fake service', async () => {
  const fake = await fakeService();
  const state = await mkdtemp(path.join(TMP, 'nd-state-'));
  const before = await leftovers();
  try {
    const { d, stdout } = await deps(fake, {}, state);
    const code = await runDoctor(['--only', 'runtime,terminal,cli,service,events,pty,sessions,state'], d);
    const t = stdout.text;
    assert.equal(code, 0, t);
    assert.match(t, /Summary: \d+ PASS, 0 WARN, 0 FAIL, 2 SKIP/);
    for (const name of ['Node.js version', 'Service reachable', 'Authenticated request', 'Service version vs CLI version', 'OpenAPI operations', 'Event stream', 'Output arrives', 'Input echo', 'Resize', 'Exit code', 'Delete PTY', 'Create session', 'Listed by directory', 'Rename', 'Archive', 'Remove', 'State directory', 'Remove scratch directory']) {
      assert.match(line(t, name), /PASS/, `${name}: ${line(t, name)}`);
    }
    assert.match(line(t, 'Projects (GET /api/project)'), /2 project\(s\)/);
    assert.match(line(t, 'Exit code'), /exit code 7/);
    assert.match(t, /Send this whole output back\.\n$/);
    assert.equal(fake.sessions.size, 0, 'session removed');
    assert.equal(fake.ptys.size, 0, 'PTY removed');
    assert.deepEqual(await leftovers(), before, 'scratch directory removed');
    assert.ok(!/\x1b\[/.test(t), 'no color with NO_COLOR');
    assertNoSecret(t);
    // The scratch dir lies under the fake home (the temp dir): printed with ~.
    assert.match(line(t, 'Scratch directory'), /~[\\/]corral-doctor-/);
    assert.ok(!t.includes(TMP + path.sep), 'home prefix replaced');
  } finally {
    await fake.close();
    await rm(state, { recursive: true, force: true });
  }
});

test('doctor: service absent -> dependent checks SKIP, exit code 1', async () => {
  const { d, stdout } = await deps(null);
  const code = await runDoctor(['--only', 'service,events,pty,sessions'], d);
  const t = stdout.text;
  assert.equal(code, 1);
  assert.match(line(t, 'service.json location'), /FAIL/);
  assert.match(t, /-> run `opencode service start`/);
  assert.match(line(t, 'Service reachable'), /FAIL/);
  for (const name of ['Authenticated request', 'Event stream (GET /api/event)', 'Create PTY (Node probe)', 'Create session', 'Remove']) {
    assert.match(line(t, name), /SKIP/, name);
  }
  assert.match(t, /exists|missing/);
});

test('doctor: CLI and service version mismatch is a WARN, and --opencode-pty is skipped', async () => {
  const fake = await fakeService({ serviceVersion: '2.4.0' });
  try {
    const { d, stdout } = await deps(fake);
    const code = await runDoctor(['--only', 'service,pty', '--opencode-pty'], d);
    const t = stdout.text;
    assert.equal(code, 0, t);
    assert.match(line(t, 'Service version vs CLI version'), /WARN .*.*service 2\.4\.0, CLI 2\.3\.2/);
    assert.match(t, /restarts the service/);
    assert.match(line(t, 'OpenCode TUI in a PTY'), /SKIP.*versions differ/);
    assertNoSecret(t);
  } finally {
    await fake.close();
  }
});

test('doctor: an opencode script shim is a WARN with an explanation', async () => {
  const shim = path.join(TMP, 'npm', 'opencode.cmd');
  const { d, stdout } = await deps(null, { resolve: fakeResolve({ opencode: { ok: false, reason: 'shim', path: shim } }) });
  await runDoctor(['--only', 'cli'], d);
  const t = stdout.text;
  assert.match(line(t, 'opencode on PATH'), /WARN .*only a script shim: ~[\\/]npm[\\/]opencode\.cmd .*cmd\.exe is disabled/);
  assert.match(t, /-> put the folder of the real opencode\.exe on PATH/);
  assert.match(line(t, 'opencode --version'), /SKIP/);
});

test('doctor: missing OpenAPI operations are listed', async () => {
  const fake = await fakeService({ ops: REQUIRED_OPERATIONS.filter((o) => o !== 'pty.connect' && o !== 'form.list') });
  try {
    const { d, stdout } = await deps(fake);
    const code = await runDoctor(['--only', 'service'], d);
    assert.equal(code, 1);
    assert.match(line(stdout.text, 'OpenAPI operations'), /FAIL .*missing in \/openapi\.json .*: form\.list, pty\.connect$/);
  } finally {
    await fake.close();
  }
});

test('doctor --json: shape, no secret, home replaced; --full-paths keeps the home', async () => {
  const fake = await fakeService();
  try {
    const { d, stdout } = await deps(fake);
    const code = await runDoctor(['--json', '--only', 'runtime,service,pty'], d);
    const j = JSON.parse(stdout.text) as { tool: string; results: CheckResult[]; summary: Record<string, number>; exitCode: number; version: string };
    assert.equal(j.tool, 'corral doctor');
    assert.equal(j.exitCode, code);
    assert.deepEqual(Object.keys(j.summary).sort(), ['fail', 'pass', 'skip', 'warn']);
    assert.ok(j.results.length > 10);
    for (const r of j.results) {
      assert.equal(typeof r.group, 'string');
      assert.equal(typeof r.name, 'string');
      assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP'].includes(r.status));
      assert.equal(typeof r.detail, 'string');
    }
    assert.ok(j.results.some((r) => r.group === 'pty' && r.name === 'Resize' && r.status === 'PASS'));
    assertNoSecret(stdout.text);
    assert.ok(!stdout.text.includes(JSON.stringify(TMP + path.sep).slice(1, -1)), 'home replaced');

    const second = await deps(fake);
    await runDoctor(['--json', '--full-paths', '--only', 'pty'], second.d);
    assert.ok(JSON.parse(second.stdout.text).results.some((r: CheckResult) => r.detail.startsWith(TMP)), 'full paths kept');
  } finally {
    await fake.close();
  }
});

test('doctor: a secret that leaks into a program message is scrubbed', async () => {
  const fake = await fakeService();
  try {
    const run = fakeRun({ '/opt/oc/opencode': () => ({ code: 3, stderr: `bad auth ${PASSWORD} and ${AUTH}\n` }) });
    const { d, stdout } = await deps(fake, { run });
    await runDoctor(['--only', 'cli,service'], d);
    assert.match(line(stdout.text, 'opencode --version'), /FAIL .*no version: bad auth \*\*\* and \*\*\*/);
    assertNoSecret(stdout.text);
    const j = await deps(fake, { run });
    await runDoctor(['--json', '--only', 'cli,service'], j.d);
    assertNoSecret(j.stdout.text);
  } finally {
    await fake.close();
  }
});

test('doctor: color only on a TTY without NO_COLOR', async () => {
  const { d, stdout } = await deps(null, { env: { TERM: 'xterm' } });
  await runDoctor(['--only', 'runtime'], d);
  assert.match(stdout.text, /\x1b\[32mPASS\x1b\[0m/);
  const plain = await deps(null, { env: { TERM: 'xterm' }, stdout: Object.assign(out(), { isTTY: false }) });
  await runDoctor(['--only', 'runtime'], plain.d);
  assert.ok(!plain.stdout.text.includes('\x1b'));
});

test('doctor: Node below 26 fails; bad flags give usage and exit code 2', async () => {
  const { d, stdout } = await deps(null, { nodeVersion: '24.3.0', typescript: undefined });
  assert.equal(await runDoctor(['--only', 'runtime'], d), 1);
  assert.match(line(stdout.text, 'Node.js version'), /FAIL .*v24\.3\.0 \(needs 26 or later\)/);
  assert.match(line(stdout.text, 'TypeScript type stripping'), /FAIL/);
  const bad = await deps(null);
  assert.equal(await runDoctor(['--nope'], bad.d), 2);
  assert.match(bad.stdout.text, /unknown option: --nope/);
  assert.equal(await runDoctor(['--only', 'bogus'], bad.d), 2);
});

test('doctor: Azure group with a shim next to the bundled Python', async () => {
  const shim = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd';
  const python = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe';
  const calls: string[][] = [];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('version')) return { code: 0, stdout: JSON.stringify({ 'azure-cli': '2.70.0', extensions: { 'azure-devops': '1.0.1' } }), stderr: '' };
    if (args.includes('account')) return { code: 1, stdout: '', stderr: 'Please run az login' };
    return { code: 9, stdout: '', stderr: '' };
  };
  const resolve = fakeResolve({ az: { ok: false, reason: 'shim', path: shim } });
  const { d, stdout } = await deps(null, {
    resolve,
    azure: () => createAzurePrProvider({ platform: 'win32', resolve, run, exists: (p) => p === python }),
  });
  const code = await runDoctor(['--only', 'azure'], d);
  const t = stdout.text;
  assert.equal(code, 0, t);
  assert.match(line(t, 'az on PATH'), /PASS .*script shim .*az\.cmd; will start the bundled Python directly: .*python\.exe -IBm azure\.cli/);
  assert.match(line(t, 'az version'), /PASS .*azure-cli 2\.70\.0/);
  assert.match(line(t, 'azure-devops extension'), /PASS .*1\.0\.1/);
  assert.match(line(t, 'Signed in (az account show)'), /WARN .*no \(exit code 1\)/);
  assert.ok(!t.includes('Please run az login'), 'account output is not printed');
  assert.deepEqual(calls[0], [python, '-IBm', 'azure.cli', 'version', '--output', 'json']);
});

test('doctor: Git group with the real git', { skip: resolveExecutable('git').ok ? false : 'git not installed' }, async () => {
  const before = await leftovers();
  const g = resolveExecutable('git') as { ok: true; path: string };
  const { d, stdout } = await deps(null, { resolve: fakeResolve({ git: g }), run: realRun });
  const code = await runDoctor(['--only', 'git'], d);
  const t = stdout.text;
  assert.equal(code, 0, t);
  for (const name of ['git --version', 'Temp repository (init, commit)', 'Detect repository kind', 'Worktree add', 'Worktree list parse', 'Worktree remove']) {
    assert.match(line(t, name), /PASS/, `${name}: ${t}`);
  }
  assert.deepEqual(await leftovers(), before);
});

test('doctor: git older than 2.31 is a WARN', async () => {
  const run = fakeRun({ '/usr/bin/git': (a) => (a[0] === '--version' ? { code: 0, stdout: 'git version 2.25.1\n' } : { code: 1, stderr: 'fake' }) });
  const { d, stdout } = await deps(null, { resolve: fakeResolve({ git: { ok: true, path: '/usr/bin/git' } }), run });
  await runDoctor(['--only', 'git'], d);
  assert.match(line(stdout.text, 'git --version'), /WARN .*2\.25\.1 .*older than 2\.31/);
  assert.match(stdout.text, /--path-format/);
});

test('doctor --keys: injected interactive results are reported; without a TTY it is skipped', async () => {
  const keys = async (): Promise<CheckResult[]> => [{ group: 'terminal', name: 'Keys: Arrow key', status: 'PASS', detail: 'key up (ESC [ A)' }];
  const { d, stdout } = await deps(null, { keys });
  await runDoctor(['--keys', '--only', 'terminal'], d);
  assert.match(line(stdout.text, 'Keys: Arrow key'), /PASS .*key up \(ESC \[ A\)/);
  const notty = await deps(null, { keys, stdin: { isTTY: false } });
  await runDoctor(['--keys', '--only', 'terminal'], notty.d);
  assert.match(line(notty.stdout.text, 'Keys, mouse, paste, resize'), /SKIP .*stdin or stdout is not a terminal/);
});

test('runKeysCheck: decodes each step from a fake terminal, never shows pasted text, restores', async () => {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: false,
    setRawMode(m: boolean) {
      this.raw = m;
    },
    setEncoding() {},
    resume() {},
    pause() {},
  });
  let written = '';
  const replies: Array<[string, () => void]> = [
    ['Press an arrow key', () => stdin.emit('data', '\x1b[A')],
    ['Press Ctrl+]', () => stdin.emit('data', '\x1d')],
    ['Press Tab', () => stdin.emit('data', 'x\t')],
    ['Click with the left', () => stdin.emit('data', '\x1b[<0;5;3M\x1b[<0;5;3m')],
    ['Scroll the mouse wheel', () => stdin.emit('data', 's')],
    ['Paste any text', () => stdin.emit('data', '\x1b[200~top secret\x1b[201~')],
    ['Change the size', () => {
      stdout.columns = 90;
      stdout.emit('resize');
    }],
  ];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(s: string) {
      written += s;
      for (const [needle, fn] of replies) if (s.includes(needle)) setTimeout(fn, 5);
      return true;
    },
  });
  const base = (await deps(null)).d as DoctorDeps;
  const res = await runKeysCheck({ ...base, stdin, stdout, timeScale: 0.2 } as unknown as DoctorDeps);
  const by = Object.fromEntries(res.map((r) => [r.name, r]));
  assert.equal(by['Keys: Arrow key']!.detail, 'key up (ESC [ A)');
  assert.equal(by['Keys: Ctrl+]']!.detail, 'key Ctrl+] (^])');
  assert.equal(by['Keys: Tab']!.status, 'PASS');
  assert.equal(by['Keys: Mouse click']!.detail, 'mouse left down at 4,2 (ESC [ < 0 ; 5 ; 3 M)');
  assert.equal(by['Keys: Mouse wheel']!.status, 'SKIP');
  assert.equal(by['Keys: Paste']!.detail, 'paste of 10 chars');
  assert.equal(by['Keys: Window resize']!.detail, 'resize event: 80x24 -> 90x24');
  assert.ok(!JSON.stringify(res).includes('top secret'));
  assert.equal(stdin.raw, false, 'raw mode off again');
  assert.ok(written.endsWith('\x1b[?1049l'), 'terminal restored');
});

test('runKeysCheck: a step without input times out with a WARN that lists other input', async () => {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(s: string) {
      if (s.includes('Press an arrow key')) setTimeout(() => stdin.emit('data', 'q'), 5);
      if (s.includes('Press Ctrl+]')) setTimeout(() => stdin.emit('data', '\x03'), 5);
      return true;
    },
  });
  const base = (await deps(null)).d as DoctorDeps;
  const res = await runKeysCheck({ ...base, stdin, stdout, timeScale: 0.02 } as unknown as DoctorDeps);
  assert.equal(res[0]!.status, 'WARN');
  assert.match(res[0]!.detail, /nothing matching arrived in 10 s; other input: key q \(q\)/);
  assert.equal(res[1]!.detail, 'stopped with Ctrl+C');
  assert.ok(res.slice(2).every((r) => r.status === 'SKIP'));
});

test('makeTidy: secrets, control characters, home prefix (Windows case and separators)', () => {
  const t = makeTidy({ secrets: ['hunter22'], homedir: 'C:\\Users\\Ann', platform: 'win32', fullPaths: false });
  assert.equal(t('C:\\Users\\Ann\\x and c:/users/ann/y'), '~\\x and ~/y');
  assert.equal(t('C:\\Users\\Anna\\x'), 'C:\\Users\\Anna\\x');
  assert.equal(t('pw hunter22\x1b[31m'), 'pw ***?[31m');
  const p = makeTidy({ secrets: [], homedir: '/home/ann', platform: 'linux', fullPaths: false });
  assert.equal(p('/home/ann/x /home/anna /home/ann'), '~/x /home/anna ~');
  const full = makeTidy({ secrets: [], homedir: '/home/ann', platform: 'linux', fullPaths: true });
  assert.equal(full('/home/ann/x'), '/home/ann/x');
});

test('visible / describeEvent / pathForms', () => {
  assert.equal(visible('\x1b[A'), 'ESC [ A');
  assert.equal(visible('\x1d \x7fé'), '^] SP DEL U+00E9');
  assert.equal(describeEvent({ type: 'paste', text: 'password123' }), 'paste of 11 chars');
  assert.deepEqual(pathForms('C:\\Work\\Repo', 'win32').map(([, f]) => f), [
    'C:\\Work\\Repo',
    'C:\\Work\\Repo\\',
    'c:\\Work\\Repo',
    'C:/Work/Repo',
    'c:\\work\\repo',
  ]);
  assert.deepEqual(pathForms('/tmp/x', 'linux'), [['as given', '/tmp/x'], ['trailing separator', '/tmp/x/']]);
});

test('doctor: Copilot is optional; missing, it is a WARN and the run passes', async () => {
  const { d, stdout } = await deps(null, {
    env: { NO_COLOR: '1', CORRAL_COPILOT_HOME: path.join(TMP, 'no-such-copilot-home') },
    copilot: () => ({ ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' }),
  });
  const code = await runDoctor(['--only', 'copilot'], d);
  const t = stdout.text;
  assert.equal(code, 0, t);
  assert.match(line(t, 'copilot program'), /WARN .*not found on PATH/);
  assert.match(line(t, 'copilot --version'), /SKIP/);
  assert.match(line(t, 'Copilot home'), /WARN .*no session-state folder/);
  assert.match(t, /0 FAIL/);
});

test('doctor --copilot: the branch, the version, and a structure dump without content', async () => {
  const home = await mkdtemp(path.join(TMP, 'nd-copilot-'));
  try {
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    const secretDir = path.join(TMP, 'very-private-project');
    for (let i = 0; i < 4; i++) {
      const id = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
      const dir = path.join(home, 'session-state', id);
      await mk(dir, { recursive: true });
      await wf(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${secretDir}\nclient_name: github/cli\nname: SECRET PROMPT ${i}\ncreated_at: 2026-11-19T14:14:02.455Z\nupdated_at: 2026-11-19T14:14:15.489Z\n`);
      const ev = [
        { type: 'session.start', timestamp: '2026-11-19T14:15:32.423Z', data: { context: { cwd: secretDir } } },
        { type: 'user.message', timestamp: '2026-11-19T14:15:45.510Z', data: { content: 'SECRET TEXT' } },
        { type: 'assistant.turn_start', timestamp: '2026-11-19T14:15:45.533Z', data: {} },
        { type: 'tool.execution_start', timestamp: '2026-11-19T14:15:45.545Z', data: { arguments: { command: 'SECRET ARG' } } },
        { type: 'permission.requested', timestamp: '2026-11-19T14:15:45.568Z', data: { requestId: 'r1' } },
      ];
      await wf(path.join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    await mk(path.join(home, 'session-state', '.session-operation-locks'), { recursive: true });
    const seen: string[][] = [];
    const { d, stdout } = await deps(null, {
      env: { NO_COLOR: '1', COPILOT_HOME: home },
      copilot: () => ({ ok: true, kind: 'native', command: '/npm/node_modules/@github/copilot-win32-x64/copilot.exe', args: [], shim: '/npm/copilot.cmd' }),
      run: async (file, args, opts) => {
        seen.push([file, ...args, String(opts?.env?.COPILOT_AUTO_UPDATE)]);
        return { code: 0, stdout: 'GitHub Copilot CLI 1.0.114\n', stderr: '' };
      },
    });
    const code = await runDoctor(['--only', 'copilot', '--copilot'], d);
    const t = stdout.text;
    assert.equal(code, 0, t);
    assert.match(line(t, 'copilot program'), /PASS .*copilot\.exe \(the native program behind the npm shim: \/npm\/copilot\.cmd\)/);
    assert.match(line(t, 'copilot --version'), /PASS .* 1\.0\.114$/);
    assert.deepEqual(seen, [['/npm/node_modules/@github/copilot-win32-x64/copilot.exe', '--version', 'false']]);
    assert.match(line(t, 'Copilot sessions'), /4 session\(s\)/);
    assert.match(t, /3 newest of 4 session\(s\)/);
    assert.match(t, /#1 id is a UUID; workspace\.yaml keys: id, cwd, client_name, name, created_at, updated_at/);
    assert.match(t, /#1 client_name=github\/cli; created_at=2026-11-19T14:14:02\.455Z/);
    assert.match(t, /session\.start x1, user\.message x1, assistant\.turn_start x1, tool\.execution_start x1, permission\.requested x1/);
    assert.match(t, /requests with requestId: 1\/1; last event: permission\.requested/);
    assert.ok(!/#4/.test(t), 'only three sessions');
    for (const secret of ['SECRET', 'very-private-project', 'aaaaaaaa-']) assert.ok(!t.includes(secret), `${secret} leaked`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('doctor: without OpenCode but with Copilot, the OpenCode lines are WARN and the run passes', async () => {
  const noOpenCode = fakeResolve({});
  const copilot = (): CopilotLaunch => ({ ok: true, kind: 'exe', command: '/opt/copilot/copilot', args: [] });
  const groups = ['--only', 'cli,service,copilot'];
  const withCopilot = await deps(null, { resolve: noOpenCode, copilot, run: async () => ({ code: 0, stdout: 'GitHub Copilot CLI 1.0.114\n', stderr: '' }) });
  const code = await runDoctor(groups, withCopilot.d);
  const t = withCopilot.stdout.text;
  assert.equal(code, 0, t);
  assert.match(line(t, 'opencode on PATH'), /WARN .*not found on PATH \(OpenCode is not installed: Copilot only/);
  assert.match(t, /0 FAIL/);

  // With neither agent the run still fails.
  const none = await deps(null, { resolve: noOpenCode, copilot: () => ({ ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' }) });
  assert.equal(await runDoctor(groups, none.d), 1, none.stdout.text);
  assert.match(line(none.stdout.text, 'opencode on PATH'), /FAIL/);
});
