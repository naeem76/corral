import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathKey, samePath, serviceFileCandidates, stateDir, trimTrailingSep } from '../../src/core/paths.ts';

test('samePath on win32 ignores case, separator style and a trailing separator', () => {
  assert.ok(samePath('C:\\Users\\Ann\\Repo', 'c:/users/ann/repo/', 'win32'));
  assert.ok(samePath('C:\\Users\\Ann\\Repo\\', 'C:\\USERS\\ANN\\REPO', 'win32'));
  assert.ok(samePath('C:\\a\\.\\b', 'C:\\a\\b', 'win32'));
  assert.ok(!samePath('C:\\a\\b', 'C:\\a\\bc', 'win32'));
  assert.ok(!samePath('C:\\a', 'D:\\a', 'win32'));
  assert.equal(pathKey('C:\\', 'win32'), 'c:\\');
});

test('samePath on posix is case sensitive and ignores a trailing slash', () => {
  assert.ok(samePath('/home/a/repo', '/home/a/repo/', 'linux'));
  assert.ok(!samePath('/home/a/Repo', '/home/a/repo', 'linux'));
  assert.equal(pathKey('/', 'linux'), '/');
});

test('trimTrailingSep keeps the root', () => {
  assert.equal(trimTrailingSep('/a/b/', 'linux'), '/a/b');
  assert.equal(trimTrailingSep('/', 'linux'), '/');
  assert.equal(trimTrailingSep('C:\\x\\', 'win32'), 'C:\\x');
  assert.equal(trimTrailingSep('C:\\', 'win32'), 'C:\\');
});

test('stateDir follows the override, Windows and XDG rules', () => {
  assert.equal(stateDir({ NEBULA_STATE_DIR: '/tmp/s' }, 'linux', '/home/a'), '/tmp/s');
  assert.equal(stateDir({ XDG_STATE_HOME: '/x' }, 'linux', '/home/a'), '/x/nebula-enterprise');
  assert.equal(stateDir({ XDG_STATE_HOME: 'rel' }, 'linux', '/home/a'), '/home/a/.local/state/nebula-enterprise');
  assert.equal(stateDir({}, 'linux', '/home/a'), '/home/a/.local/state/nebula-enterprise');
  assert.equal(stateDir({ LocalAppData: 'C:\\Users\\A\\AppData\\Local' }, 'win32', 'C:\\Users\\A'), 'C:\\Users\\A\\AppData\\Local\\nebula-enterprise');
  assert.equal(stateDir({}, 'win32', 'C:\\Users\\A'), 'C:\\Users\\A\\AppData\\Local\\nebula-enterprise');
});

test('service file candidates: override, then ordered list', () => {
  assert.deepEqual(serviceFileCandidates({ NEBULA_OPENCODE_SERVICE_FILE: '/s/service.json' }, 'linux', '/h'), ['/s/service.json']);
  assert.deepEqual(serviceFileCandidates({}, 'linux', '/h'), ['/h/.local/state/opencode/service.json']);
  assert.deepEqual(serviceFileCandidates({ LOCALAPPDATA: 'C:\\U\\L', APPDATA: 'C:\\U\\R' }, 'win32', 'C:\\U'), [
    'C:\\U\\.local\\state\\opencode\\service.json',
    'C:\\U\\L\\opencode\\service.json',
    'C:\\U\\R\\opencode\\service.json',
  ]);
});
