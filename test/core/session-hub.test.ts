import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentId, SessionCapabilities, SessionRow, SessionSource, SessionStatus } from '../../src/types.ts';
import { SessionHub } from '../../src/core/session-hub.ts';

/** A source with fixed rows; records the calls. */
class FakeSource implements SessionSource {
  available = true;
  unavailableReason: string | null = null;
  calls: string[] = [];
  rowsByDir = new Map<string, SessionRow[]>();
  fail: string | null = null;
  #listeners = new Set<() => void>();
  #n = 0;
  readonly agent: AgentId;
  readonly caps: SessionCapabilities;
  constructor(agent: AgentId, caps: SessionCapabilities) {
    this.agent = agent;
    this.caps = caps;
  }
  add(dir: string, id: string, status: SessionStatus, updated: number): void {
    const list = this.rowsByDir.get(dir) ?? [];
    list.push({ id, agent: this.agent, title: id, directory: dir, created: 0, updated, status, archived: false });
    this.rowsByDir.set(dir, list);
  }
  capabilities() {
    return this.caps;
  }
  async watch(dirs: readonly string[]) {
    this.calls.push(`watch ${dirs.join(',')}`);
    if (this.fail === 'watch') throw new Error('boom');
  }
  rows(dir: string) {
    return [...(this.rowsByDir.get(dir) ?? [])];
  }
  row(id: string) {
    for (const l of this.rowsByDir.values()) for (const r of l) if (r.id === id) return r;
    return undefined;
  }
  activity(id: string) {
    return this.row(id) ? 42 : 0;
  }
  status(id: string): SessionStatus {
    return this.row(id)?.status ?? 'idle';
  }
  markSeen(id: string) {
    this.calls.push(`seen ${id}`);
  }
  async create(dir: string) {
    const id = `${this.agent}-new-${++this.#n}`;
    this.add(dir, id, 'idle', 0);
    this.calls.push(`create ${dir}`);
    return id;
  }
  async rename(id: string) {
    this.calls.push(`rename ${id}`);
  }
  async archive(id: string) {
    this.calls.push(`archive ${id}`);
  }
  async unarchive(id: string) {
    this.calls.push(`unarchive ${id}`);
  }
  async remove(id: string) {
    this.calls.push(`remove ${id}`);
  }
  async refresh() {
    this.calls.push('refresh');
    if (this.fail === 'refresh') throw new Error('refresh failed');
  }
  onChange(cb: () => void) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  emit() {
    for (const cb of this.#listeners) cb();
  }
  dispose() {
    this.calls.push('dispose');
  }
}

function make() {
  const oc = new FakeSource('opencode', { rename: true, remove: true, archive: 'agent' });
  const cp = new FakeSource('copilot', { rename: false, remove: false, archive: 'local' });
  const errors: string[] = [];
  const hub = new SessionHub(
    [
      { agent: 'opencode', source: oc },
      { agent: 'copilot', source: cp },
    ],
    { onError: (e) => errors.push(e.message) },
  );
  return { oc, cp, hub, errors };
}

test('hub: rows of both agents in one attention order', () => {
  const { oc, cp, hub } = make();
  oc.add('/p', 'ses_a', 'idle', 300);
  oc.add('/p', 'ses_b', 'working', 100);
  cp.add('/p', 'uuid-c', 'needs-input', 50);
  cp.add('/p', 'uuid-d', 'idle', 400);
  assert.deepEqual(hub.rows('/p').map((r) => r.id), ['uuid-c', 'ses_b', 'uuid-d', 'ses_a']);
  assert.equal(hub.agentOf('uuid-d'), 'copilot');
  assert.equal(hub.agentOf('ses_a'), 'opencode');
  assert.equal(hub.agentOf('nope'), undefined);
});

test('hub: id methods go to the owning source', async () => {
  const { oc, cp, hub } = make();
  oc.add('/p', 'ses_a', 'idle', 1);
  cp.add('/p', 'uuid-c', 'unseen', 1);
  await hub.rename('ses_a', 'x');
  await hub.archive('uuid-c');
  await hub.unarchive('uuid-c');
  hub.markSeen('uuid-c');
  await hub.remove('ses_a');
  assert.deepEqual(oc.calls, ['rename ses_a', 'remove ses_a']);
  assert.deepEqual(cp.calls, ['archive uuid-c', 'unarchive uuid-c', 'seen uuid-c']);
  assert.equal(hub.status('uuid-c'), 'unseen');
  assert.equal(hub.activity('uuid-c'), 42);
  assert.equal(hub.row('ses_a')?.agent, 'opencode');
  assert.deepEqual(hub.capabilitiesOf('uuid-c'), { rename: false, remove: false, archive: 'local' });
  assert.deepEqual(hub.capabilitiesOf('ses_a'), { rename: true, remove: true, archive: 'agent' });
  await assert.rejects(hub.archive('unknown'), /unknown session/);
});

test('hub: create with the default agent, or the first available one', async () => {
  const { oc, cp, hub } = make();
  const a = await hub.create('/p');
  assert.equal(hub.agentOf(a), 'opencode', 'no default: the first available');
  hub.defaultAgent = 'copilot';
  const b = await hub.create('/p');
  assert.equal(hub.agentOf(b), 'copilot');
  cp.available = false;
  const c = await hub.create('/p');
  assert.equal(hub.agentOf(c), 'opencode', 'the default is not available');
  oc.available = false;
  await assert.rejects(hub.create('/p'), /No agent/);
  const d = await hub.createWith('copilot', '/q');
  assert.equal(hub.agentOf(d), 'copilot', 'createWith does not ask about availability');
  assert.equal(hub.available, false);
});

test('hub: one failing source does not stop the others', async () => {
  const { oc, cp, hub, errors } = make();
  oc.fail = 'watch';
  cp.fail = 'refresh';
  await hub.watch(['/p']);
  await hub.refresh();
  assert.deepEqual(oc.calls, ['watch /p', 'refresh']);
  assert.deepEqual(cp.calls, ['watch /p', 'refresh']);
  assert.deepEqual(errors, ['opencode watch: boom', 'copilot refresh: refresh failed']);
});

test('hub: agents, agents with rows, change events, dispose', async () => {
  const { oc, cp, hub } = make();
  oc.available = false;
  oc.unavailableReason = 'the OpenCode service is not connected';
  assert.deepEqual(hub.agents(), [
    { agent: 'opencode', available: false, reason: 'the OpenCode service is not connected' },
    { agent: 'copilot', available: true, reason: null },
  ]);
  await hub.watch(['/p']);
  assert.deepEqual([...hub.agentsWithRows()], []);
  oc.add('/p', 'ses_a', 'idle', 1);
  let n = 0;
  hub.onChange(() => n++);
  oc.emit();
  assert.equal(n, 1);
  assert.deepEqual([...hub.agentsWithRows()], ['opencode']);
  hub.dispose();
  assert.ok(oc.calls.includes('dispose') && cp.calls.includes('dispose'));
});
