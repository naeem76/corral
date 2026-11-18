import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, subscribeEvents, type SseMessage } from '../../src/core/events.ts';
import { OpenCodeClient } from '../../src/core/opencode.ts';
import { PASSWORD, startFakeServer, waitFor } from './fake-server.ts';

const STREAM =
  ': comment\r\n' +
  'event: custom\r\nid: 7\r\ndata: line1\r\ndata: line2\r\n\r\n' +
  'data:no-space\n\n' +
  'data: {"type":"x","data":{"a":"é😀"}}\r\r' +
  'data\n\n' +
  'id: 9\n\n' +
  'data: last\n\n';

function parseAll(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = new SseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  return out;
}

const EXPECTED: SseMessage[] = [
  { event: 'custom', data: 'line1\nline2', id: '7' },
  { event: 'message', data: 'no-space', id: '7' },
  { event: 'message', data: '{"type":"x","data":{"a":"é😀"}}', id: '7' },
  { event: 'message', data: '', id: '7' },
  { event: 'message', data: 'last', id: '9' },
];

test('SSE parser: whole stream', () => {
  assert.deepEqual(parseAll([STREAM]), EXPECTED);
});

test('SSE parser: every split point, including inside CRLF', () => {
  for (let i = 0; i <= STREAM.length; i++) {
    assert.deepEqual(parseAll([STREAM.slice(0, i), STREAM.slice(i)]), EXPECTED, `split at ${i}`);
  }
  assert.deepEqual(parseAll([...STREAM]), EXPECTED, 'one char per chunk');
});

test('SSE parser: CR at chunk end then a data line', () => {
  assert.deepEqual(parseAll(['data: a\r', '\r', 'data: b\r', '\n\r\n']), [
    { event: 'message', data: 'a', id: '' },
    { event: 'message', data: 'b', id: '' },
  ]);
});

test('subscribe: events, onConnect, reconnect after a drop, types filter, auth', async () => {
  const fake = await startFakeServer();
  const events: Array<[string, unknown]> = [];
  let connects = 0;
  const errors: string[] = [];
  const c = new OpenCodeClient({ discover: async () => ({ url: fake.url, password: PASSWORD, source: 't' }) });
  const sub = subscribeEvents(c, {
    types: ['session.created', 'permission.asked'],
    onEvent: (t, d) => events.push([t, d]),
    onConnect: () => connects++,
    onError: (e) => errors.push(e.message),
    backoffMs: 10,
  });
  try {
    await waitFor(() => connects === 1 && fake.sse.length === 1, 3000, 'connect');
    assert.deepEqual(fake.sseRequests[0]?.query.getAll('types'), ['session.created', 'permission.asked']);
    fake.sendEvent({ id: 'e1', type: 'session.created', data: { sessionID: 'ses_1' } });
    await waitFor(() => events.length === 1, 3000, 'event');
    assert.deepEqual(events[0], ['session.created', { sessionID: 'ses_1' }]);
    fake.dropSse();
    await waitFor(() => connects === 2 && fake.sse.length === 1, 3000, 'reconnect');
    fake.sendEvent({ id: 'e2', type: 'permission.asked', data: { id: 'per_1' } });
    await waitFor(() => events.length === 2, 3000, 'event 2');
    for (const e of errors) assert.ok(!e.includes(PASSWORD));
  } finally {
    sub.close();
    await fake.close();
  }
});

test('subscribe: a refused types filter falls back to all events', async () => {
  const fake = await startFakeServer((r) =>
    r.path === '/api/event' && r.query.has('types') ? { status: 400, json: { _tag: 'InvalidRequestError', message: 'Expected ...' } } : undefined,
  );
  let connects = 0;
  const errors: string[] = [];
  const c = new OpenCodeClient({ discover: async () => ({ url: fake.url, password: PASSWORD, source: 't' }) });
  const sub = subscribeEvents(c, { types: ['nope'], onEvent: () => {}, onConnect: () => connects++, onError: (e) => errors.push(e.message), backoffMs: 10 });
  try {
    await waitFor(() => connects === 1, 3000, 'connect');
    assert.equal(fake.sseRequests[0]?.query.has('types'), false);
    assert.equal(errors.length, 1);
  } finally {
    sub.close();
    await fake.close();
  }
});

test('subscribe: retries while the service is down, close stops it', async () => {
  let n = 0;
  const c = new OpenCodeClient({ discover: async () => { n++; return { url: 'http://127.0.0.1:1', password: PASSWORD, source: 't' }; } });
  const errors: string[] = [];
  const sub = subscribeEvents(c, { onEvent: () => {}, onError: (e) => errors.push(e.message), backoffMs: 5, maxBackoffMs: 20 });
  await waitFor(() => errors.length >= 3, 3000, 'errors');
  sub.close();
  assert.ok(n >= 2, 'discovery repeated');
  for (const e of errors) assert.ok(!e.includes(PASSWORD));
});
