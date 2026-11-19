// Copilot sessions next to OpenCode sessions: tags, order, the `n` menu, the pane and the
// full-window fallback, actions by capability, local archive and inbox marks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OpenCodeError } from '../../src/core/opencode.ts';
import {
  FakeService, finishedTurn, harness, modal, until, writeCopilotSession, type Harness, type HarnessOptions,
} from './helpers.ts';

/** Print a screen for review: CORRAL_SHOW_SCREENS=1. */
function show(lines: string[]): void {
  if (process.env.CORRAL_SHOW_SCREENS === '1') console.log(lines.join('\n'));
}

const CP1 = 'c0c0c0c0-1111-4111-8111-111111111111';
const CP2 = 'c0c0c0c0-2222-4222-8222-222222222222';

interface Fixture {
  h: Harness;
  dir: string;
}

/** One project with OpenCode and Copilot sessions in its folder. */
async function both(opts: HarnessOptions & { view?: 'projects' | 'inbox' } = {}): Promise<Fixture> {
  let dir = '';
  const now = Date.now();
  const h = await harness({
    cols: 140,
    rows: 24,
    ...opts,
    setupState: async (store, d) => {
      dir = path.join(d, 'proj');
      await mkdir(dir);
      await store.addProject(dir);
      if (opts.view) store.setUi({ view: opts.view });
      await opts.setupState?.(store, d);
    },
    copilot: {
      ...opts.copilot,
      setup: async (home, d) => {
        const cwd = path.join(d, 'proj');
        await writeCopilotSession(home, { id: CP1, cwd, name: 'copilot finished', events: finishedTurn(now - 60_000) });
        await writeCopilotSession(home, {
          id: CP2,
          cwd,
          name: 'copilot asks',
          events: [
            { type: 'session.start', at: now - 20_000 },
            { type: 'user.message', at: now - 19_000 },
            { type: 'assistant.turn_start', at: now - 18_000 },
            { type: 'tool.execution_start', at: now - 17_000 },
            { type: 'permission.requested', at: now - 16_000, requestId: 'r1' },
          ],
        });
        await opts.copilot?.setup?.(home, d);
      },
    },
  });
  if (opts.service?.down !== true) {
    h.service.addSession({ id: 'ses_old', directory: dir, title: 'opencode old', updated: now - 3_600_000 });
    // Newer than the Copilot files (a Copilot row is as new as its last file change).
    h.service.addSession({ id: 'ses_new', directory: dir, title: 'opencode new', updated: now + 60_000, idle: now + 60_000 });
    await h.tracker.refresh();
  }
  await until(() => h.hub.rows(dir).some((r) => r.agent === 'copilot'), 3000, 'copilot rows');
  await h.settle();
  return { h, dir };
}

test('agents: both agents in one Sessions column, tagged, in one attention order', async () => {
  const { h } = await both();
  try {
    await h.type('ll');
    // Both sources fill in asynchronously: wait for the full screen, not for a fixed time.
    const titles = ['copilot asks', 'opencode new', 'copilot finished', 'opencode old'];
    await until(() => {
      const now = h.text();
      return titles.every((s) => now.includes(s)) && /Agent {5}Copilot/.test(now) && /● OpenCode · Copilot/.test(now) && / cp /.test(now) && / oc /.test(now);
    }, 3000, 'both agents on the screen');
    const t = h.text();
    const order = titles.map((s) => t.indexOf(s));
    assert.ok(order.every((i) => i >= 0), t);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'needs input, unseen (newest first), idle');
    const tags: Array<[string, string]> = [['copilot asks', 'cp'], ['opencode new', 'oc'], ['copilot finished', 'cp'], ['opencode old', 'oc']];
    for (const [title, tag] of tags) {
      const line = h.screen().find((l) => l.includes(title) && l.startsWith('│')) as string;
      assert.match(line, new RegExp(`${title}.* ${tag} `), `tag of ${title}`);
    }
    assert.match(t, /● OpenCode · Copilot/);
    // The info panel names the agent.
    assert.match(t, /Agent {5}Copilot/);
    show(['--- Sessions column, both agents ---', ...h.screen()]);
  } finally {
    await h.dispose();
  }
});

test('agents: one agent only, no tags', async () => {
  const h = await harness({ cols: 140, rows: 20, setupState: async (store, d) => {
    await mkdir(path.join(d, 'p'));
    await store.addProject(path.join(d, 'p'));
  } });
  try {
    const dir = path.join(h.dir, 'p');
    h.service.addSession({ id: 'ses_1', directory: dir, title: 'only opencode' });
    await h.tracker.refresh();
    await h.type('ll');
    const line = h.screen().find((l) => l.includes('only opencode') && l.startsWith('│')) as string;
    assert.doesNotMatch(line, / oc /);
    assert.match(h.text(), /Agent {5}OpenCode/);
  } finally {
    await h.dispose();
  }
});

test('agents: the inbox shows both agents with tags', async () => {
  const { h } = await both({ view: 'inbox' });
  try {
    await until(() => h.app.inbox.entries().length === 4, 3000, 'inbox entries');
    const t = h.text();
    assert.match(t, /Needs input \(1\)/);
    const row = (t: string) => h.screen().find((l) => l.includes(t) && l.startsWith('│')) as string;
    const asks = row('copilot asks');
    assert.match(asks, / cp /);
    const oc = row('opencode new');
    assert.match(oc, / oc /);
    show(['--- Inbox, both agents ---', ...h.screen()]);
  } finally {
    await h.dispose();
  }
});

test('agents: n opens a menu with the default first; the choice starts Copilot in the pane', async () => {
  const { h, dir } = await both();
  try {
    await h.type('ll');
    await h.type('n');
    const m = modal(h);
    assert.ok(m?.kind === 'menu');
    assert.deepEqual(m.kind === 'menu' ? m.state.items.map((i) => `${i.key} ${i.label}`) : [], ['1 OpenCode', '2 Copilot']);
    await h.type('2', 100);
    await until(() => h.ptys.length === 1, 3000, 'pty');
    const spawn = h.ptys[0]!.spawn;
    assert.equal(spawn.command, '/usr/bin/copilot');
    assert.equal(spawn.args[0], '--session-id');
    const id = spawn.args[1] as string;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(spawn.cwd, dir);
    assert.match(spawn.title ?? '', new RegExp(`^corral:4242:${id}$`));
    assert.equal(h.store.ui.defaultAgent, 'copilot');
    assert.equal(h.app.focus, 'pane');
    assert.equal(h.app.selectedSession()?.id, id);
    assert.equal(h.app.selectedSession()?.title, 'New Copilot session');
    // The next menu has Copilot first; Enter takes it.
    await h.type('\x11'); // ctrl+q leaves the pane
    await h.type('n');
    const m2 = modal(h);
    assert.deepEqual(m2?.kind === 'menu' ? m2.state.items.map((i) => `${i.key} ${i.label} ${i.detail}`) : [], ['2 Copilot default', '1 OpenCode ']);
    await h.type('\r', 100);
    await until(() => h.ptys.length === 2, 3000, 'second pty');
    assert.equal(h.ptys[1]!.spawn.command, '/usr/bin/copilot');
    // Esc on the menu creates nothing.
    await h.type('\x11');
    await h.type('n');
    await h.type('\x1b', 60);
    assert.equal(modal(h), null);
    assert.equal(h.ptys.length, 2);
    // 1 picks OpenCode.
    await h.type('n');
    await h.type('1', 120);
    await until(() => h.ptys.length === 3, 3000, 'opencode pty');
    assert.equal(h.ptys[2]!.spawn.command, '/usr/bin/opencode');
    assert.equal(h.ptys[2]!.spawn.args[0], '--session');
    assert.equal(h.store.ui.defaultAgent, 'opencode');
  } finally {
    await h.dispose();
  }
});

test('agents: an existing Copilot session resumes in the pane with --session-id', async () => {
  const { h, dir } = await both();
  try {
    await h.type('ll');
    await h.type('\r', 120); // the first row: "copilot asks"
    await until(() => h.ptys.length === 1, 3000, 'pty');
    assert.deepEqual(h.ptys[0]!.spawn.args, ['--session-id', CP2]);
    assert.equal(h.ptys[0]!.spawn.cwd, dir);
    // The program exits: the source reads its files again, the note names Copilot.
    h.ptys[0]!.exit(0);
    await h.settle(80);
    assert.match(h.text(), /Copilot exited with code 0/);
  } finally {
    await h.dispose();
  }
});

test('agents: service down, a Copilot session opens in the full window with one reason', async () => {
  const service = new FakeService();
  service.down = true;
  const { h, dir } = await both({
    service,
    connect: false,
    ensureService: async () => {
      throw new OpenCodeError(0, 'ServiceNotFound', 'OpenCode service is not running');
    },
  });
  try {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    h.deps.runChild = async (file, args, cwd) => (calls.push({ file, args, cwd }), { code: 0 });
    await h.type('ll');
    await h.type('\r', 150);
    await until(() => calls.length === 1, 3000, 'hand-off');
    assert.deepEqual(calls[0], { file: '/usr/bin/copilot', args: ['--session-id', CP2], cwd: dir });
    assert.equal(h.term.suspendCount, 1);
    await h.settle(60);
    assert.match(h.app.message?.text ?? '', /Copilot ended \(exit code 0\)\. The pane needs the OpenCode service, and the OpenCode service is not available, so Copilot ran in the full window\./);
    assert.equal(h.ptys.length, 0);
  } finally {
    await h.dispose();
  }
});

test('agents: a Copilot-only machine starts without an error and hands off', async () => {
  const service = new FakeService();
  service.down = true;
  const { h, dir } = await both({
    service,
    connect: false,
    agentInstalled: (a) => a === 'copilot',
    ensureService: async () => {
      throw new OpenCodeError(0, 'ServiceNotFound', 'OpenCode service is not running, and opencode: not found on PATH');
    },
  });
  try {
    await h.type('ll');
    const t = h.text();
    assert.equal(h.app.service, 'absent');
    assert.equal(h.app.message?.error ?? false, false, 'no red message');
    assert.doesNotMatch(t, /not available|offline/);
    assert.match(t, /● Copilot only/);
    assert.doesNotMatch(t, / cp /, 'one agent in use: no tags');
    assert.match(t, /Enter opens the session in the full window/);
    show(['--- Copilot-only machine ---', ...h.screen()]);
    // n needs no menu (one agent) and no service.
    const calls: string[][] = [];
    h.deps.runChild = async (_f, args) => (calls.push(args), { code: 0 });
    await h.type('n', 150);
    await until(() => calls.length === 1, 3000, 'hand-off of the new session');
    assert.equal(modal(h), null);
    assert.equal(calls[0]![0], '--session-id');
    // It never opened a folder: the pending row is gone after the hand-off.
    await until(() => !h.hub.rows(dir).some((r) => r.id === calls[0]![1]), 3000, 'pending row dropped');
    assert.match(h.app.message?.text ?? '', /there is no OpenCode service on this machine/);
    // R reads Copilot again, still without an error.
    await h.type('R', 80);
    assert.equal(h.app.message?.error ?? false, false);
  } finally {
    await h.dispose();
  }
});

test('agents: no agent at all explains how to install one', async () => {
  const service = new FakeService();
  service.down = true;
  const h = await harness({
    service,
    connect: false,
    cols: 140,
    rows: 20,
    agentInstalled: () => false,
    copilot: { program: false },
    ensureService: async () => {
      throw new OpenCodeError(0, 'ServiceNotFound', 'opencode: not found on PATH');
    },
    setupState: async (store, d) => {
      await mkdir(path.join(d, 'p'));
      await store.addProject(path.join(d, 'p'));
    },
  });
  try {
    await h.settle(60);
    await h.type('ll');
    const t = h.text();
    assert.match(t, /No agent found/);
    assert.match(t, /● no agent/);
    await h.type('n', 60);
    assert.match(h.app.message?.text ?? '', /No agent can start a session\. Install OpenCode/);
  } finally {
    await h.dispose();
  }
});

test('agents: rename and delete of a Copilot session explain where to do it', async () => {
  const { h } = await both();
  try {
    await h.type('ll');
    assert.equal(h.app.selectedSession()?.agent, 'copilot');
    await h.type('r');
    assert.equal(modal(h), null);
    assert.match(h.app.message?.text ?? '', /Rename it in Copilot with \/rename\./);
    await h.type('d');
    assert.equal(modal(h), null);
    assert.match(h.app.message?.text ?? '', /Delete it in Copilot with \/session delete, or archive it here with a\./);
    // OpenCode keeps its prompts.
    await h.type('j');
    assert.equal(h.app.selectedSession()?.agent, 'opencode');
    await h.type('d');
    const m = modal(h);
    assert.match(m?.kind === 'confirm' ? m.state.message : '', /Delete the session "opencode new" in OpenCode\?/);
  } finally {
    await h.dispose();
  }
});

test('agents: local archive of a Copilot session, and back', async () => {
  const { h, dir } = await both();
  try {
    await h.type('ll');
    assert.equal(h.app.selectedSession()?.id, CP2);
    await h.type('a', 60);
    assert.ok(h.store.sessionMeta(CP2)?.archivedAt);
    assert.equal(h.hub.row(CP2)?.archived, true);
    assert.ok(!h.app.sessionRows().some((r) => r.id === CP2), 'hidden');
    await h.type('A', 60);
    await until(() => h.app.sessionRows().some((r) => r.id === CP2), 2000, 'shown with A');
    h.app.lists.sessions = { ...h.app.lists.sessions, selectedKey: CP2 };
    await h.type('u', 60);
    assert.equal(h.store.sessionMeta(CP2)?.archivedAt, undefined);
    assert.equal(h.hub.rows(dir).find((r) => r.id === CP2)?.archived, false);
  } finally {
    await h.dispose();
  }
});

test('agents: snooze and settle work on a Copilot session; inbox n keeps the agent', async () => {
  const { h, dir } = await both({ view: 'inbox' });
  try {
    await until(() => h.app.inbox.entries().length === 4, 3000, 'inbox entries');
    h.app.inbox.select(CP1);
    assert.equal(h.app.selectedSession()?.id, CP1);
    await h.type('e', 60);
    assert.ok(h.store.sessionMeta(CP1)?.settledAt);
    assert.equal(h.app.inbox.entry(CP1)?.section, 'settled');
    await h.type('E', 60); // show the Settled section
    h.app.inbox.select(CP1);
    await h.type('u', 60);
    assert.equal(h.store.sessionMeta(CP1)?.settledAt, undefined);
    h.app.inbox.select(CP1);
    await h.type('s');
    await h.type('1', 60);
    assert.ok(h.store.sessionMeta(CP1)?.snoozedUntil);
    assert.equal(h.app.inbox.entry(CP1)?.section, 'snoozed');
    // n in the inbox: the agent of the selected session, no menu.
    h.app.inbox.select(CP2);
    await h.type('n', 150);
    assert.equal(modal(h), null);
    await until(() => h.ptys.length === 1, 3000, 'pty');
    assert.equal(h.ptys[0]!.spawn.command, '/usr/bin/copilot');
    assert.equal(h.ptys[0]!.spawn.cwd, dir);
  } finally {
    await h.dispose();
  }
});

test('agents: the help has an Agents section', async () => {
  const { h } = await both();
  try {
    await h.type('?');
    for (let i = 0; i < 12; i++) await h.type('\x1b[6~', 5);
    const t = h.text();
    assert.match(t, /AGENTS/);
    assert.match(t, /This machine: OpenCode and Copilot\./);
  } finally {
    await h.dispose();
  }
});

test('agents: quit warns that a Copilot pane stops; a missing copilot program is a clear error', async () => {
  const { h } = await both({ copilot: { program: true } });
  try {
    await h.type('ll');
    await h.type('\r', 120);
    await until(() => h.ptys.length === 1, 3000, 'pty');
    await h.type('\x11');
    await h.type('q');
    const m = modal(h);
    assert.match(m?.kind === 'confirm' ? m.state.message : '', /OpenCode sessions keep running in the OpenCode service\. 1 Copilot session in the pane will stop \(1 working now\)/);
    await h.type('\x1b');
  } finally {
    await h.dispose();
  }
  const missing = await both({
    copilot: { program: false },
    launcher: {
      prepare: async (agent) =>
        agent === 'copilot'
          ? { ok: false, message: 'Cannot start Copilot: copilot (GitHub Copilot CLI) not found on PATH.' }
          : { ok: true, command: '/usr/bin/opencode', shimNote: null, runnableHere: true },
    },
  });
  try {
    const h2 = missing.h;
    await h2.type('ll');
    // The old sessions are listed; opening one explains why it cannot start.
    await h2.type('\r', 150);
    assert.equal(h2.ptys.length, 0);
    assert.match(h2.text(), /Cannot start Copilot: copilot \(GitHub Copilot CLI\) not found on PATH\./);
    // n has one startable agent (OpenCode): no menu.
    await h2.type('n', 150);
    assert.equal(modal(h2), null);
    await until(() => h2.ptys.length === 1, 3000, 'opencode pty');
    assert.equal(h2.ptys[0]!.spawn.command, '/usr/bin/opencode');
  } finally {
    await missing.h.dispose();
  }
});

test('agents: a busy Copilot pane is never evicted', async () => {
  const { PaneManager } = await import('../../src/tui/app/pane-manager.ts');
  const { createEmulator } = await import('../../src/term/index.ts');
  const { FakePty, okLauncher } = await import('./helpers.ts');
  const ptys: InstanceType<typeof FakePty>[] = [];
  const status = new Map<string, 'working' | 'idle'>([['cp-busy', 'working'], ['oc-a', 'idle'], ['oc-b', 'idle']]);
  const pm = new PaneManager({
    openPty: async (s) => {
      const p = new FakePty(s);
      ptys.push(p);
      return p;
    },
    createEmulator: (c, r) => createEmulator(c, r),
    launcher: okLauncher,
    pid: 1,
    now: Date.now,
    statusOf: (id) => status.get(id) ?? 'idle',
    onChange: () => {},
    onExit: () => {},
    onError: () => {},
    max: 1,
  });
  await pm.open('cp-busy', '/d', 80, 24, 'copilot');
  await pm.open('oc-a', '/d', 80, 24, 'opencode');
  assert.ok(pm.has('cp-busy'), 'the busy Copilot pane stays');
  assert.ok(pm.has('oc-a'));
  await pm.open('oc-b', '/d', 80, 24, 'opencode');
  assert.ok(pm.has('cp-busy'));
  assert.ok(!pm.has('oc-a'), 'the idle OpenCode pane goes');
  status.set('cp-busy', 'idle');
  await pm.open('oc-a', '/d', 80, 24, 'opencode');
  assert.ok(!pm.has('cp-busy'), 'an idle Copilot pane can go');
  assert.equal(ptys[0]!.spawn.args.join(' '), '--session-id cp-busy');
  await pm.closeAll(100);
});
