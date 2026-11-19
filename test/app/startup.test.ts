import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OpenCodeError } from '../../src/core/opencode.ts';
import { createLauncher } from '../../src/tui/app/launcher.ts';
import { buildBindings, helpLines } from '../../src/tui/app/bindings.ts';
import { formatBinding } from '../../src/tui/keys.ts';
import { FakeService, harness, PASSWORD, until, type Harness } from './helpers.ts';
import { modal } from './helpers.ts';

async function oneSession(opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; dir: string; id: string }> {
  let dir = '';
  const service = opts.service ?? new FakeService();
  const h = await harness({
    ...opts,
    service,
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
      await opts.setupState?.(store, d);
    },
  });
  const id = h.service.addSession({ directory: dir, title: 'Only session' }).id;
  await h.tracker.refresh();
  await h.settle();
  return { h, dir, id };
}

test('stale PTY cleanup deletes only dead-pid nebula-enterprise PTYs', async () => {
  const service = new FakeService();
  let dir = '';
  const extra = '/elsewhere/recorded';
  service.ptys = [];
  const h = await harness({
    service,
    deps: { isAlive: (pid) => pid === 777 },
    ensureService: async () => {
      // Fill the PTY list just before the app looks at it.
      service.ptys.push(
        { id: 'pty_dead', title: 'nebula-enterprise:111:ses_a', dir },
        { id: 'pty_alive', title: 'nebula-enterprise:777:ses_b', dir },
        { id: 'pty_user', title: 'my shell', dir },
        { id: 'pty_other', title: 'nebula-enterprise-x:111:ses_c', dir },
        { id: 'pty_rec', title: 'nebula-enterprise:222:ses_d', dir: extra },
      );
    },
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
      store.setUi({ ptyDirs: [extra] });
    },
  });
  try {
    await until(() => !service.ptys.some((p) => p.id === 'pty_rec'), 2000, 'cleanup');
    assert.deepEqual(service.ptys.map((p) => p.id).sort(), ['pty_alive', 'pty_other', 'pty_user']);
    const deletes = service.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
    assert.deepEqual(deletes.sort(), ['/api/pty/pty_dead', '/api/pty/pty_rec']);
    // The folder with a live instance's PTY is remembered for the next start.
    assert.deepEqual(h.store.ui.ptyDirs, [dir]);
  } finally {
    await h.dispose();
  }
});

test('a version mismatch blocks the spawn with a message', async () => {
  const launcher = createLauncher({
    resolve: () => ({ ok: true, path: '/opt/opencode' }),
    run: async () => ({ code: 0, stdout: 'opencode v2.4.0\n', stderr: '' }),
    serviceVersion: async () => '2.3.2',
  });
  const { h } = await oneSession({ launcher });
  try {
    await h.type('ll');
    await h.type('\r', 80);
    assert.equal(h.ptys.length, 0, 'no PTY was created');
    assert.equal(h.app.focus, 'sessions');
    const t = h.text();
    assert.match(t, /Version mismatch/);
    assert.match(t, /opencode service restart/);
    // The hand-off is blocked the same way.
    let ran = false;
    h.deps.runChild = async () => ((ran = true), { code: 0 });
    await h.type('O', 60);
    assert.equal(ran, false);
    assert.equal(h.term.suspendCount, 0);
  } finally {
    await h.dispose();
  }
});

test('the launcher allows equal versions and checks the CLI only once', async () => {
  let runs = 0;
  const launcher = createLauncher({
    resolve: () => ({ ok: true, path: '/opt/opencode' }),
    run: async () => (runs++, { code: 0, stdout: '2.3.2\n', stderr: '' }),
    serviceVersion: async () => '2.3.2',
  });
  assert.deepEqual(await launcher.prepare(), { ok: true, command: '/opt/opencode', shimNote: null, runnableHere: true });
  await launcher.prepare();
  assert.equal(runs, 1);
  const shim = createLauncher({
    resolve: () => ({ ok: false, reason: 'shim', path: 'C:\\npm\\opencode.cmd' }),
    run: async () => ({ code: 0, stdout: '2.3.2', stderr: '' }),
    serviceVersion: async () => undefined,
  });
  const plan = await shim.prepare();
  assert.ok(plan.ok && plan.command === 'opencode' && plan.shimNote?.includes('shim') && !plan.runnableHere);
});

test('service absent at start: the message shows, the UI works, nothing crashes', async () => {
  const service = new FakeService();
  service.down = true;
  let dir = '';
  const h = await harness({
    service,
    connect: false,
    ensureService: async () => {
      throw new OpenCodeError(0, 'ServiceNotFound', `OpenCode service is not running, and opencode: not found on PATH (${PASSWORD})`);
    },
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
    },
  });
  try {
    const t = h.text();
    assert.match(t, /OpenCode service not available/);
    assert.match(t, /doctor/);
    assert.match(t, /OpenCode offline/);
    assert.ok(!t.includes(PASSWORD));
    // Keys still work.
    await h.type('l');
    assert.equal(h.app.focus, 'git');
    await h.type('l');
    await h.type('n', 60);
    assert.match(h.text(), /not available/);
    // The service comes back: the tracker connects and the sessions appear.
    service.down = false;
    service.addSession({ directory: dir, title: 'Back again' });
    h.events.connect();
    await until(() => h.text().includes('Back again'), 2000, 'sessions after reconnect');
    assert.match(h.text(), /● OpenCode/);
  } finally {
    await h.dispose();
  }
});

test('the PTY API answers 404: the full-window hand-off runs instead', async () => {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const { h, dir, id } = await oneSession({
    openPty: async () => {
      throw new OpenCodeError(404, 'HTTP404', 'POST /api/pty: 404');
    },
  });
  try {
    h.deps.runChild = async (file, args, cwd) => {
      calls.push({ file, args, cwd });
      assert.equal(h.term.suspended, true, 'the terminal is suspended while the child runs');
      return { code: 0 };
    };
    await h.type('ll');
    await h.type('\r', 100);
    assert.deepEqual(calls, [{ file: '/usr/bin/opencode', args: ['--session', id], cwd: dir }]);
    assert.equal(h.term.suspended, false);
    assert.equal(h.term.suspendCount, 1);
    // O runs it directly.
    await h.type('O', 60);
    assert.equal(calls.length, 2);
  } finally {
    await h.dispose();
  }
});

test('narrow window: columns shrink, then the pane hides behind them', async () => {
  const { h } = await oneSession({ cols: 120, rows: 24 });
  try {
    let lay = h.app.layout();
    assert.ok(lay.columns && lay.pane, 'all visible at 120 columns');
    assert.ok((lay.pane?.w ?? 0) >= 40);
    h.term.resizeTo(70, 24);
    lay = h.app.layout();
    assert.equal(lay.pane, null, 'the pane is hidden at 70 columns');
    assert.ok(lay.columns);
    const t = h.text();
    assert.match(t, /Projects/);
    assert.match(t, /Sessions/);
    // Opening a session shows the pane over the whole width while it has focus.
    await h.type('ll');
    await h.type('\r', 80);
    assert.equal(h.app.focus, 'pane');
    lay = h.app.layout();
    assert.equal(lay.columns, null);
    assert.equal(lay.paneInner?.w, 70);
    assert.equal(h.ptys[0]?.spawn.cols, 70);
    await h.type('\x11');
    assert.ok(h.app.layout().columns);
    // Every row of the frame has exactly the window width (no overflow).
    for (const row of h.screen()) assert.ok([...row].length <= 70);
  } finally {
    await h.dispose();
  }
});

test('the help overlay lists the same bindings as the table', async () => {
  const { h } = await oneSession({ rows: 80 });
  try {
    await h.type('?');
    assert.equal(modal(h)?.kind, 'help');
    const t = h.text();
    const table = buildBindings();
    for (const def of table) assert.ok(t.includes(def.help.slice(0, 40)), `help shows: ${def.help}`);
    for (const l of helpLines(table)) if (l.key) assert.ok(t.includes(l.key.slice(0, 17)), `key ${l.key}`);
    assert.ok(t.includes(formatBinding('ctrl+q')));
    await h.type('x');
    assert.equal(modal(h), null);
  } finally {
    await h.dispose();
  }
});

test('the password never appears in a frame or a log line', async () => {
  const logs: string[] = [];
  const { h } = await oneSession({
    openPty: async () => {
      throw new OpenCodeError(500, 'BoomError', `failed with ${PASSWORD} and Basic ${Buffer.from('opencode:' + PASSWORD).toString('base64')}`);
    },
  });
  try {
    h.deps.log = (l) => logs.push(l);
    await h.type('ll');
    await h.type('\r', 80);
    const frames = h.term.out.join('') + h.text();
    assert.ok(frames.includes('failed with'), 'the error is shown');
    assert.ok(!frames.includes(PASSWORD));
    for (const l of [...logs, ...h.logs]) assert.ok(!l.includes(PASSWORD), l);
  } finally {
    await h.dispose();
  }
});

test('a script shim: the version comes from the npm package next to it', async () => {
  const shim = { ok: false as const, reason: 'shim' as const, path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd' };
  const files: Record<string, string> = {
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\package.json': '{"name":"opencode-ai","version":"2.3.2"}',
  };
  const read = async (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };
  const base = { resolve: () => shim, run: async () => ({ code: null, stdout: '', stderr: '' }), readFile: read, platform: 'win32' as const };
  const same = await createLauncher({ ...base, serviceVersion: async () => '2.3.2' }).prepare();
  assert.deepEqual(same, { ok: true, command: 'opencode', shimNote: same.ok ? same.shimNote : null, runnableHere: false, warning: undefined });
  const other = await createLauncher({ ...base, serviceVersion: async () => '2.4.0' }).prepare();
  assert.ok(!other.ok && /Version mismatch: the opencode CLI is 2\.3\.2/.test(other.message));
  files['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\package.json'] = 'not json';
  const unknown = await createLauncher({ ...base, serviceVersion: async () => '2.3.2' }).prepare();
  assert.ok(unknown.ok && /was not checked/.test(unknown.warning ?? ''));
  // Not found at all: the service resolves "opencode" itself; the warning says the version is unknown.
  const missing = await createLauncher({ ...base, resolve: () => ({ ok: false, reason: 'not-found' }), serviceVersion: async () => '2.3.2' }).prepare();
  assert.ok(missing.ok && missing.command === 'opencode' && /not found on PATH/.test(missing.warning ?? ''));
});

test('service lost while running: a user action starts it again and then works', async () => {
  const service = new FakeService();
  service.down = true;
  let dir = '';
  let up = false;
  let starts = 0;
  const h = await harness({
    service,
    connect: false,
    // Fails at program start; works when the user acts (the service can be started again).
    ensureService: async () => {
      starts++;
      if (!up) throw new OpenCodeError(0, 'ServiceNotFound', 'OpenCode service is not running');
      service.down = false;
    },
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
    },
  });
  try {
    assert.match(h.text(), /OpenCode service not available/);
    const before = starts;
    await h.type('l');
    await h.type('l');
    assert.equal(h.app.focus, 'sessions');
    up = true;
    await h.type('n', 60);
    await until(() => service.requests.some((r) => r.method === 'POST' && r.path === '/api/session'), 2000, 'session create');
    assert.ok(starts > before, 'the action asked for the service again');
    assert.ok(!/Cannot create the session/.test(h.text()));
  } finally {
    await h.dispose();
  }
});
