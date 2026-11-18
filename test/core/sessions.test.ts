import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenCodeApi, RequestOptions } from '../../src/core/opencode.ts';
import { SessionTracker, type EventHandlers } from '../../src/core/sessions.ts';
import { OpenCodeError } from '../../src/core/opencode.ts';
import { waitFor } from './fake-server.ts';

interface Svc {
  sessions: any[];
  active: string[];
  perms: Array<{ id: string; sessionID: string; dir: string }>;
  forms: Array<{ id: string; sessionID: string; dir: string }>;
  calls: Array<[string, string, RequestOptions | undefined]>;
  gate?: Promise<void>;
}

function fakeClient(svc: Svc): OpenCodeApi {
  return {
    connection: async () => ({ url: 'http://x', authorization: 'Basic x' }),
    async request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
      svc.calls.push([method, path, opts]);
      const snapshot = JSON.parse(JSON.stringify({ sessions: svc.sessions, active: svc.active, perms: svc.perms, forms: svc.forms }));
      if (svc.gate) await svc.gate;
      const q = (opts?.query ?? {}) as Record<string, string>;
      if (method === 'GET' && path === '/api/session/active') return { data: Object.fromEntries(snapshot.active.map((id: string) => [id, { type: 'running' }])) } as T;
      if (method === 'GET' && path === '/api/session') return { data: snapshot.sessions.filter((s: any) => s.location.directory === q.directory), cursor: {} } as T;
      if (method === 'GET' && path === '/api/permission/request') return { data: snapshot.perms.filter((p: any) => p.dir === q['location[directory]']) } as T;
      if (method === 'GET' && path === '/api/form') return { data: snapshot.forms.filter((p: any) => p.dir === q['location[directory]']) } as T;
      if (method === 'POST' && path === '/api/session') {
        const s = { id: 'ses_new', time: { created: 50, updated: 50 }, title: (opts?.body as any).title, location: (opts?.body as any).location };
        svc.sessions.push(s);
        return { data: s } as T;
      }
      if (method === 'PATCH' || method === 'DELETE' || method === 'POST') return undefined as T;
      throw new OpenCodeError(404, 'NotFound', path);
    },
  };
}

const sess = (id: string, dir: string, extra: any = {}) => ({ id, location: { directory: dir }, time: { created: 1, updated: 1, ...(extra.time ?? {}) }, title: id, ...extra, ...(extra.time ? { time: { created: 1, updated: 1, ...extra.time } } : {}) });

function setup(svc: Svc, store?: Map<string, { lastSeen?: number }>) {
  let h!: EventHandlers;
  let closed = false;
  let types: readonly string[] = [];
  const meta = store ?? new Map();
  const tracker = new SessionTracker({
    client: fakeClient(svc),
    subscribe: (t, handlers) => {
      types = t;
      h = handlers;
      return { close: () => (closed = true) };
    },
    store: { sessionMeta: (id) => meta.get(id), setSessionMeta: (id, p) => meta.set(id, { ...meta.get(id), ...p }) },
    throttleMs: 1,
    now: () => 1000,
  });
  let ev = 0;
  const emit = (type: string, data: any, created = 100) => h.onEvent(type, data, { id: 'e' + ev++, type, created, data });
  return { tracker, emit, handlers: () => h, isClosed: () => closed, types: () => types, meta };
}

const statusOf = (t: SessionTracker, dir: string) => Object.fromEntries(t.rows(dir).map((r) => [r.id, r.status]));

test('status transitions from a scripted event sequence', async () => {
  const D = '/w/repo';
  const svc: Svc = {
    sessions: [
      sess('ses_a', D, { time: { updated: 10 } }),
      sess('ses_b', D, { time: { updated: 20, idle: 15, viewed: 15 }, outcome: 'succeeded' }),
      sess('ses_c', D, { time: { updated: 30, idle: 25, viewed: 5 } }),
      sess('ses_child', D, { parentID: 'ses_a' }),
      sess('ses_other', '/elsewhere'),
    ],
    active: [],
    perms: [],
    forms: [],
    calls: [],
  };
  const { tracker, emit, handlers, types, isClosed } = setup(svc);
  assert.ok(types().includes('permission.asked') && !types().includes('session.text.delta'));
  let changes = 0;
  tracker.onChange(() => changes++);
  await tracker.watch([D + '/']);
  assert.deepEqual(tracker.rows(D).map((r) => r.id), ['ses_c', 'ses_b', 'ses_a'], 'unseen first, then by updated');
  assert.deepEqual(statusOf(tracker, D), { ses_a: 'idle', ses_b: 'idle', ses_c: 'unseen' });
  assert.equal(tracker.rows(D).find((r) => r.id === 'ses_b')?.outcome, 'succeeded');
  await waitFor(() => changes > 0, 1000, 'onChange');

  emit('session.execution.started', { sessionID: 'ses_a' }, 200);
  assert.equal(tracker.status('ses_a'), 'working');
  assert.equal(tracker.rows(D)[0]?.id, 'ses_a');
  // A permission asked by the child marks its root.
  emit('permission.asked', { id: 'per_1', sessionID: 'ses_child', action: 'bash', resources: [] });
  assert.equal(tracker.status('ses_a'), 'needs-input');
  emit('permission.replied', { sessionID: 'ses_child', requestID: 'per_1', reply: 'once' });
  assert.equal(tracker.status('ses_a'), 'working');
  emit('form.created', { form: { id: 'frm_1', sessionID: 'ses_a', title: 'q', fields: [] } });
  assert.equal(tracker.status('ses_a'), 'needs-input');
  emit('form.cancelled', { id: 'frm_1', sessionID: 'ses_a' });
  emit('session.execution.succeeded', { sessionID: 'ses_a' }, 300);
  assert.equal(tracker.status('ses_a'), 'unseen');
  assert.equal(tracker.rows(D).find((r) => r.id === 'ses_a')?.updated, 300);
  tracker.markSeen('ses_a');
  assert.equal(tracker.status('ses_a'), 'idle');
  assert.ok(svc.calls.some(([m, p, o]) => m === 'POST' && p === '/api/session/ses_a/view' && (o?.body as any).idle === 300));

  // session.status busy/idle, viewed from another client
  emit('session.status', { sessionID: 'ses_b', status: { type: 'busy' } });
  assert.equal(tracker.status('ses_b'), 'working');
  emit('session.status', { sessionID: 'ses_b', status: { type: 'idle' } });
  emit('session.execution.failed', { sessionID: 'ses_b', error: {} }, 400);
  assert.equal(tracker.status('ses_b'), 'unseen');
  assert.equal(tracker.rows(D).find((r) => r.id === 'ses_b')?.outcome, 'failed');
  emit('session.viewed', { sessionID: 'ses_b', idle: 400 });
  assert.equal(tracker.status('ses_b'), 'idle');

  // lifecycle
  emit('session.created', { sessionID: 'ses_d', title: 'new', location: { directory: D } }, 500);
  emit('session.created', { sessionID: 'ses_x', location: { directory: '/not/watched' } }, 500);
  emit('session.renamed', { sessionID: 'ses_d', title: 'renamed' });
  emit('session.archived', { sessionID: 'ses_d' });
  let d = tracker.rows(D).find((r) => r.id === 'ses_d');
  assert.equal(d?.title, 'renamed');
  assert.equal(d?.archived, true);
  emit('session.unarchived', { sessionID: 'ses_d' });
  assert.equal(tracker.rows(D).find((r) => r.id === 'ses_d')?.archived, false);
  assert.equal(tracker.get('ses_x'), undefined);
  emit('session.deleted', { sessionID: 'ses_a' });
  assert.equal(tracker.get('ses_child'), undefined, 'children go with the parent');
  assert.deepEqual(tracker.rows(D).map((r) => r.id).sort(), ['ses_b', 'ses_c', 'ses_d']);

  // Disconnect: events are lost; the state on the service changed meanwhile.
  handlers().onDisconnect('drop');
  assert.equal(tracker.connected, false);
  svc.sessions = [sess('ses_c', D, { time: { updated: 30, idle: 25, viewed: 25 } }), sess('ses_e', D, { time: { updated: 60 } })];
  svc.active = ['ses_e'];
  svc.perms = [{ id: 'per_9', sessionID: 'ses_c', dir: D }];
  emit('session.execution.started', { sessionID: 'ses_c' }); // stale "running" from before the drop
  handlers().onConnect();
  await waitFor(() => tracker.get('ses_e') !== undefined, 1000, 'refresh after reconnect');
  assert.equal(tracker.connected, true);
  assert.deepEqual(statusOf(tracker, D), { ses_c: 'needs-input', ses_e: 'working' });
  svc.perms = [];
  svc.active = [];

  tracker.dispose();
  assert.equal(isClosed(), true);
});

test('events that arrive while a snapshot is in transit are applied again', async () => {
  const D = '/w';
  let open!: () => void;
  const svc: Svc = { sessions: [sess('ses_a', D)], active: [], perms: [], forms: [], calls: [] };
  const { tracker, emit } = setup(svc);
  svc.gate = new Promise((r) => (open = r));
  const p = tracker.watch([D]);
  // The snapshot was taken before this permission came; the event must survive the install.
  emit('permission.asked', { id: 'per_1', sessionID: 'ses_a' });
  open();
  await p;
  svc.gate = undefined;
  assert.equal(tracker.status('ses_a'), 'needs-input');
  tracker.dispose();
});

test('store lastSeen hides unseen; actions call the API', async () => {
  const D = '/w';
  const svc: Svc = { sessions: [sess('ses_a', D, { time: { idle: 50 } })], active: [], perms: [], forms: [], calls: [] };
  const meta = new Map([['ses_a', { lastSeen: 60 }]]);
  const { tracker } = setup(svc, meta);
  await tracker.watch([D]);
  assert.equal(tracker.status('ses_a'), 'idle');
  const id = await tracker.create(D, 'hello');
  assert.equal(id, 'ses_new');
  assert.deepEqual(svc.calls.find(([m, p]) => m === 'POST' && p === '/api/session')?.[2]?.body, { location: { directory: D }, title: 'hello' });
  assert.equal(tracker.rows(D).some((r) => r.id === 'ses_new'), true);
  await tracker.rename('ses_a', 'T');
  await tracker.archive('ses_a');
  await tracker.unarchive('ses_a');
  await tracker.remove('ses_a');
  const writes = svc.calls.filter(([m]) => m === 'PATCH' || m === 'DELETE').map(([m, p, o]) => [m, p, o?.body]);
  assert.deepEqual(writes, [
    ['PATCH', '/api/session/ses_a', { title: 'T' }],
    ['PATCH', '/api/session/ses_a', { archived: true }],
    ['PATCH', '/api/session/ses_a', { archived: false }],
    ['DELETE', '/api/session/ses_a', undefined],
  ]);
  assert.equal(tracker.get('ses_a'), undefined);
  await tracker.watch([]);
  assert.deepEqual(tracker.rows(D), []);
  tracker.dispose();
});

test('win32: directories match without regard to case and separators', async () => {
  const svc: Svc = { sessions: [sess('ses_a', 'C:\\Users\\A\\Repo')], active: [], perms: [], forms: [], calls: [] };
  let h!: EventHandlers;
  const tracker = new SessionTracker({ client: fakeClient(svc), subscribe: (_t, x) => ((h = x), { close() {} }), platform: 'win32', throttleMs: 1 });
  await tracker.watch(['C:\\Users\\A\\Repo\\']);
  assert.deepEqual(tracker.rows('c:/users/a/repo').map((r) => r.id), ['ses_a']);
  void h;
  tracker.dispose();
});
