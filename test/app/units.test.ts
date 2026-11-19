import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InputEvent } from '../../src/types.ts';
import {
  createBrowser, handleBrowserInput, loadDir, refilter, resolveSubmit, splitTyped, type BrowserFs,
} from '../../src/tui/app/browser.ts';
import { computeInboxLayout, computeLayout, sanitizeInboxWidth, sanitizeWidths } from '../../src/tui/app/layout.ts';
import { isWebUrl, openCommand, openUrl } from '../../src/tui/app/open-url.ts';
import { buildBindings, DEFAULT_LEAVE_KEY, findAction, footerHints, validLeaveKey } from '../../src/tui/app/bindings.ts';
import { createLogger, makeRedactor } from '../../src/tui/app/log.ts';
import { ptyOwner, ptyTitle } from '../../src/tui/app/stale.ts';
import { copilotPlan, createLauncher, parseVersion } from '../../src/tui/app/launcher.ts';
import { sessionArgs } from '../../src/tui/app/pane-manager.ts';
import { relativeTime, tildify } from '../../src/tui/app/format.ts';
import { handoff } from '../../src/tui/app/handoff.ts';

const key = (k: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): InputEvent => ({
  type: 'key', key: k, ctrl: false, alt: false, shift: false, raw: k, ...mods,
});

test('browser: Windows paths split into folder and filter', () => {
  const env = { platform: 'win32' as const, homedir: 'C:\\Users\\me' };
  assert.deepEqual(splitTyped('C:\\work\\re', env), { dir: 'C:\\work', base: 're' });
  assert.deepEqual(splitTyped('C:\\', env), { dir: 'C:\\', base: '' });
  assert.deepEqual(splitTyped('C:', env), { dir: 'C:\\', base: '' });
  assert.deepEqual(splitTyped('D:/src/', env), { dir: 'D:/src', base: '' });
  assert.deepEqual(splitTyped('\\\\server\\share\\proj', env), { dir: '\\\\server\\share\\', base: 'proj' });
  assert.deepEqual(splitTyped('~\\dev\\x', env), { dir: 'C:\\Users\\me\\dev', base: 'x' });
  const lin = { platform: 'linux' as const, homedir: '/home/me' };
  assert.deepEqual(splitTyped('/home/me/de', lin), { dir: '/home/me', base: 'de' });
  assert.deepEqual(splitTyped('/', lin), { dir: '/', base: '' });
  assert.deepEqual(splitTyped('~/x', lin), { dir: '/home/me', base: 'x' });
  // On Linux a backslash is part of a name.
  assert.deepEqual(splitTyped('/a\\b', lin), { dir: '/', base: 'a\\b' });
});

function fakeFs(tree: Record<string, string[]>): BrowserFs {
  return {
    listDirs: async (d) => {
      const v = tree[d];
      if (!v) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return [...v];
    },
    isGitRepo: async (d) => d.endsWith('repo'),
    isDir: async (d) => d in tree,
  };
}

test('browser: Tab completes, arrows pick and step, Enter adds (Windows)', async () => {
  const env = { platform: 'win32' as const, homedir: 'C:\\Users\\me' };
  const fs = fakeFs({
    'C:\\work': ['alpha', 'alpine', 'beta-repo'],
    'C:\\work\\alpha': ['inner'],
    'C:\\': ['work', 'Windows'],
  });
  let s = createBrowser('C:\\work', env);
  assert.equal(s.input.value, 'C:\\work\\');
  await loadDir(s, fs);
  s = refilter(s, env);
  assert.deepEqual(s.entries.map((e) => e.name), ['alpha', 'alpine', 'beta-repo']);
  const step = async (ev: InputEvent) => {
    const r = handleBrowserInput(s, ev, env, 10);
    s = r.state;
    await loadDir(s, fs);
    s = refilter(s, env);
    return r.action;
  };
  await step(key('a'));
  await step(key('l'));
  assert.deepEqual(s.entries.map((e) => e.name), ['alpha', 'alpine']);
  await step(key('tab'));
  assert.equal(s.input.value, 'C:\\work\\alp', 'common prefix');
  await step(key('h'));
  await step(key('tab'));
  assert.equal(s.input.value, 'C:\\work\\alpha\\', 'unique match gets a separator');
  assert.deepEqual(s.entries.map((e) => e.name), ['inner']);
  await step(key('left'));
  assert.equal(s.input.value, 'C:\\work\\');
  await step(key('left'));
  assert.equal(s.input.value, 'C:\\');
  await step(key('down'));
  assert.equal(s.entries[s.picked]?.name, 'Windows');
  await step(key('down'));
  await step(key('right'));
  assert.equal(s.input.value, 'C:\\work\\');
  await step(key('down'));
  await step(key('down'));
  await step(key('down'));
  const a = await step(key('enter'));
  assert.deepEqual(a, { kind: 'submit', path: 'C:\\work\\beta-repo' });
  // Typed path with no pick: an existing folder is taken as typed.
  s = createBrowser('C:\\work\\alpha', env);
  const typed = handleBrowserInput(s, key('enter'), env, 10).action;
  assert.equal(typed.kind, 'submit');
  assert.equal(await resolveSubmit(s, (typed as { path: string }).path, fs, env), 'C:\\work\\alpha');
});

test('browser: a missing folder reports an error', async () => {
  const env = { platform: 'linux' as const, homedir: '/h' };
  let s = createBrowser('/nope', env);
  await loadDir(s, fakeFs({}));
  s = refilter(s, env);
  assert.equal(s.error, 'no such folder');
});

test('layout: default widths, shrink, hide the pane, zoom', () => {
  let l = computeLayout({ cols: 200, rows: 50, paneFocused: false, zoom: false });
  assert.deepEqual(l.columns?.map((r) => r.w), [26, 30, 36]);
  assert.equal(l.pane?.x, 92);
  assert.equal(l.paneInner?.w, 200 - 92 - 2);
  assert.equal(l.footer.y, 49);
  l = computeLayout({ cols: 120, rows: 30, paneFocused: false, zoom: false });
  assert.ok(l.columns && l.pane);
  assert.ok(l.pane.w >= 40 && l.pane.w <= 42);
  assert.equal(l.columns.reduce((a, r) => a + r.w, 0) + l.pane.w, 120);
  l = computeLayout({ cols: 80, rows: 30, paneFocused: false, zoom: false });
  assert.equal(l.pane, null);
  assert.equal(l.columns?.reduce((a, r) => a + r.w, 0), 80);
  l = computeLayout({ cols: 80, rows: 30, paneFocused: true, zoom: false });
  assert.equal(l.columns, null);
  assert.deepEqual(l.paneInner, { x: 0, y: 0, w: 80, h: 29 });
  l = computeLayout({ cols: 200, rows: 50, paneFocused: true, zoom: true });
  assert.equal(l.columns, null);
  l = computeLayout({ cols: 200, rows: 50, paneFocused: false, zoom: true });
  assert.ok(l.columns, 'zoom applies only while the pane has focus');
  assert.deepEqual(sanitizeWidths([20, 'x', 999]), [20, 30, 120]);
  l = computeLayout({ cols: 200, rows: 50, paneFocused: false, zoom: false, widths: [20, 20, 20] });
  assert.equal(l.pane?.x, 60);
});

test('inbox layout: default width, shrink, hide the pane, zoom', () => {
  assert.equal(sanitizeInboxWidth(undefined), 56);
  assert.equal(sanitizeInboxWidth('x'), 56);
  assert.equal(sanitizeInboxWidth(10), 30);
  assert.equal(sanitizeInboxWidth(70.7), 70);
  assert.equal(sanitizeInboxWidth(9999), 160);
  let l = computeInboxLayout({ cols: 200, rows: 50, paneFocused: false, zoom: false });
  assert.equal(l.columns, null);
  assert.deepEqual(l.list, { x: 0, y: 0, w: 56, h: 49 });
  assert.deepEqual(l.pane, { x: 56, y: 0, w: 144, h: 49 });
  assert.deepEqual(l.paneInner, { x: 57, y: 1, w: 142, h: 47 });
  assert.deepEqual(l.footer, { x: 0, y: 49, w: 200, h: 1 });
  l = computeInboxLayout({ cols: 200, rows: 50, width: 80, paneFocused: false, zoom: false });
  assert.equal(l.list?.w, 80);
  // The list shrinks first, so the pane keeps its minimum width.
  l = computeInboxLayout({ cols: 80, rows: 30, paneFocused: false, zoom: false });
  assert.deepEqual([l.list?.w, l.pane?.w], [40, 40]);
  l = computeInboxLayout({ cols: 70, rows: 30, paneFocused: false, zoom: false });
  assert.deepEqual([l.list?.w, l.pane?.w], [30, 40]);
  // Too narrow for both: focus decides.
  l = computeInboxLayout({ cols: 60, rows: 30, paneFocused: false, zoom: false });
  assert.deepEqual(l.list, { x: 0, y: 0, w: 60, h: 29 });
  assert.equal(l.pane, null);
  l = computeInboxLayout({ cols: 60, rows: 30, paneFocused: true, zoom: false });
  assert.equal(l.list, null);
  assert.deepEqual(l.paneInner, { x: 0, y: 0, w: 60, h: 29 });
  assert.equal(l.paneBare, true);
  l = computeInboxLayout({ cols: 200, rows: 50, paneFocused: true, zoom: true });
  assert.equal(l.list, null);
  assert.deepEqual(l.pane, { x: 0, y: 0, w: 200, h: 49 });
  l = computeInboxLayout({ cols: 200, rows: 50, paneFocused: false, zoom: true });
  assert.ok(l.list && l.pane, 'zoom applies only while the pane has focus');
  // The projects layout has no inbox list.
  assert.equal(computeLayout({ cols: 200, rows: 50, paneFocused: false, zoom: false }).list, null);
});

test('open-url: only http(s), no shell on any platform', async () => {
  assert.equal(isWebUrl('https://dev.azure.com/o/p/_git/r/pullrequest/1'), true);
  assert.equal(isWebUrl('http://x.example/a?b=c'), true);
  assert.equal(isWebUrl('file:///etc/passwd'), false);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(isWebUrl('https://x.example/a b'), false);
  assert.equal(isWebUrl('https://x.example/"&calc'), false);
  assert.deepEqual(openCommand('https://a.example', 'win32', { SystemRoot: 'D:\\Win' }), {
    file: 'D:\\Win\\System32\\rundll32.exe',
    args: ['url.dll,FileProtocolHandler', 'https://a.example'],
  });
  assert.deepEqual(openCommand('https://a.example', 'linux', {}), { file: 'xdg-open', args: ['https://a.example'] });
  assert.deepEqual(openCommand('https://a.example', 'darwin', {}), { file: 'open', args: ['https://a.example'] });
  const calls: string[][] = [];
  await openUrl('https://a.example', { platform: 'linux', spawner: async (f, a) => void calls.push([f, ...a]) });
  assert.deepEqual(calls, [['xdg-open', 'https://a.example']]);
  await assert.rejects(openUrl('ftp://a.example', { spawner: async () => {} }));
});

test('bindings: leave key validation, dispatch order, footer from the table', () => {
  assert.equal(validLeaveKey(undefined), DEFAULT_LEAVE_KEY);
  assert.equal(validLeaveKey('ctrl+]'), 'ctrl+]');
  assert.equal(validLeaveKey('x'), DEFAULT_LEAVE_KEY, 'a plain letter cannot be the leave key');
  assert.equal(validLeaveKey('ctrl+shift+nonsense+'), DEFAULT_LEAVE_KEY);
  const t = buildBindings();
  assert.equal(findAction(t, ['projects', 'columns'], key('n')), 'project-add');
  assert.equal(findAction(t, ['git', 'columns'], key('n')), 'worktree-new');
  assert.equal(findAction(t, ['sessions', 'columns'], key('n')), 'session-new');
  assert.equal(findAction(t, ['sessions', 'columns'], key('A', { shift: true })), 'session-show-archived');
  assert.equal(findAction(t, ['sessions', 'columns'], key('j')), null, 'list keys stay with the list');
  assert.equal(findAction(t, ['pane'], key('q', { ctrl: true })), 'pane-leave');
  const hints = footerHints(t, 'pane').map((x) => `${x.key} ${x.label}`);
  assert.deepEqual(hints, ['Ctrl+q leave pane']);
  // Every key in the table can be parsed.
  for (const d of t) for (const k of d.keys) assert.doesNotThrow(() => findAction([d], [d.ctx], key('x')), k);
});

test('log: lines are redacted and written asynchronously', async () => {
  const written: string[] = [];
  const redact = makeRedactor(() => ['hunter2-secret']);
  const log = createLogger({ file: '/x', redact, append: async (_f, t) => void written.push(t), now: () => 0 });
  log('token hunter2-secret and ' + Buffer.from('opencode:hunter2-secret').toString('base64'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(written.join(''), '1970-01-01T00:00:00.000Z token *** and ***\n');
  const off = createLogger({ file: undefined, redact });
  off('nothing');
});

test('stale: titles and owners', () => {
  assert.equal(ptyTitle(12, 'ses_x'), 'nebula-enterprise:12:ses_x');
  assert.equal(ptyOwner('nebula-enterprise:12:ses_x'), 12);
  assert.equal(ptyOwner('nebula-enterprise:abc:ses_x'), null);
  assert.equal(ptyOwner('other'), null);
  assert.equal(ptyOwner(undefined), null);
  // Copilot session ids are UUIDs: no colon, so the owner is found the same way.
  const uuid = '3594e778-86c4-4da7-b393-1259e8bc1057';
  assert.equal(ptyTitle(12, uuid), `nebula-enterprise:12:${uuid}`);
  assert.equal(ptyOwner(ptyTitle(4242, uuid)), 4242);
});

test('launcher: Copilot plans (no version check), args before the session id', async () => {
  let runs = 0;
  const base = {
    resolve: () => ({ ok: true as const, path: '/opt/opencode' }),
    run: async () => (runs++, { code: 0, stdout: '9.9.9', stderr: '' }),
    serviceVersion: async () => '2.3.2',
  };
  const exe = createLauncher({ ...base, copilot: () => ({ ok: true, kind: 'exe', command: '/opt/copilot', args: [] }) });
  assert.deepEqual(await exe.prepare('copilot'), { ok: true, command: '/opt/copilot', shimNote: null, runnableHere: true });
  assert.equal(runs, 0, 'the OpenCode version check is only for OpenCode');
  const loader = createLauncher({
    ...base,
    copilot: () => ({ ok: true, kind: 'loader', command: 'C:\\node\\node.exe', args: ['C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js'] }),
    copilotEnv: () => ({ COPILOT_HOME: 'D:\\cp' }),
  });
  const plan = await loader.prepare('copilot');
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.prefixArgs, ['C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js']);
  assert.deepEqual(plan.ok && plan.env, { COPILOT_HOME: 'D:\\cp' });
  const none = createLauncher({ ...base, copilot: () => ({ ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' }) });
  assert.deepEqual(await none.prepare('copilot'), { ok: false, message: 'Cannot start Copilot: copilot (GitHub Copilot CLI) not found on PATH.' });
  assert.deepEqual(copilotPlan(undefined), { ok: false, message: 'Copilot: no launcher configured.' });
  assert.deepEqual(sessionArgs('copilot', 'u-1'), ['--session-id', 'u-1']);
  assert.deepEqual(sessionArgs('opencode', 'ses_1'), ['--session', 'ses_1']);
});

test('format and version helpers', () => {
  assert.equal(parseVersion('opencode v2.3.2\n'), '2.3.2');
  assert.equal(parseVersion('2.4.0-beta.1'), '2.4.0-beta.1');
  assert.equal(parseVersion('none'), null);
  const now = 10_000_000_000;
  assert.equal(relativeTime(now - 30_000, now), 'now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m');
  assert.equal(relativeTime(now - 3 * 3600_000, now), '3h');
  assert.equal(relativeTime(now - 3 * 86400_000, now), '3d');
  assert.equal(tildify('/home/me/dev/x', '/home/me', 'linux'), '~/dev/x');
  assert.equal(tildify('C:\\Users\\Me\\dev', 'c:\\users\\me', 'win32'), '~\\dev');
});

test('hand-off suspends and always resumes', async () => {
  const log: string[] = [];
  const term = { suspend: () => log.push('suspend'), resume: () => log.push('resume') };
  const r = await handoff(term, async (f, a, c) => (log.push(`run ${f} ${a.join(' ')} ${c}`), { code: 7 }), '/bin/oc', ['--session', 's'], '/d');
  assert.deepEqual(r, { code: 7 });
  assert.deepEqual(log, ['suspend', 'run /bin/oc --session s /d', 'resume']);
  await assert.rejects(handoff(term, async () => {
    throw new Error('x');
  }, 'a', [], '/'));
  assert.equal(log.at(-1), 'resume');
});
