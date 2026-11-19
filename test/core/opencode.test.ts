import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverService, ensureService, OpenCodeClient, OpenCodeError, type ServiceInfo } from '../../src/core/opencode.ts';
import { AUTH, PASSWORD, startFakeServer } from './fake-server.ts';

async function caught(p: Promise<unknown>): Promise<OpenCodeError> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e) => e as OpenCodeError,
  );
}

const info = (url: string, password = PASSWORD): ServiceInfo => ({ url, password, source: 'test' });

test('discovery: env override, then service.json', async () => {
  assert.deepEqual(await discoverService({ env: { CORRAL_OPENCODE_URL: 'http://h:1/', CORRAL_OPENCODE_PASSWORD: 'p' } }), {
    url: 'http://h:1',
    password: 'p',
    source: 'env',
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'corral-oc-'));
  const file = path.join(dir, 'service.json');
  assert.equal(await discoverService({ env: { CORRAL_OPENCODE_SERVICE_FILE: file } }), null);
  await writeFile(file, JSON.stringify({ id: 'x', version: '2.3.2', url: 'http://127.0.0.1:5', pid: 9, password: 'pw' }));
  const s = await discoverService({ env: { CORRAL_OPENCODE_SERVICE_FILE: file } });
  assert.equal(s?.url, 'http://127.0.0.1:5');
  assert.equal(s?.password, 'pw');
  assert.equal(s?.version, '2.3.2');
  await writeFile(file, '{"url": "http://half');
  assert.equal(await discoverService({ env: { CORRAL_OPENCODE_SERVICE_FILE: file } }), null);
  const viaHome = await discoverService({ env: {}, platform: 'linux', homedir: '/h', readFile: async (p) => {
    if (p === '/h/.local/state/opencode/service.json') return '{"url":"http://a:1","password":"z"}';
    throw new Error('ENOENT');
  } });
  assert.equal(viaHome?.url, 'http://a:1');
  await rm(dir, { recursive: true, force: true });
});

test('ensureService starts the service when the file is absent', async () => {
  let started = 0;
  let calls: string[][] = [];
  const s = await ensureService({
    env: {},
    platform: 'linux',
    homedir: '/h',
    readFile: async () => {
      if (started) return '{"url":"http://a:2","password":"q"}';
      throw new Error('ENOENT');
    },
    resolve: () => ({ ok: true, path: '/bin/opencode' }),
    run: async (file, args) => {
      calls.push([file, ...args]);
      started++;
      return { code: 0, stdout: '', stderr: '' };
    },
    sleep: async () => {},
  });
  assert.deepEqual(calls, [['/bin/opencode', 'service', 'start']]);
  assert.equal(s.url, 'http://a:2');
  await assert.rejects(
    ensureService({ env: {}, platform: 'win32', homedir: 'C:\\U', readFile: async () => { throw new Error('x'); }, resolve: () => ({ ok: false, reason: 'shim', path: 'C:\\npm\\opencode.cmd' }) }),
    (e: OpenCodeError) => e.tag === 'ServiceNotFound' && e.message.includes('opencode.cmd'),
  );
});

test('request sends Basic auth, JSON, query; errors carry _tag and never the password', async () => {
  const fake = await startFakeServer((r) => {
    if (r.path === '/api/session' && r.method === 'POST') return { json: { data: { id: 'ses_1', echo: r.body } } };
    if (r.path === '/api/session') return { json: { data: [], q: Object.fromEntries(r.query) } };
    if (r.path === '/api/session/ses_x') return { status: 404, json: { _tag: 'SessionNotFoundError', sessionID: 'ses_x', message: 'Session not found: ses_x' } };
    if (r.path === '/api/weird') return { status: 200, json: { _tag: 'UnknownError', message: 'bad ' + PASSWORD } };
    if (r.path === '/api/empty') return { status: 204 };
    return undefined;
  });
  try {
    const c = new OpenCodeClient({ discover: async () => info(fake.url) });
    const created = await c.request<{ data: { id: string; echo: unknown } }>('POST', '/api/session', { body: { title: 'a' } });
    assert.equal(created.data.id, 'ses_1');
    assert.deepEqual(created.data.echo, { title: 'a' });
    assert.equal(fake.requests[0]?.headers.authorization, AUTH);
    assert.equal(fake.requests[0]?.headers['content-type'], 'application/json');
    const listed = await c.request<{ q: Record<string, string> }>('GET', '/api/session', { query: { directory: 'C:\\a b&c', 'location[directory]': '/x', skip: undefined } });
    assert.deepEqual(listed.q, { directory: 'C:\\a b&c', 'location[directory]': '/x' });
    assert.equal(await c.request('DELETE', '/api/empty'), undefined);
    for (const p of ['/api/session/ses_x', '/api/weird', '/api/missing']) {
      const err = await c.request('GET', p).then(() => null, (e) => e);
      assert.ok(err instanceof OpenCodeError, p);
      assert.ok(!err.message.includes(PASSWORD), err.message);
      assert.ok(!err.message.includes(AUTH.slice(6)), err.message);
      assert.ok(!JSON.stringify(err).includes(PASSWORD));
      assert.ok(!String(err.stack).includes(PASSWORD));
    }
    const nf = await caught(c.request('GET', '/api/session/ses_x'));
    assert.equal(nf.status, 404);
    assert.equal(nf.tag, 'SessionNotFoundError');
    for (const r of fake.requests) assert.ok(!r.path.includes(PASSWORD) && !r.query.toString().includes(PASSWORD));

    const bad = new OpenCodeClient({ discover: async () => info(fake.url, 'wrong-password-123') });
    const unauth = await caught(bad.request('GET', '/api/session'));
    assert.equal(unauth.status, 401);
    assert.equal(unauth.tag, 'UnauthorizedError');
    assert.ok(!unauth.message.includes('wrong-password-123'));
  } finally {
    await fake.close();
  }
});

test('connection error triggers discovery again (service restarted on a new port)', async () => {
  const fake = await startFakeServer(() => ({ json: { ok: true } }));
  let n = 0;
  try {
    const c = new OpenCodeClient({ discover: async () => (n++ === 0 ? info('http://127.0.0.1:1') : info(fake.url)) });
    assert.deepEqual(await c.request('GET', '/api/info'), { ok: true });
    assert.equal(n, 2);
    const dead = new OpenCodeClient({ discover: async () => info('http://127.0.0.1:1') });
    const err = await caught(dead.request('GET', '/api/info'));
    assert.equal(err.tag, 'ConnectionError');
    assert.ok(!err.message.includes(PASSWORD));
    const none = new OpenCodeClient({ discover: async () => null });
    assert.equal((await caught(none.request('GET', '/x'))).tag, 'ServiceNotFound');
  } finally {
    await fake.close();
  }
});

test('timeout and abort', async () => {
  const fake = await startFakeServer(() => new Promise((r) => setTimeout(() => r({ json: 1 }), 500)));
  try {
    const c = new OpenCodeClient({ discover: async () => info(fake.url) });
    assert.equal((await caught(c.request('GET', '/slow', { timeoutMs: 50 }))).tag, 'Timeout');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    assert.equal((await caught(c.request('GET', '/slow', { signal: ac.signal, timeoutMs: 0 }))).tag, 'Aborted');
  } finally {
    await fake.close();
  }
});

test('ensureService treats the file of a dead service as absent and starts the service', async () => {
  let started = 0;
  const calls: string[][] = [];
  const s = await ensureService({
    env: {},
    platform: 'linux',
    homedir: '/h',
    // A killed service left its file behind; after the start a new file names a live pid.
    readFile: async () => (started ? '{"url":"http://a:2","password":"q","pid":20}' : '{"url":"http://a:1","password":"p","pid":10}'),
    isAlive: (pid) => pid === 20,
    resolve: () => ({ ok: true, path: '/bin/opencode' }),
    run: async (file, args) => {
      calls.push([file, ...args]);
      started++;
      return { code: 0, stdout: '', stderr: '' };
    },
    sleep: async () => {},
  });
  assert.equal(s.url, 'http://a:2');
  assert.deepEqual(calls, [['/bin/opencode', 'service', 'start']]);
});

test('ensureService keeps a file whose service process is alive', async () => {
  const s = await ensureService({
    env: {},
    platform: 'linux',
    homedir: '/h',
    readFile: async () => '{"url":"http://a:1","password":"p","pid":10}',
    isAlive: () => true,
    run: async () => {
      throw new Error('must not start the service');
    },
  });
  assert.equal(s.url, 'http://a:1');
});
