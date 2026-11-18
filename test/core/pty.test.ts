import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeClient } from '../../src/core/opencode.ts';
import { openPty } from '../../src/core/pty.ts';
import { AUTH, PASSWORD, startFakeServer, waitFor, type FakeServer, type FakeSocket } from './fake-server.ts';

function ptyService(): Promise<FakeServer & { state: { status: string; exitCode?: number; deleted: boolean; sizes: unknown[]; slowGet: boolean } }> {
  const state = { status: 'running', exitCode: undefined as number | undefined, deleted: false, sizes: [] as unknown[], slowGet: false };
  return startFakeServer((r) => {
    if (r.path === '/api/pty' && r.method === 'POST') {
      return { json: { location: { directory: r.query.get('location[directory]') }, data: { id: 'pty_1', ...r.body, status: 'running', pid: 1 } } };
    }
    if (r.path === '/api/pty/pty_1' && r.method === 'PUT') {
      state.sizes.push(r.body.size);
      return { json: { data: { id: 'pty_1' } } };
    }
    if (r.path === '/api/pty/pty_1' && r.method === 'GET') {
      if (state.slowGet) return new Promise((res) => setTimeout(() => res({ json: { data: { id: 'pty_1', status: state.status } } }), 100));
      if (state.deleted) return { status: 404, json: { _tag: 'PtyNotFoundError', message: 'PTY session not found' } };
      return { json: { data: { id: 'pty_1', status: state.status, exitCode: state.exitCode } } };
    }
    if (r.path === '/api/pty/pty_1' && r.method === 'DELETE') {
      state.deleted = true;
      return { status: 204 };
    }
    return undefined;
  }).then((f) => Object.assign(f, { state }));
}

const ctl = (o: unknown) => Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(o))]);

test('pty: create, size, header auth, output, control frames, input, resize, exit, close', async () => {
  const fake = await ptyService();
  const client = new OpenCodeClient({ discover: async () => ({ url: fake.url, password: PASSWORD, source: 't' }) });
  let sock: FakeSocket | null = null;
  fake.onSocket = (s) => {
    sock = s;
    s.sendBinary(ctl({ cursor: 0 }));
    s.sendText('hello é😀\r\n');
  };
  try {
    const pty = await openPty(client, { command: '/bin/prog', args: ['-x', 'a b'], cwd: '/work dir', cols: 100, rows: 30, env: { A: '1' } });
    const out: string[] = [];
    let exit: unknown = null;
    pty.onData = (d) => out.push(d);
    pty.onExit = (i) => (exit = i);
    assert.equal(pty.id, 'pty_1');
    const create = fake.requests[0]!;
    assert.equal(create.query.get('location[directory]'), '/work dir');
    assert.deepEqual(create.body, { command: '/bin/prog', args: ['-x', 'a b'], cwd: '/work dir', title: '/bin/prog', env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', A: '1' } });
    assert.deepEqual(fake.state.sizes[0], { rows: 30, cols: 100 });
    await waitFor(() => out.join('') === 'hello é😀\r\n', 3000, 'output');
    const s = sock as unknown as FakeSocket;
    assert.equal(s.headers.authorization, AUTH);
    assert.equal(s.path, '/api/pty/pty_1/connect');
    assert.equal(s.query.get('cursor'), '0');
    assert.equal(s.query.get('location[directory]'), '/work dir');
    assert.ok(!s.query.toString().includes(PASSWORD));
    pty.write('ls\r');
    await waitFor(() => s.received.length === 1, 3000, 'input');
    assert.deepEqual(s.received[0], { text: true, data: Buffer.from('ls\r') });
    pty.resize(80, 24);
    await waitFor(() => fake.state.sizes.length === 2, 3000, 'resize');
    assert.deepEqual(fake.state.sizes[1], { rows: 24, cols: 80 });
    fake.state.status = 'exited';
    fake.state.exitCode = 3;
    s.close(1000);
    await waitFor(() => exit !== null, 3000, 'exit');
    assert.deepEqual(exit, { exitCode: 3, reason: 'exited' });
    await pty.close();
    assert.equal(fake.state.deleted, true);
    assert.deepEqual(exit, { exitCode: 3, reason: 'exited' }, 'onExit only one time');
  } finally {
    await fake.close();
  }
});

test('pty: reconnect with cursor after a dropped socket, queued input is sent', async () => {
  const fake = await ptyService();
  const client = new OpenCodeClient({ discover: async () => ({ url: fake.url, password: PASSWORD, source: 't' }) });
  const socks: FakeSocket[] = [];
  fake.onSocket = (s) => {
    socks.push(s);
    if (socks.length === 1) {
      s.sendBinary(ctl({ cursor: 0 }));
      s.sendText('abc');
      s.sendText('😀');
    } else {
      s.sendText('replay');
      s.sendBinary(ctl({ cursor: 50 }));
      s.sendText('Z');
    }
  };
  try {
    const pty = await openPty(client, { command: 'x', args: [], cwd: '/w', cols: 10, rows: 5 }, { reconnectDelayMs: 5 });
    const out: string[] = [];
    let exit: any = null;
    pty.onData = (d) => out.push(d);
    pty.onExit = (i) => (exit = i);
    await waitFor(() => out.join('') === 'abc😀', 3000, 'first output');
    fake.state.slowGet = true;
    socks[0]!.destroy();
    // Input typed while the client knows the socket is down waits for the reconnect.
    // (Input sent into a socket that is dying but not yet closed is lost, as in any terminal.)
    await new Promise((r) => setTimeout(r, 30));
    pty.write('typed');
    await waitFor(() => socks.length === 2, 3000, 'reconnect');
    assert.equal(socks[1]!.query.get('cursor'), '5', 'cursor counts UTF-16 units');
    await waitFor(() => out.join('') === 'abc😀replayZ', 3000, 'replay');
    await waitFor(() => socks[1]!.received.length === 1, 3000, 'queued input');
    assert.equal(socks[1]!.received[0]!.data.toString(), 'typed');
    await pty.close();
    assert.deepEqual(exit, { exitCode: null, reason: 'closed' });
    assert.equal(fake.state.deleted, true);
  } finally {
    await fake.close();
  }
});

test('pty: PTY removed elsewhere -> exited; service gone -> disconnected', async () => {
  const fake = await ptyService();
  const client = new OpenCodeClient({ discover: async () => ({ url: fake.url, password: PASSWORD, source: 't' }) });
  fake.onSocket = (s) => s.sendBinary(ctl({ cursor: 0 }));
  try {
    const pty = await openPty(client, { command: 'x', args: [], cwd: '/w', cols: 10, rows: 5 }, { reconnectDelayMs: 5 });
    let exit: any = null;
    pty.onExit = (i) => (exit = i);
    await waitFor(() => fake.sockets.length === 1, 3000, 'socket');
    fake.state.deleted = true;
    fake.sockets[0]!.close(4404, 'session exited');
    await waitFor(() => exit !== null, 3000, 'exit');
    assert.deepEqual(exit, { exitCode: null, reason: 'exited' });
  } finally {
    await fake.close();
  }

  const fake2 = await ptyService();
  const url = fake2.url;
  const client2 = new OpenCodeClient({ discover: async () => ({ url, password: PASSWORD, source: 't' }) });
  fake2.onSocket = (s) => s.sendBinary(ctl({ cursor: 0 }));
  const pty2 = await openPty(client2, { command: 'x', args: [], cwd: '/w', cols: 10, rows: 5 }, { reconnectDelayMs: 2, maxReconnects: 3 });
  let exit2: any = null;
  pty2.onExit = (i) => (exit2 = i);
  await waitFor(() => fake2.sockets.length === 1, 3000, 'socket 2');
  await fake2.close();
  await waitFor(() => exit2 !== null, 5000, 'disconnected');
  assert.deepEqual(exit2, { exitCode: null, reason: 'disconnected' });
  await pty2.close();
});
