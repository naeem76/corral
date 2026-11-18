// Live tests against the real OpenCode service. Opt-in: NEBULA_LIVE=1.
// Safety: a new scratch directory for each test; only sessions and PTYs made here are
// changed or deleted; no prompt is sent to a model; the service is never stopped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeClient, OpenCodeError } from '../../src/core/opencode.ts';
import { openPty } from '../../src/core/pty.ts';
import { SessionTracker } from '../../src/core/sessions.ts';
import { waitFor } from './fake-server.ts';

async function caught(p: Promise<unknown>): Promise<OpenCodeError> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e) => e as OpenCodeError,
  );
}

const skip = process.env.NEBULA_LIVE === '1' ? false : 'set NEBULA_LIVE=1 to run live tests';

// A fixed name: OpenCode keeps a project record per directory and cannot delete one.
async function scratch(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'nebula-live-scratch');
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    return await realpath(dir);
  } catch {
    return realpath(await mkdtemp(path.join(os.tmpdir(), 'nebula-live-')));
  }
}

test('live: PTY round trip with a Node one-liner', { skip, timeout: 30_000 }, async () => {
  const dir = await scratch();
  const client = new OpenCodeClient();
  const script = [
    "process.stdin.setRawMode && process.stdin.setRawMode(true);",
    "process.stdout.write('READY ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');",
    "process.stdout.on('resize', () => process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));",
    "process.stdin.on('data', (d) => { const s = d.toString(); process.stdout.write('ECHO ' + JSON.stringify(s) + '\\r\\n'); if (s.includes('q')) process.exit(5); });",
  ].join('');
  const pty = await openPty(client, { command: process.execPath, args: ['-e', script], cwd: dir, cols: 90, rows: 25, title: 'nebula-live' });
  let out = '';
  let exit: any = null;
  pty.onData = (d) => (out += d);
  pty.onExit = (i) => (exit = i);
  try {
    await waitFor(() => out.includes('READY 90x25'), 10_000, 'READY');
    pty.write('héllo😀');
    await waitFor(() => out.includes('ECHO "héllo😀"'), 5000, 'echo');
    pty.resize(70, 20);
    await waitFor(() => out.includes('SIZE 70x20'), 5000, 'resize');
    pty.write('q');
    await waitFor(() => exit !== null, 5000, 'exit');
    assert.deepEqual(exit, { exitCode: 5, reason: 'exited' });
  } finally {
    await pty.close();
    const gone = await caught(client.request('GET', `/api/pty/${pty.id}`, { query: { 'location[directory]': dir } }));
    assert.ok(gone instanceof OpenCodeError && gone.status === 404, 'PTY removed');
    await rm(dir, { recursive: true, force: true });
  }
});

test('live: session create, rename, archive, remove through the tracker', { skip, timeout: 30_000 }, async () => {
  const dir = await scratch();
  const client = new OpenCodeClient();
  const created: string[] = [];
  const tracker = new SessionTracker({ client, throttleMs: 10 });
  try {
    await waitFor(() => tracker.connected, 10_000, 'event stream');
    await tracker.watch([dir]);
    assert.deepEqual(tracker.rows(dir), []);
    const id = await tracker.create(dir, 'nebula live test');
    created.push(id);
    assert.equal(tracker.rows(dir)[0]?.id, id);
    assert.equal(tracker.rows(dir)[0]?.status, 'idle');

    // A session made by another client arrives through the event stream.
    const other = await client.request<{ data: { id: string } }>('POST', '/api/session', { body: { title: 'other', location: { directory: dir } } });
    created.push(other.data.id);
    await waitFor(() => tracker.get(other.data.id) !== undefined, 5000, 'session.created event');
    // A rename by another client, too.
    await client.request('PATCH', `/api/session/${other.data.id}`, { body: { title: 'other renamed' } });
    await waitFor(() => tracker.get(other.data.id)?.title === 'other renamed', 5000, 'session.renamed event');

    await tracker.rename(id, 'renamed');
    await tracker.archive(id);
    const got = await client.request<{ data: { title: string; time: { archived?: number } } }>('GET', `/api/session/${id}`);
    assert.equal(got.data.title, 'renamed');
    assert.ok(got.data.time.archived);
    assert.equal(tracker.rows(dir).find((r) => r.id === id)?.archived, true);
    await tracker.unarchive(id);
    await tracker.remove(id);
    created.splice(created.indexOf(id), 1);
    const err = await caught(client.request('GET', `/api/session/${id}`));
    assert.equal(err.tag, 'SessionNotFoundError');
    await tracker.refresh();
    assert.deepEqual(tracker.rows(dir).map((r) => r.id), [other.data.id]);
  } finally {
    tracker.dispose();
    for (const id of created) await client.request('DELETE', `/api/session/${id}`).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
