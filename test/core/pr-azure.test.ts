import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Project } from '../../src/types.ts';
import type { ResolveResult, RunOptions, RunResult, Runner } from '../../src/core/exe.ts';
import {
  AZ_PR_LIST_ARGS,
  createAzurePrProvider,
  mapPullRequest,
  parsePrList,
  pullRequestWebUrl,
  resolveAzLaunch,
  type AzurePrOptions,
} from '../../src/core/pr-azure.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const LIST = fixture('az-pr-list.json');
const LEGACY = fixture('az-pr-list-legacy.json');
const VERSION = JSON.stringify({ 'azure-cli': '2.70.0', 'azure-cli-core': '2.70.0', extensions: { 'azure-devops': '1.0.1' } });

const repo: Project = { id: 'p1', path: '/work/billing service & "x"', name: 'billing', kind: 'git' };

interface Call {
  file: string;
  args: string[];
  opts: RunOptions | undefined;
}

/** A fake `az`: answers by the first argument; `list` can be changed between calls. */
function fakeAz(o: { list?: () => RunResult; version?: () => RunResult } = {}) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ file, args: [...args], opts });
    const a = args.filter((x) => x !== '-IBm' && x !== 'azure.cli');
    if (a[0] === 'version') return o.version ? o.version() : { code: 0, stdout: VERSION, stderr: '' };
    if (a[0] === 'repos') return o.list ? o.list() : { code: 0, stdout: LIST, stderr: '' };
    return { code: 2, stdout: '', stderr: 'unexpected' };
  };
  return { calls, run };
}

function provider(over: AzurePrOptions = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const errors: string[] = [];
  const p = createAzurePrProvider({
    platform: 'linux',
    resolve: () => ({ ok: true, path: '/usr/bin/az' }),
    remotes: async () => ['https://contoso-sample@dev.azure.com/contoso-sample/Platform%20Team/_git/billing-service'],
    now: clock.now,
    onError: (e) => errors.push(e.message),
    ...over,
  });
  return { p, clock, errors };
}

test('parsePrList maps the az output: ids, branches, author, draft and status, web URLs', () => {
  const rows = parsePrList(LIST);
  assert.deepEqual(rows, [
    {
      id: '4211',
      title: 'Export: retry with backoff',
      url: 'https://dev.azure.com/contoso-sample/Platform%20Team/_git/billing-service/pullrequest/4211',
      sourceBranch: 'feature/export-retry',
      targetBranch: 'main',
      author: 'Robin Example',
      status: 'active',
    },
    {
      id: '4219',
      title: 'WIP: invoice PDF layout',
      // No webUrl in the row: built from the REST URL, the project name and the repo name.
      url: 'https://dev.azure.com/contoso-sample/Platform%20Team/_git/billing-service/pullrequest/4219',
      sourceBranch: 'users/alex/WIP & "quotes" test',
      targetBranch: 'release/2026.11',
      author: 'Alex Placeholder',
      status: 'draft',
    },
  ]);
});

test('legacy visualstudio.com URLs, completed/abandoned status, http is refused', () => {
  const rows = parsePrList(LEGACY);
  assert.equal(rows[0]!.url, 'https://fabrikam-sample.visualstudio.com/Old%20Project/_git/Legacy%20Repo/pullrequest/77');
  assert.equal(rows[0]!.status, 'completed');
  assert.equal(rows[1]!.url, 'https://fabrikam-sample.visualstudio.com/DefaultCollection/Old%20Project/_git/Legacy%20Repo/pullrequest/78');
  assert.equal(rows[1]!.status, 'abandoned');
  assert.equal(rows[2]!.url, '', 'http web URL refused');
  assert.equal(rows[2]!.status, 'active', 'unknown status counts as active');
  assert.equal(rows[2]!.author, '');
});

test('pullRequestWebUrl refuses odd input', () => {
  assert.equal(pullRequestWebUrl({ pullRequestId: 1, repository: { webUrl: 'javascript:alert(1)' } }), '');
  assert.equal(pullRequestWebUrl({ pullRequestId: 1, repository: { webUrl: 'https://user:pw@dev.azure.com/o/p/_git/r' } }), '');
  assert.equal(pullRequestWebUrl({ pullRequestId: 1, url: 'https://dev.azure.com/o/no-apis-here', repository: { name: 'r', project: { name: 'p' } } }), '');
  assert.equal(pullRequestWebUrl({ repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } }), '');
  assert.equal(mapPullRequest({ title: 'no id' }), null);
  assert.throws(() => parsePrList('{"not":"an array"}'), /expected a JSON array/);
});

test('list: runs the fixed az command in the project folder and caches for cacheMs', async () => {
  const az = fakeAz();
  const { p, clock } = provider({ run: az.run, cacheMs: 60_000 });
  const a = await p.list(repo);
  assert.equal(a.length, 2);
  const list = az.calls.filter((c) => c.args[0] === 'repos');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.file, '/usr/bin/az');
  assert.deepEqual(list[0]!.args, ['repos', 'pr', 'list', '--detect', 'true', '--status', 'active', '--output', 'json']);
  assert.deepEqual(list[0]!.args, [...AZ_PR_LIST_ARGS]);
  // The path (with spaces, quotes and &) goes only into cwd, never into the arguments.
  assert.equal(list[0]!.opts?.cwd, repo.path);
  assert.ok(!list[0]!.args.some((x) => x.includes('billing')));
  clock.advance(59_000);
  await p.list(repo);
  assert.equal(az.calls.filter((c) => c.args[0] === 'repos').length, 1, 'cached');
  clock.advance(2000);
  await p.list(repo);
  assert.equal(az.calls.filter((c) => c.args[0] === 'repos').length, 2, 'expired');
});

test('list: concurrent calls share one az run', async () => {
  const az = fakeAz();
  const { p } = provider({ run: az.run });
  const [a, b] = await Promise.all([p.list(repo), p.list(repo)]);
  assert.equal(a, b);
  assert.equal(az.calls.filter((c) => c.args[0] === 'repos').length, 1);
});

test('list: malformed JSON and non-zero exit return the last good list and call onError', async () => {
  let mode = 'ok';
  const az = fakeAz({
    list: () =>
      mode === 'ok'
        ? { code: 0, stdout: LIST, stderr: '' }
        : mode === 'bad'
          ? { code: 0, stdout: '[{"pullRequestId": 1,', stderr: '' }
          : { code: 1, stdout: '', stderr: 'WARNING: x\nERROR: TF400813: The user is not authorized to access this resource.\n' },
  });
  const { p, clock, errors } = provider({ run: az.run, cacheMs: 1000 });
  const good = await p.list(repo);
  assert.equal(good.length, 2);
  mode = 'bad';
  clock.advance(1001);
  assert.deepEqual(await p.list(repo), good);
  assert.match(errors[0]!, /az repos pr list: .*JSON/);
  mode = 'fail';
  clock.advance(1001);
  assert.deepEqual(await p.list(repo), good);
  assert.equal(errors[1], 'az repos pr list: ERROR: TF400813: The user is not authorized to access this resource.');
  // A failure is not retried on every call.
  const n = az.calls.length;
  await p.list(repo);
  assert.equal(az.calls.length, n);
});

test('list: an error with no earlier result returns [] and never throws', async () => {
  const az = fakeAz({ list: () => ({ code: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'az: timed out' } }) });
  const { p, errors } = provider({ run: az.run });
  assert.deepEqual(await p.list(repo), []);
  assert.deepEqual(errors, ['az repos pr list: az: timed out']);
});

test('list: dir projects and repositories without an Azure remote never run az; negative cache expires', async () => {
  const az = fakeAz();
  let remotes: string[] | null = ['git@github.com:someone/thing.git'];
  const { p, clock } = provider({ run: az.run, remotes: async () => remotes, negativeMs: 600_000 });
  assert.deepEqual(await p.list({ ...repo, kind: 'dir' }), []);
  assert.deepEqual(await p.list(repo), []);
  assert.equal(az.calls.length, 0);
  remotes = ['https://dev.azure.com/contoso-sample/x/_git/y'];
  clock.advance(599_000);
  assert.deepEqual(await p.list(repo), [], 'still remembered');
  assert.equal(az.calls.length, 0);
  clock.advance(2000);
  assert.equal((await p.list(repo)).length, 2, 'asked again after the negative cache expired');
});

test('list: az saying it cannot detect the repository is remembered as negative', async () => {
  const az = fakeAz({ list: () => ({ code: 1, stdout: '', stderr: 'ERROR: --organization must be specified. The value can be the default organization...' }) });
  const { p, errors } = provider({ run: az.run, remotes: async () => null });
  assert.deepEqual(await p.list(repo), []);
  assert.deepEqual(await p.list(repo), []);
  assert.equal(az.calls.filter((c) => c.args[0] === 'repos').length, 1);
  assert.deepEqual(errors, []);
});

test('Azure remote detection accepts the https, ssh and legacy forms', async () => {
  for (const url of [
    'https://dev.azure.com/o/p/_git/r',
    'https://o@dev.azure.com/o/p/_git/r',
    'git@ssh.dev.azure.com:v3/o/p/r',
    'https://o.visualstudio.com/p/_git/r',
    'o@vs-ssh.visualstudio.com:v3/o/p/r',
  ]) {
    const az = fakeAz();
    const { p } = provider({ run: az.run, remotes: async () => [url] });
    assert.equal((await p.list(repo)).length, 2, url);
  }
  const az = fakeAz();
  const { p } = provider({ run: az.run, remotes: async () => ['https://evil.example/dev.azure.com.git'] });
  assert.equal((await p.list(repo)).length, 0);
});

test('available: needs the azure-devops extension; answer cached; reason exposed', async () => {
  let ext = false;
  const az = fakeAz({ version: () => ({ code: 0, stdout: JSON.stringify({ 'azure-cli': '2.70.0', extensions: ext ? { 'azure-devops': '1.0.1' } : {} }), stderr: '' }) });
  const { p, clock } = provider({ run: az.run, availabilityMs: 300_000 });
  assert.equal(await p.available(), false);
  assert.match(p.reason()!, /azure-devops extension is not installed/);
  assert.deepEqual(await p.list(repo), []);
  ext = true;
  clock.advance(299_000);
  assert.equal(await p.available(), false, 'cached');
  clock.advance(2000);
  assert.equal(await p.available(), true);
  assert.equal(p.reason(), null);
  assert.equal(az.calls.filter((c) => c.args[0] === 'version').length, 2);
});

test('available: az not found or failing', async () => {
  const none = provider({ resolve: () => ({ ok: false, reason: 'not-found' }), run: fakeAz().run }).p;
  assert.equal(await none.available(), false);
  assert.match(none.reason()!, /not found/);
  const broken = provider({ run: fakeAz({ version: () => ({ code: 1, stdout: '', stderr: 'boom\n' }) }).run }).p;
  assert.equal(await broken.available(), false);
  assert.match(broken.reason()!, /az version failed: boom/);
});

// --- launch strategy on fake Windows layouts --------------------------------

const WBIN = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin';
const PY = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe';

test('launch: a real az.exe is started directly', () => {
  const r = resolveAzLaunch({ platform: 'win32', resolve: () => ({ ok: true, path: 'C:\\tools\\az.exe' }), exists: () => false });
  assert.deepEqual(r, { ok: true, launch: { kind: 'exe', file: 'C:\\tools\\az.exe', args: [], env: {} } });
});

test('launch: an az.cmd shim next to the bundled Python starts python.exe -IBm azure.cli', async () => {
  const resolve = (): ResolveResult => ({ ok: false, reason: 'shim', path: `${WBIN}\\az.cmd` });
  const r = resolveAzLaunch({ platform: 'win32', resolve, exists: (p) => p === PY });
  assert.deepEqual(r, { ok: true, launch: { kind: 'python', file: PY, args: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' }, shim: `${WBIN}\\az.cmd` } });

  const az = fakeAz();
  const p = createAzurePrProvider({ platform: 'win32', resolve, exists: (x) => x === PY, run: az.run, remotes: async () => null, env: { PATH: 'x' } });
  const win: Project = { id: 'w', path: 'C:\\Work\\a & b "c"', name: 'a', kind: 'git' };
  assert.equal((await p.list(win)).length, 2);
  for (const c of az.calls) {
    assert.equal(c.file, PY);
    assert.deepEqual(c.args.slice(0, 2), ['-IBm', 'azure.cli']);
    assert.equal(c.opts?.env?.AZ_INSTALLER, 'MSI');
    assert.equal(c.opts?.env?.PATH, 'x');
  }
  assert.deepEqual(az.calls.at(-1)!.args, ['-IBm', 'azure.cli', ...AZ_PR_LIST_ARGS]);
  assert.equal(az.calls.at(-1)!.opts?.cwd, win.path);
});

test('launch: a shim without the bundled Python is unavailable with a reason, and az never runs', async () => {
  const resolve = (): ResolveResult => ({ ok: false, reason: 'shim', path: 'C:\\Users\\x\\scoop\\shims\\az.cmd' });
  const r = resolveAzLaunch({ platform: 'win32', resolve, exists: () => false });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /script shim .*no bundled Python .*cmd\.exe/);
  const az = fakeAz();
  const p = createAzurePrProvider({ platform: 'win32', resolve, exists: () => false, run: az.run, remotes: async () => null });
  assert.equal(await p.available(), false);
  assert.match(p.reason()!, /shim/);
  assert.deepEqual(await p.list({ ...repo, path: 'C:\\w' }), []);
  assert.equal(az.calls.length, 0);
  const direct = await p.az(['version']);
  assert.equal(direct.code, null);
  assert.equal(az.calls.length, 0);
});
