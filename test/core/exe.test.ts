import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutable, run } from '../../src/core/exe.ts';

const fakeFs = (files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

test('win32: finds an .exe through PATH and PATHEXT', () => {
  const r = resolveExecutable('git', {
    platform: 'win32',
    env: { Path: 'C:\\Tools;C:\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    isExecutable: fakeFs(['C:\\Git\\cmd\\git.exe']),
  });
  assert.deepEqual(r, { ok: true, path: 'C:\\Git\\cmd\\git.exe' });
});

test('win32: a .cmd shim is reported, not run', () => {
  const r = resolveExecutable('opencode', {
    platform: 'win32',
    env: { PATH: 'C:\\npm;C:\\other', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    isExecutable: fakeFs(['C:\\npm\\opencode.cmd', 'C:\\npm\\opencode.ps1']),
  });
  assert.deepEqual(r, { ok: false, reason: 'shim', path: 'C:\\npm\\opencode.cmd' });
});

test('win32: a real .exe later on PATH wins over an earlier shim', () => {
  const r = resolveExecutable('opencode', {
    platform: 'win32',
    env: { PATH: 'C:\\npm;"C:\\Program Files\\oc"', PATHEXT: '.CMD;.EXE' },
    isExecutable: fakeFs(['C:\\npm\\opencode.cmd', 'C:\\Program Files\\oc\\opencode.exe']),
  });
  assert.deepEqual(r, { ok: true, path: 'C:\\Program Files\\oc\\opencode.exe' });
});

test('win32: only a .ps1 script is reported as a shim', () => {
  const r = resolveExecutable('tool', {
    platform: 'win32',
    env: { PATH: 'C:\\s' },
    isExecutable: fakeFs(['C:\\s\\tool.ps1']),
  });
  assert.deepEqual(r, { ok: false, reason: 'shim', path: 'C:\\s\\tool.ps1' });
});

test('win32: name with an extension and an absolute path', () => {
  const isExe = fakeFs(['C:\\x\\a.exe', 'C:\\x\\b.bat']);
  assert.deepEqual(resolveExecutable('a.exe', { platform: 'win32', env: { PATH: 'C:\\x' }, isExecutable: isExe }), { ok: true, path: 'C:\\x\\a.exe' });
  assert.deepEqual(resolveExecutable('C:\\x\\a', { platform: 'win32', env: {}, isExecutable: isExe }), { ok: true, path: 'C:\\x\\a.exe' });
  assert.deepEqual(resolveExecutable('b', { platform: 'win32', env: { PATH: 'C:\\x' }, isExecutable: isExe }), { ok: false, reason: 'shim', path: 'C:\\x\\b.bat' });
  assert.deepEqual(resolveExecutable('zz', { platform: 'win32', env: { PATH: 'C:\\x' }, isExecutable: isExe }), { ok: false, reason: 'not-found' });
});

test('posix: PATH search, relative PATH entries skipped', () => {
  const r = resolveExecutable('git', { platform: 'linux', env: { PATH: 'rel:/usr/bin' }, isExecutable: (p) => p === '/usr/bin/git' || p === 'rel/git' });
  assert.deepEqual(r, { ok: true, path: '/usr/bin/git' });
});

test('posix: resolves the real node binary', () => {
  const r = resolveExecutable('node', { env: { PATH: process.execPath.replace(/[\\/][^\\/]+$/, '') } });
  assert.equal(r.ok, true);
});

test('run: exit code, output and no throw', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("hi");process.stderr.write("er");process.exit(3)']);
  assert.equal(ok.code, 3);
  assert.equal(ok.stdout, 'hi');
  assert.equal(ok.stderr, 'er');
  const missing = await run('/no/such/program-xyz', []);
  assert.equal(missing.code, null);
  assert.equal(missing.error?.code, 'ENOENT');
  const slow = await run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 200 });
  assert.equal(slow.code, null);
  assert.equal(slow.error?.code, 'ETIMEDOUT');
  const input = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'a b "c" & | ;' });
  assert.equal(input.stdout, 'a b "c" & | ;');
  const args = await run(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '&& echo x', '$(y)', "it's"]);
  assert.deepEqual(JSON.parse(args.stdout), ['&& echo x', '$(y)', "it's"]);
});
