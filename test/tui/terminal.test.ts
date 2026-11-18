import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NotATerminalError, enterSequence, openTerminal, restoreSequence } from '../../src/tui/terminal.ts';
import type { TerminalOptions } from '../../src/tui/terminal.ts';
import type { InputEvent } from '../../src/types.ts';

class FakeIn extends EventEmitter {
  isTTY = true;
  raw = false;
  rawCalls: boolean[] = [];
  paused = true;
  setRawMode(m: boolean): this {
    this.raw = m;
    this.rawCalls.push(m);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

class FakeOut extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  out = '';
  writes = 0;
  write(s: string): boolean {
    this.out += s;
    this.writes++;
    return true;
  }
}

class FakeProc extends EventEmitter {
  exits: number[] = [];
  exit(code?: number): void {
    this.exits.push(code ?? 0);
  }
}

class FakeTimers {
  pending: { cb: () => void; ms: number }[] = [];
  setTimeout(cb: () => void, ms: number): unknown {
    const t = { cb, ms };
    this.pending.push(t);
    return t;
  }
  clearTimeout(h: unknown): void {
    this.pending = this.pending.filter((t) => t !== h);
  }
  runAll(): void {
    const p = this.pending;
    this.pending = [];
    for (const t of p) t.cb();
  }
}

function setup(over: Partial<TerminalOptions> = {}) {
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const proc = new FakeProc();
  const timers = new FakeTimers();
  const errors: string[] = [];
  const term = openTerminal({
    stdin,
    stdout,
    proc,
    timers,
    platform: 'linux',
    writeSync: (s) => stdout.write(s),
    errorOut: (t) => errors.push(t),
    ...over,
  });
  return { term, stdin, stdout, proc, timers, errors };
}

const RESTORE = restoreSequence();

test('open enters raw mode, alternate screen, mouse, paste and focus modes', () => {
  const { stdin, stdout } = setup();
  assert.equal(stdin.raw, true);
  assert.equal(stdin.paused, false);
  assert.equal(stdout.out, enterSequence());
  for (const m of ['?1049h', '?25l', '?1000h', '?1002h', '?1006h', '?2004h', '?1004h']) assert.ok(stdout.out.includes(m), m);
  assert.ok(!stdout.out.includes('?1003h'), 'any-motion is off by default');
});

test('any-motion mouse is an option', () => {
  const { stdout, term } = setup({ mouseAnyMotion: true });
  assert.ok(stdout.out.includes('\x1b[?1003h'));
  term.close();
  assert.ok(stdout.out.endsWith(restoreSequence({ mouseAnyMotion: true })));
  assert.ok(stdout.out.includes('\x1b[?1003l'));
});

test('restore undoes every mode in reverse order and shows the cursor', () => {
  const enter = enterSequence();
  const modes = [...enter.matchAll(/\x1b\[\?(\d+)h/g)].map((m) => m[1]!);
  const off = [...RESTORE.matchAll(/\x1b\[\?(\d+)l/g)].map((m) => m[1]!).filter((m) => m !== '25');
  assert.deepEqual(off, modes.filter((m) => m !== '25').reverse());
  assert.ok(RESTORE.includes('\x1b[?25h'));
  assert.ok(RESTORE.endsWith('\x1b[?1049l'), 'leaving the alternate screen comes last');
});

test('close restores, is idempotent, and removes every hook', () => {
  const { term, stdin, stdout, proc } = setup();
  const listeners = proc.eventNames().length;
  assert.ok(listeners >= 5);
  term.close();
  assert.equal(stdin.raw, false);
  assert.ok(stdout.out.endsWith(RESTORE));
  const len = stdout.out.length;
  term.close();
  assert.equal(stdout.out.length, len, 'second close writes nothing');
  assert.equal(proc.eventNames().length, 0);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  term.write('x');
  assert.equal(stdout.out.length, len, 'write after close is ignored');
  assert.equal(term.closed, true);
});

test('exit paths restore the terminal', () => {
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) {
    const { stdout, proc, stdin } = setup();
    proc.emit(event);
    assert.ok(stdout.out.endsWith(RESTORE), event);
    assert.equal(stdin.raw, false, event);
    if (event !== 'exit') assert.equal(proc.exits.length, 1, event);
  }
  const crash = setup();
  crash.proc.emit('uncaughtException', new Error('boom'));
  assert.ok(crash.stdout.out.endsWith(RESTORE));
  assert.deepEqual(crash.proc.exits, [1]);
  assert.ok(crash.errors[0]!.includes('boom'), 'the error is printed after the restore');
  const rej = setup();
  rej.proc.emit('unhandledRejection', new Error('nope'));
  assert.ok(rej.stdout.out.endsWith(RESTORE));
  assert.ok(rej.errors[0]!.includes('nope'));
});

test('windows registers only signals that exist there', () => {
  const { proc, term } = setup({ platform: 'win32' });
  const names = proc.eventNames().map(String);
  assert.ok(names.includes('SIGINT'));
  assert.ok(names.includes('SIGBREAK'));
  assert.ok(!names.includes('SIGTERM'));
  term.close();
});

test('exitHooks false installs nothing', () => {
  const { proc, term } = setup({ exitHooks: false });
  assert.equal(proc.eventNames().length, 0);
  term.close();
});

test('input is decoded; a lone ESC is flushed by the timer', () => {
  const { term, stdin, timers } = setup();
  const got: InputEvent[] = [];
  term.onInput((evs) => got.push(...evs));
  stdin.emit('data', 'a\x1b[A');
  assert.deepEqual(got.map((e) => e.type === 'key' && e.key), ['a', 'up']);
  stdin.emit('data', '\x1b');
  assert.equal(got.length, 2);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0]!.ms, 30);
  timers.runAll();
  assert.equal(got.length, 3);
  assert.equal(got[2]!.type === 'key' && got[2]!.key, 'escape');
  // ESC followed quickly by the rest cancels the timer.
  stdin.emit('data', '\x1b');
  stdin.emit('data', '[B');
  assert.equal(timers.pending.length, 0);
  assert.equal(got[3]!.type === 'key' && got[3]!.key, 'down');
  stdin.emit('data', Buffer.from('é'));
  assert.equal(got[4]!.type === 'key' && got[4]!.key, 'é');
  term.close();
});

test('resize callbacks get the new size; unsubscribe works', () => {
  const { term, stdout } = setup();
  const sizes: string[] = [];
  const off = term.onResize((s) => sizes.push(`${s.cols}x${s.rows}`));
  assert.deepEqual(term.size(), { cols: 100, rows: 30 });
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.emit('resize');
  off();
  stdout.emit('resize');
  assert.deepEqual(sizes, ['120x40']);
  stdout.columns = 0;
  assert.deepEqual(term.size(), { cols: 80, rows: 40 }, 'fallback when the size is unknown');
  term.close();
});

test('write is one write call per frame', () => {
  const { term, stdout } = setup();
  const before = stdout.writes;
  term.write('frame-1');
  term.write('');
  assert.equal(stdout.writes, before + 1);
  term.close();
});

test('suspend and resume are symmetric', () => {
  const { term, stdin, stdout } = setup();
  const got: InputEvent[] = [];
  let redraws = 0;
  term.onInput((evs) => got.push(...evs));
  term.onRedraw(() => redraws++);
  const start = stdout.out.length;
  term.suspend();
  assert.equal(term.suspended, true);
  assert.equal(stdin.raw, false);
  assert.equal(stdin.paused, true);
  assert.equal(stdout.out.slice(start), RESTORE);
  stdin.emit('data', 'x');
  assert.equal(got.length, 0, 'no input while suspended');
  term.write('ignored');
  term.suspend();
  assert.equal(stdout.out.slice(start), RESTORE, 'second suspend does nothing');
  const mid = stdout.out.length;
  term.resume();
  assert.equal(stdout.out.slice(mid), enterSequence());
  assert.equal(stdin.raw, true);
  assert.equal(redraws, 1);
  stdin.emit('data', 'y');
  assert.equal(got.length, 1);
  term.close();
  assert.ok(stdout.out.endsWith(RESTORE));
  assert.deepEqual(stdin.rawCalls, [true, false, true, false]);
});

test('close while suspended does not restore twice', () => {
  const { term, stdout } = setup();
  term.suspend();
  const len = stdout.out.length;
  term.close();
  assert.equal(stdout.out.length, len);
});

test('not a terminal gives a clear error', () => {
  const stdin = new FakeIn();
  stdin.isTTY = false;
  assert.throws(
    () => openTerminal({ stdin, stdout: new FakeOut(), proc: new FakeProc() }),
    (e: unknown) => e instanceof NotATerminalError && /not a terminal/.test(e.message),
  );
  const stdout = new FakeOut();
  stdout.isTTY = false;
  assert.throws(() => openTerminal({ stdin: new FakeIn(), stdout, proc: new FakeProc() }), NotATerminalError);
});
