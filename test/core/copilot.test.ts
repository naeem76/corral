import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  copilotStatus, CopilotSource, nodeCopilotFs, parseEventLines, parseWorkspaceYaml, readEventsTail,
  type CopilotEvent, type CopilotFs, type FileStat, type Timers,
} from '../../src/core/copilot.ts';
import { copilotHome } from '../../src/core/paths.ts';
import type { SessionMarks } from '../../src/types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-11-20T10:00:00Z');

/** Events at one-second steps from T0, unless an event names its own time. */
function ev(...list: Array<string | [string, string?, number?]>): CopilotEvent[] {
  return list.map((x, i) => {
    const [type, requestId, at] = typeof x === 'string' ? [x] : x;
    const e: CopilotEvent = { type, at: at ?? T0 + i * 1000 };
    if (requestId) e.requestId = requestId;
    return e;
  });
}
const now = T0 + 60_000;

// The verified order for one prompt with one tool call (AGENTS.md).
const START = ['session.start', 'user.message', 'assistant.turn_start', 'assistant.message', 'tool.execution_start'];

// ---------------------------------------------------------------------------
// workspace.yaml
// ---------------------------------------------------------------------------

test('workspace.yaml: flat keys, quotes, comments, junk', () => {
  const y = parseWorkspaceYaml(
    [
      'id: 11111111-2222-4333-8444-555555555555',
      'cwd: /home/u/proj',
      'name: "fix the: \\"bug\\""',
      "client_name: 'it''s me'",
      'summary_count: 0 # a comment',
      '# full comment',
      'nested:',
      '  child: x',
      '- item',
      'not a pair',
      'created_at: 2026-11-19T14:14:02.455Z\r',
      'empty:',
    ].join('\n'),
  );
  assert.equal(y.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(y.cwd, '/home/u/proj');
  assert.equal(y.name, 'fix the: "bug"');
  assert.equal(y.client_name, "it's me");
  assert.equal(y.summary_count, '0');
  assert.equal(y.created_at, '2026-11-19T14:14:02.455Z');
  assert.equal(y.empty, '');
  assert.equal(y.child, undefined);
  assert.equal(y.nested, '');
  // Never throws.
  assert.deepEqual(parseWorkspaceYaml('\u0000\u0001: \n:::\n"'), {});
  assert.equal(parseWorkspaceYaml('name: "unterminated').name, '"unterminated');
});

test('events: JSON lines, partial first line, bad lines', () => {
  const text = 'tail of a line"}\n{"type":"user.message","timestamp":"2026-11-20T10:00:00Z","data":{}}\n{broken\n\n{"type":"permission.requested","timestamp":"x","data":{"requestId":"r1"}}\n';
  const list = parseEventLines(text, true);
  assert.deepEqual(list, [
    { type: 'user.message', at: T0 },
    { type: 'permission.requested', at: 0, requestId: 'r1' },
  ]);
  assert.equal(parseEventLines('{"type":"a"}', false).length, 1);
});

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

test('status: one prompt with a tool call is working until the last turn end', () => {
  assert.equal(copilotStatus(ev('session.start'), { now }).status, 'idle');
  assert.equal(copilotStatus(ev('session.start', 'user.message'), { now }).status, 'working');
  assert.equal(copilotStatus(ev(...START), { now }).status, 'working');
  const done = ev(...START, 'tool.execution_complete', 'assistant.turn_end');
  const st = copilotStatus(done, { now });
  assert.equal(st.status, 'unseen');
  assert.equal(st.outcome, 'succeeded');
  assert.equal(st.activity, (done[done.length - 1] as CopilotEvent).at);
  // Seen after the end: idle.
  assert.equal(copilotStatus(done, { now, lastSeen: now }).status, 'idle');
});

test('status: several turn_start/turn_end pairs for one prompt', () => {
  const multi = ev(...START, 'tool.execution_complete', 'assistant.turn_end', 'assistant.turn_start');
  assert.equal(copilotStatus(multi, { now }).status, 'working', 'a turn_end exists, but it is not the last turn event');
  const tools = ev(...START, 'tool.execution_complete', 'assistant.turn_end', 'assistant.turn_start', 'assistant.message', 'tool.execution_start');
  assert.equal(copilotStatus(tools, { now }).status, 'working');
  const end = ev(...START, 'tool.execution_complete', 'assistant.turn_end', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end');
  assert.equal(copilotStatus(end, { now }).status, 'unseen');
  // Events that do not decide (usage records) after the end change nothing.
  const after = ev(...START, 'assistant.turn_end', 'session.usage_record');
  assert.equal(copilotStatus(after, { now }).status, 'unseen');
});

test('status: pending and answered permission, other request kinds', () => {
  const pending = ev(...START, ['permission.requested', 'r1']);
  assert.equal(copilotStatus(pending, { now }).status, 'needs-input');
  const answered = ev(...START, ['permission.requested', 'r1'], ['permission.completed', 'r1'], 'tool.execution_complete');
  assert.equal(copilotStatus(answered, { now }).status, 'working');
  // A completed request of another id does not answer this one.
  assert.equal(copilotStatus(ev(...START, ['permission.requested', 'r1'], ['permission.completed', 'r2']), { now }).status, 'needs-input');
  for (const kind of ['user_input', 'elicitation', 'exit_plan_mode']) {
    assert.equal(copilotStatus(ev(...START, [`${kind}.requested`, 'q']), { now }).status, 'needs-input', kind);
    assert.equal(copilotStatus(ev(...START, [`${kind}.requested`, 'q'], [`${kind}.completed`, 'q']), { now }).status, 'working', kind);
  }
  // An unknown kind is not a question.
  assert.equal(copilotStatus(ev(...START, ['other.requested', 'q']), { now }).status, 'working');
});

test('status: abort, error, shutdown and a new start end the turn and its questions', () => {
  const abort = copilotStatus(ev(...START, ['permission.requested', 'r1'], 'abort'), { now });
  assert.equal(abort.status, 'unseen');
  assert.equal(abort.outcome, 'interrupted');
  const err = copilotStatus(ev(...START, 'session.error'), { now });
  assert.equal(err.outcome, 'failed');
  assert.equal(err.status, 'unseen');
  const shut = copilotStatus(ev(...START, 'assistant.turn_end', 'session.shutdown'), { now });
  assert.equal(shut.status, 'unseen');
  assert.equal(shut.outcome, 'succeeded');
  const killed = copilotStatus(ev(...START, ['permission.requested', 'r1'], 'session.shutdown'), { now });
  assert.equal(killed.status, 'idle');
  assert.equal(killed.outcome, undefined);
  // A killed terminal, then a resume: the old question and turn are gone.
  const resumed = copilotStatus(ev(...START, ['permission.requested', 'r1'], 'session.start'), { now });
  assert.equal(resumed.status, 'idle');
  // A new prompt after an error: working again, without the old outcome.
  const again = copilotStatus(ev(...START, 'session.error', 'user.message', 'assistant.turn_start'), { now });
  assert.equal(again.status, 'working');
  assert.equal(again.outcome, undefined);
});

test('status: stale guard after a long silence', () => {
  const working = ev(...START.slice(0, 4));
  const last = (working[working.length - 1] as CopilotEvent).at;
  assert.equal(copilotStatus(working, { now: last + 29 * MIN }).status, 'working');
  assert.equal(copilotStatus(working, { now: last + 31 * MIN }).status, 'idle');
  // A running tool may take long: 4 hours.
  const tool = ev(...START);
  const tl = (tool[tool.length - 1] as CopilotEvent).at;
  assert.equal(copilotStatus(tool, { now: tl + 3 * 60 * MIN }).status, 'working');
  assert.equal(copilotStatus(tool, { now: tl + 5 * 60 * MIN }).status, 'idle');
  // A waiting question too.
  const q = ev(...START, ['permission.requested', 'r1']);
  const ql = (q[q.length - 1] as CopilotEvent).at;
  assert.equal(copilotStatus(q, { now: ql + 3 * 60 * MIN }).status, 'needs-input');
  assert.equal(copilotStatus(q, { now: ql + 5 * 60 * MIN }).status, 'idle');
  // The numbers are options; the file time counts when it is newer than the last event.
  assert.equal(copilotStatus(working, { now: last + 2 * MIN, staleMs: MIN }).status, 'idle');
  assert.equal(copilotStatus(working, { now: last + 2 * MIN, staleMs: MIN, changedAt: last + 90_000 }).status, 'working');
  // A finished turn stays unseen however old it is.
  const done = ev(...START, 'assistant.turn_end');
  assert.equal(copilotStatus(done, { now: now + 100 * 60 * MIN }).status, 'unseen');
});

// ---------------------------------------------------------------------------
// Tail reading
// ---------------------------------------------------------------------------

function line(type: string, at: number, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'x', timestamp: new Date(at).toISOString(), parentId: null, type, data }) + '\n';
}

/** A CopilotFs over a real folder that records every readRange. */
function countingFs(): CopilotFs & { ranges: Array<[number, number]>; files: number } {
  const fs = {
    ranges: [] as Array<[number, number]>,
    files: 0,
    readdir: nodeCopilotFs.readdir,
    stat: nodeCopilotFs.stat,
    readFile: (p: string) => {
      fs.files++;
      return nodeCopilotFs.readFile(p);
    },
    readRange: (p: string, pos: number, len: number) => {
      fs.ranges.push([pos, len]);
      return nodeCopilotFs.readRange(p, pos, len);
    },
  };
  return fs;
}

test('tail: a file larger than both windows is never read whole', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neb-cp-tail-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const big = 'x'.repeat(4000);
    let text = line('session.start', T0) + line('user.message', T0 + 1);
    for (let i = 0; i < 300; i++) text += line('system.message', T0 + 2, { content: big }); // ~1.2 MB
    text += line('user.message', T0 + 10) + line('assistant.turn_start', T0 + 11) + line('tool.execution_start', T0 + 12);
    text += line('permission.requested', T0 + 13, { requestId: 'r1' });
    await writeFile(file, text);
    const size = Buffer.byteLength(text);
    assert.ok(size > 1_000_000);

    // The prompt is in the last 64 KB: one small read.
    const fs = countingFs();
    const events = await readEventsTail(fs, file, size);
    assert.deepEqual(fs.ranges, [[size - 64 * 1024, 64 * 1024]]);
    assert.equal(copilotStatus(events, { now: T0 + MIN }).status, 'needs-input');

    // A question that scrolled out of the 64 KB window (big tool output after it): the
    // 512 KB window finds the prompt and the question.
    let text2 = line('session.start', T0) + 'y'.repeat(700_000) + '\n' + line('user.message', T0 + 1) + line('assistant.turn_start', T0 + 2);
    text2 += line('permission.requested', T0 + 3, { requestId: 'r9' });
    for (let i = 0; i < 25; i++) text2 += line('tool.execution_partial_result', T0 + 4, { output: big });
    await writeFile(file, text2);
    const size2 = Buffer.byteLength(text2);
    const fs2 = countingFs();
    const ev2 = await readEventsTail(fs2, file, size2);
    assert.deepEqual(fs2.ranges, [
      [size2 - 64 * 1024, 64 * 1024],
      [size2 - 512 * 1024, 512 * 1024],
    ]);
    assert.ok(fs2.ranges.every(([, len]) => len < size2), 'never the whole file');
    assert.equal(copilotStatus(ev2, { now: T0 + MIN }).status, 'needs-input');

    // A small file is read once, from the start, without dropping its first line.
    const small = line('session.start', T0) + line('user.message', T0 + 1);
    await writeFile(file, small);
    const fs3 = countingFs();
    const ev3 = await readEventsTail(fs3, file, Buffer.byteLength(small));
    assert.equal(ev3.length, 2);
    assert.equal(fs3.ranges.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The source over a real temp home
// ---------------------------------------------------------------------------

class MemStore {
  marks = new Map<string, SessionMarks>();
  sessionMeta(id: string) {
    return this.marks.get(id);
  }
  setSessionMeta(id: string, patch: Partial<SessionMarks>) {
    const cur: Record<string, unknown> = { ...(this.marks.get(id) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    }
    this.marks.set(id, cur as SessionMarks);
  }
}

class Timers1 implements Timers {
  fns = new Map<number, { fn: () => void; ms: number }>();
  n = 0;
  setInterval(fn: () => void, ms: number) {
    this.fns.set(++this.n, { fn, ms });
    return this.n;
  }
  clearInterval(h: unknown) {
    this.fns.delete(h as number);
  }
  fire(ms: number) {
    for (const t of [...this.fns.values()]) if (t.ms === ms) t.fn();
  }
}

async function writeSession(home: string, id: string, cwd: string, name: string | null, events: string | null): Promise<string> {
  const folder = path.join(home, 'session-state', id);
  await mkdir(folder, { recursive: true });
  const y = [`id: ${id}`, `cwd: ${cwd}`, ...(name === null ? [] : [`name: ${name}`]), 'created_at: 2026-11-20T09:00:00.000Z', 'updated_at: 2026-11-20T09:30:00.000Z'];
  await writeFile(path.join(folder, 'workspace.yaml'), y.join('\n') + '\n');
  if (events !== null) await writeFile(path.join(folder, 'events.jsonl'), events);
  return folder;
}

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

async function setup(opts: { program?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'neb-cp-home-'));
  const a = path.join(home, 'work', 'a');
  const b = path.join(home, 'work', 'b');
  await writeSession(home, ID1, a, 'first', line('session.start', T0) + line('user.message', T0 + 1000) + line('assistant.turn_start', T0 + 2000) + line('assistant.turn_end', T0 + 3000));
  await writeSession(home, ID2, a, 'second', line('session.start', T0) + line('user.message', T0 + 5000) + line('assistant.turn_start', T0 + 6000));
  await writeSession(home, ID3, b, 'other', null);
  // Lock files and other dot entries are not sessions.
  await mkdir(path.join(home, 'session-state', '.session-operation-locks'), { recursive: true });
  const store = new MemStore();
  const timers = new Timers1();
  let t = T0 + MIN;
  const fs = countingFs();
  const src = new CopilotSource({
    home,
    store,
    fs,
    timers,
    now: () => t,
    platform: 'linux',
    launch: () => (opts.program === false ? { ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' } : { ok: true, kind: 'exe', command: '/bin/copilot', args: [] }),
  });
  return { home, a, b, store, timers, src, fs, setNow: (v: number) => (t = v), now: () => t };
}

test('source: lists sessions of watched folders, sorted, with status and title', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.src.rows(s.a), [], 'nothing before watch');
    await s.src.watch([s.a + path.sep]);
    const rows = s.src.rows(s.a);
    assert.deepEqual(rows.map((r) => [r.id, r.title, r.status, r.agent]), [
      [ID2, 'second', 'working', 'copilot'],
      [ID1, 'first', 'unseen', 'copilot'],
    ]);
    assert.equal(rows[1]?.outcome, 'succeeded');
    assert.equal(rows[1]?.created, Date.parse('2026-11-20T09:00:00.000Z'));
    assert.equal(s.src.rows(s.b).length, 0, 'b is not watched');
    assert.equal(s.src.row(ID3)?.status, 'idle', 'known, not read');
    assert.equal(s.src.activity(ID1), T0 + 3000);
    // Only the watched sessions had their events read.
    assert.equal(s.fs.ranges.length, 2);
    assert.equal(s.src.capabilities().archive, 'local');
    assert.equal(s.src.available, true);
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

test('source: unchanged files are not read again; a change is read once', async () => {
  const s = await setup();
  try {
    await s.src.watch([s.a]);
    const reads = s.src.reads;
    await s.src.refresh();
    await s.src.poll();
    assert.equal(s.src.reads, reads, 'no read when mtime and size are the same');
    let changes = 0;
    s.src.onChange(() => changes++);
    await appendFile(path.join(s.home, 'session-state', ID2, 'events.jsonl'), line('assistant.turn_end', T0 + 9000));
    await s.src.poll();
    await Promise.resolve();
    assert.equal(s.src.reads, reads + 1);
    assert.equal(s.src.status(ID2), 'unseen');
    assert.equal(changes, 1);
    await s.src.poll();
    await Promise.resolve();
    assert.equal(changes, 1, 'no change, no call');
    s.src.markSeen(ID2);
    assert.equal(s.src.status(ID2), 'idle');
    assert.ok(s.store.marks.get(ID2)?.lastSeen);
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

test('source: polling with timers; no timers without watched folders', async () => {
  const s = await setup();
  try {
    assert.equal(s.timers.fns.size, 0);
    await s.src.watch([s.a]);
    assert.deepEqual([...s.timers.fns.values()].map((t) => t.ms).sort(), [2000, 5000]);
    let changes = 0;
    s.src.onChange(() => changes++);
    // A new session in a watched folder appears with the next scan.
    const ID4 = '44444444-4444-4444-8444-444444444444';
    await writeSession(s.home, ID4, s.a, 'fourth', line('session.start', T0));
    s.timers.fire(2000);
    await s.src.poll();
    assert.equal(s.src.row(ID4), undefined, 'the poll does not list the folder');
    s.timers.fire(5000);
    await s.src.scan();
    await s.src.poll();
    await Promise.resolve();
    assert.equal(s.src.row(ID4)?.title, 'fourth');
    assert.ok(changes >= 1);
    // A removed session goes with the next scan.
    await rm(path.join(s.home, 'session-state', ID4), { recursive: true });
    await s.src.scan();
    assert.equal(s.src.row(ID4), undefined);
    // The stale guard moves with the clock alone.
    s.setNow(T0 + 40 * MIN);
    await s.src.poll();
    assert.equal(s.src.status(ID2), 'idle');
    await s.src.watch([]);
    assert.equal(s.timers.fns.size, 0);
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

test('source: pending row of a new session, its life cycle', async () => {
  const s = await setup();
  try {
    await s.src.watch([s.a]);
    const id = await s.src.create(s.a);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(s.src.row(id)?.title, 'New Copilot session');
    assert.ok(s.src.isPending(id));
    assert.ok(s.src.rows(s.a).some((r) => r.id === id));
    // The program starts and makes the folder: the real row replaces the pending one.
    s.src.opened(id);
    await writeSession(s.home, id, s.a, 'hello', line('session.start', T0));
    await s.src.refresh();
    assert.equal(s.src.isPending(id), false);
    assert.equal(s.src.row(id)?.title, 'hello');
    assert.equal(s.src.rows(s.a).filter((r) => r.id === id).length, 1);

    // Opened and closed without a folder: dropped.
    const gone = await s.src.create(s.a);
    s.src.opened(gone);
    await s.src.closed(gone);
    assert.equal(s.src.row(gone), undefined);

    // Never opened: dropped after 10 minutes.
    const idle = await s.src.create(s.a);
    s.setNow(s.now() + 9 * MIN);
    await s.src.poll();
    assert.ok(s.src.row(idle));
    s.setNow(s.now() + 2 * MIN);
    await s.src.poll();
    assert.equal(s.src.row(idle), undefined);
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

test('source: archive is a local mark; rename and delete are refused', async () => {
  const s = await setup();
  try {
    await s.src.watch([s.a]);
    await s.src.archive(ID1);
    assert.ok(s.store.marks.get(ID1)?.archivedAt);
    assert.equal(s.src.row(ID1)?.archived, true);
    await s.src.unarchive(ID1);
    assert.equal(s.store.marks.get(ID1)?.archivedAt, undefined);
    assert.equal(s.src.row(ID1)?.archived, false);
    await assert.rejects(s.src.rename(ID1, 'x'), /\/rename/);
    await assert.rejects(s.src.remove(ID1), /\/session delete/);
    await assert.rejects(s.src.archive('nope'), /unknown/);
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

test('source: available from the program or the session folder', async () => {
  const s = await setup({ program: false });
  try {
    assert.equal(s.src.homeExists, null);
    await s.src.watch([s.a]);
    assert.equal(s.src.available, true, 'old sessions can be listed without the program');
    assert.equal(s.src.programFound, false);
    const empty = new CopilotSource({ home: path.join(s.home, 'nothing'), launch: () => ({ ok: false, reason: 'copilot (GitHub Copilot CLI) not found on PATH' }) });
    await empty.watch([s.a]);
    assert.equal(empty.available, false);
    assert.match(empty.unavailableReason ?? '', /not found on PATH; no Copilot sessions at .*session-state/);
    empty.dispose();
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-memory file system: Windows paths and the cost of a large home
// ---------------------------------------------------------------------------

class MemFs implements CopilotFs {
  files = new Map<string, { text: string; mtimeMs: number }>();
  dirs = new Set<string>();
  calls = { readdir: 0, stat: 0, readFile: 0, readRange: 0 };
  readonly p: typeof path.win32;
  constructor(p: typeof path.win32) {
    this.p = p;
  }
  put(file: string, text: string, mtimeMs = T0): void {
    this.files.set(file.toLowerCase(), { text, mtimeMs });
    for (let d = this.p.dirname(file); d !== this.p.dirname(d); d = this.p.dirname(d)) this.dirs.add(d.toLowerCase());
  }
  async readdir(dir: string): Promise<string[]> {
    this.calls.readdir++;
    const k = dir.toLowerCase();
    const out = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (this.p.dirname(f) === k) out.add(this.p.basename(f));
    }
    return [...out];
  }
  async stat(file: string): Promise<FileStat | null> {
    this.calls.stat++;
    const k = file.toLowerCase();
    const f = this.files.get(k);
    if (f) return { mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.text), isDirectory: false };
    return this.dirs.has(k) ? { mtimeMs: T0, size: 0, isDirectory: true } : null;
  }
  async readFile(file: string): Promise<string> {
    this.calls.readFile++;
    const f = this.files.get(file.toLowerCase());
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return f.text;
  }
  async readRange(file: string, pos: number, len: number): Promise<string> {
    this.calls.readRange++;
    const f = this.files.get(file.toLowerCase());
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(f.text).subarray(pos, pos + len).toString('utf8');
  }
}

test('source: Windows paths match without regard to case and separators', async () => {
  const w = path.win32;
  const home = copilotHome({ USERPROFILE: 'C:\\Users\\Ann' }, 'win32', 'C:\\Users\\Ann');
  assert.equal(home, 'C:\\Users\\Ann\\.copilot');
  assert.equal(copilotHome({ copilot_home: 'D:\\cp' }, 'win32', 'C:\\Users\\Ann'), 'D:\\cp', 'env names ignore case on Windows');
  assert.equal(copilotHome({ COPILOT_HOME: 'D:\\cp', NEBULA_COPILOT_HOME: 'E:\\mine' }, 'win32', 'C:\\Users\\Ann'), 'E:\\mine');
  const fs = new MemFs(w);
  const folder = w.join(home, 'session-state', ID1);
  fs.put(w.join(folder, 'workspace.yaml'), `id: ${ID1}\r\ncwd: C:\\Work\\Proj\r\nname: win\r\n`);
  fs.put(w.join(folder, 'events.jsonl'), line('session.start', T0) + line('user.message', T0 + 1));
  const src = new CopilotSource({ home, fs, platform: 'win32', now: () => T0 + MIN, timers: new Timers1() });
  await src.watch(['c:/work/proj/']);
  const rows = src.rows('C:\\WORK\\proj');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.directory, 'C:\\Work\\Proj');
  assert.equal(rows[0]?.status, 'working');
  src.dispose();
});

test('source: a home with thousands of sessions reads only the watched ones', async () => {
  const p = path.posix;
  const fs = new MemFs(p as unknown as typeof path.win32);
  const home = '/h/.copilot';
  for (let i = 0; i < 2000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const folder = p.join(home, 'session-state', id);
    fs.put(p.join(folder, 'workspace.yaml'), `id: ${id}\ncwd: /work/${i < 3 ? 'mine' : 'other' + i}\nname: s${i}\n`);
    fs.put(p.join(folder, 'events.jsonl'), line('session.start', T0));
  }
  const src = new CopilotSource({ home, fs, platform: 'linux', now: () => T0 + MIN, timers: new Timers1() });
  // No folder watched: no file work beyond one look at the folder.
  await src.refresh();
  assert.equal(fs.calls.readdir + fs.calls.readFile + fs.calls.readRange, 0);
  await src.watch(['/work/mine']);
  assert.equal(src.rows('/work/mine').length, 3);
  assert.equal(fs.calls.readRange, 3, 'only watched sessions have their events read');
  const before = { ...fs.calls };
  await src.poll();
  assert.equal(fs.calls.readFile, before.readFile, 'unchanged files are not read again');
  assert.equal(fs.calls.readRange, before.readRange);
  assert.equal(fs.calls.stat - before.stat, 6, 'a poll stats two files per watched session');
  await src.scan();
  assert.equal(fs.calls.readFile, before.readFile, 'a scan does not read known sessions again');
  src.dispose();
});

test('source: no home folder, no work and no error', async () => {
  const fs = new MemFs(path.posix as unknown as typeof path.win32);
  const errors: Error[] = [];
  const src = new CopilotSource({ home: '/none/.copilot', fs, platform: 'linux', timers: new Timers1(), onError: (e) => errors.push(e) });
  await src.watch(['/w']);
  await src.poll();
  await src.scan();
  assert.equal(fs.calls.readdir, 0);
  assert.equal(src.homeExists, false);
  assert.deepEqual(errors, []);
  src.dispose();
});

test('source: a file changed with the same size and a new mtime is read again', async () => {
  const s = await setup();
  try {
    await s.src.watch([s.a]);
    const f = path.join(s.home, 'session-state', ID1, 'workspace.yaml');
    const reads = s.src.reads;
    // "first" -> "FIRST": the same size.
    await writeFile(f, `id: ${ID1}\ncwd: ${s.a}\nname: FIRST\ncreated_at: 2026-11-20T09:00:00.000Z\nupdated_at: 2026-11-20T09:30:00.000Z\n`);
    await utimes(f, new Date(T0 + 5 * MIN), new Date(T0 + 5 * MIN));
    await s.src.poll();
    assert.equal(s.src.reads, reads + 1);
    assert.equal(s.src.row(ID1)?.title, 'FIRST');
  } finally {
    s.src.dispose();
    await rm(s.home, { recursive: true, force: true });
  }
});
