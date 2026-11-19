import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCopilotLaunch } from '../../src/core/copilot-launch.ts';
import { resolveExecutable } from '../../src/core/exe.ts';

/** A fake Windows disk: the set of files that exist (case ignored). */
function disk(files: string[]) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    exists: (p: string) => set.has(p.toLowerCase()),
    isExecutable: (p: string) => set.has(p.toLowerCase()),
  };
}

const NPM = 'C:\\Users\\Ann\\AppData\\Roaming\\npm';
const ENV = { PATH: `C:\\Windows\\System32;${NPM}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

function win(files: string[], extra: Record<string, string> = {}, arch = 'x64') {
  const d = disk(files);
  const env = { ...ENV, ...extra };
  return resolveCopilotLaunch({
    platform: 'win32',
    arch,
    env,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    exists: d.exists,
    resolve: (n) => resolveExecutable(n, { env, platform: 'win32', isExecutable: d.isExecutable }),
  });
}

test('copilot launch, Windows: a real copilot.exe on PATH (WinGet) wins', () => {
  const r = win(['C:\\Windows\\System32\\copilot.exe', `${NPM}\\copilot.cmd`]);
  assert.deepEqual(r, { ok: true, kind: 'exe', command: 'C:\\Windows\\System32\\copilot.exe', args: [] });
});

test('copilot launch, Windows: native exe in the nested npm package, never the .cmd', () => {
  const nested = `${NPM}\\node_modules\\@github\\copilot\\node_modules\\@github\\copilot-win32-x64\\copilot.exe`;
  const r = win([`${NPM}\\copilot.cmd`, nested, `${NPM}\\node_modules\\@github\\copilot\\npm-loader.js`]);
  assert.deepEqual(r, { ok: true, kind: 'native', command: nested, args: [], shim: `${NPM}\\copilot.cmd` });
});

test('copilot launch, Windows: native exe as a sibling package, arm64', () => {
  const sib = `${NPM}\\node_modules\\@github\\copilot-win32-arm64\\copilot.exe`;
  const r = win([`${NPM}\\copilot.cmd`, sib], {}, 'arm64');
  assert.ok(r.ok && r.kind === 'native' && r.command === sib);
  // An x64 machine does not take the arm64 program.
  const x = win([`${NPM}\\copilot.cmd`, sib], {}, 'x64');
  assert.equal(x.ok, false);
});

test('copilot launch, Windows: node.exe with the npm loader as the last resort', () => {
  const loader = `${NPM}\\node_modules\\@github\\copilot\\npm-loader.js`;
  const r = win([`${NPM}\\copilot.cmd`, loader]);
  assert.deepEqual(r, { ok: true, kind: 'loader', command: 'C:\\Program Files\\nodejs\\node.exe', args: [loader], shim: `${NPM}\\copilot.cmd` });
});

test('copilot launch, Windows: only a shim, nothing behind it', () => {
  const r = win([`${NPM}\\copilot.cmd`]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /only a script shim .*copilot\.cmd.*cmd\.exe/);
  const none = win([]);
  assert.deepEqual(none, { ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' });
});

test('copilot launch: NEBULA_COPILOT_BIN overrides; a script is refused on Windows', () => {
  const ok = win(['D:\\tools\\copilot.exe'], { NEBULA_COPILOT_BIN: 'D:\\tools\\copilot.exe' });
  assert.deepEqual(ok, { ok: true, kind: 'override', command: 'D:\\tools\\copilot.exe', args: [] });
  const missing = win([], { NEBULA_COPILOT_BIN: 'D:\\tools\\copilot.exe' });
  assert.match(!missing.ok ? missing.reason : '', /missing file/);
  const script = win(['D:\\tools\\copilot.cmd'], { NEBULA_COPILOT_BIN: 'D:\\tools\\copilot.cmd' });
  assert.match(!script.ok ? script.reason : '', /must name a \.exe/);
});

test('copilot launch, Linux: copilot from PATH', () => {
  const r = resolveCopilotLaunch({
    platform: 'linux',
    env: { PATH: '/usr/bin:/home/u/.npm/bin' },
    exists: () => false,
    resolve: (n) => resolveExecutable(n, { env: { PATH: '/usr/bin:/home/u/.npm/bin' }, platform: 'linux', isExecutable: (p) => p === '/home/u/.npm/bin/copilot' }),
  });
  assert.deepEqual(r, { ok: true, kind: 'exe', command: '/home/u/.npm/bin/copilot', args: [] });
});
