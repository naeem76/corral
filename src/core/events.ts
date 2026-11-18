// OpenCode event stream (`GET /api/event`, server-sent events).
//
// Verified on 2.3.2: the stream is global (events from every location), each message has
// only a `data:` line holding `{ id, created, type, location?, data, durable? }`, the first
// message is `server.connected`, and `: heartbeat` comments keep the stream alive.
// An unknown name in the `types` filter makes the request fail with 400.
// The stream is volatile: after every (re)connect the consumer must read the full state again.

import type { OpenCodeApi } from './opencode.ts';
import { buildQuery, OpenCodeError } from './opencode.ts';

export interface SseMessage {
  event: string;
  data: string;
  id: string;
}

/** Incremental SSE parser (WHATWG rules). Feed decoded text in chunks of any size. */
export class SseParser {
  #buf = '';
  #skipLf = false;
  #data: string[] = [];
  #event = '';
  #id = '';
  #lastId = '';
  #onMessage: (m: SseMessage) => void;

  constructor(onMessage: (m: SseMessage) => void) {
    this.#onMessage = onMessage;
  }

  push(chunk: string): void {
    let text = chunk;
    if (this.#skipLf) {
      if (text.startsWith('\n')) text = text.slice(1);
      if (text.length > 0) this.#skipLf = false;
    }
    this.#buf += text;
    let start = 0;
    for (let i = 0; i < this.#buf.length; i++) {
      const c = this.#buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.#line(this.#buf.slice(start, i));
      if (c === 13) {
        if (i + 1 < this.#buf.length) {
          if (this.#buf.charCodeAt(i + 1) === 10) i++;
        } else {
          // CR at the end of the chunk: an LF in the next chunk belongs to it.
          this.#skipLf = true;
        }
      }
      start = i + 1;
    }
    this.#buf = this.#buf.slice(start);
  }

  #line(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.#data.push(value);
        break;
      case 'event':
        this.#event = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.#id = value;
        break;
      default:
        break;
    }
  }

  #dispatch(): void {
    this.#lastId = this.#id;
    if (this.#data.length === 0) {
      this.#event = '';
      return;
    }
    const msg = { event: this.#event || 'message', data: this.#data.join('\n'), id: this.#lastId };
    this.#data = [];
    this.#event = '';
    this.#onMessage(msg);
  }
}

/** One decoded OpenCode event. */
export interface OcEvent {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string };
  data: any;
}

export interface SubscribeOptions {
  /** Only these event types. Dropped when the service refuses the filter (400). */
  types?: readonly string[];
  onEvent: (type: string, data: any, event: OcEvent) => void;
  /** After each successful (re)connect. Read the full state again here. */
  onConnect?: () => void;
  /** Connection lost; a reconnect follows. */
  onDisconnect?: (reason: string) => void;
  onError?: (err: Error) => void;
  /** First delay before a reconnect. Doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect when nothing (not even a heartbeat) arrives for this long. */
  idleTimeoutMs?: number;
  fetch?: typeof fetch;
}

export interface Subscription {
  close(): void;
}

export function subscribeEvents(client: OpenCodeApi, opts: SubscribeOptions): Subscription {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.backoffMs ?? 250;
  const max = opts.maxBackoffMs ?? 10_000;
  const idleMs = opts.idleTimeoutMs ?? 90_000;
  let types = opts.types && opts.types.length ? [...opts.types] : null;
  let closed = false;
  let current: AbortController | null = null;
  let wake: (() => void) | null = null;

  const report = (err: unknown) => {
    try {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {}
  };

  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(() => {
        wake = null;
        res();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        res();
      };
    });

  const loop = async () => {
    let delay = base;
    let refresh = false;
    while (!closed) {
      const ac = new AbortController();
      current = ac;
      let connected = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const kick = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ac.abort(new Error('event stream idle')), idleMs);
      };
      try {
        const conn = await client.connection(refresh);
        refresh = false;
        const url = conn.url + '/api/event' + buildQuery(types ? { types } : undefined);
        kick();
        const res = await doFetch(url, {
          headers: { authorization: conn.authorization, accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (res.status === 400 && types) {
          await res.body?.cancel().catch(() => {});
          report(new OpenCodeError(400, 'InvalidRequestError', 'event type filter refused; subscribing to all events'));
          types = null;
          continue;
        }
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          if (res.status === 401) refresh = true;
          throw new OpenCodeError(res.status, `HTTP${res.status}`, `GET /api/event: ${res.status}`);
        }
        connected = true;
        delay = base;
        try {
          opts.onConnect?.();
        } catch (err) {
          report(err);
        }
        const parser = new SseParser((m) => {
          let ev: OcEvent;
          try {
            ev = JSON.parse(m.data) as OcEvent;
          } catch {
            return;
          }
          if (!ev || typeof ev.type !== 'string') return;
          if (ev.type === 'server.connected') return;
          try {
            opts.onEvent(ev.type, ev.data, ev);
          } catch (err) {
            report(err);
          }
        });
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          parser.push(decoder.decode(value, { stream: true }));
          if (closed) break;
        }
        if (!closed) throw new Error('event stream ended');
      } catch (err) {
        if (closed) break;
        const e = err as { tag?: string; name?: string; message?: string; cause?: unknown };
        if (!(err instanceof OpenCodeError) || e.tag === 'ConnectionError' || e.tag === 'ServiceNotFound') refresh = true;
        if (connected) {
          try {
            opts.onDisconnect?.(String(e.message ?? err));
          } catch {}
        } else {
          report(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        current = null;
      }
      if (closed) break;
      await sleep(delay);
      delay = Math.min(max, delay * 2);
    }
  };
  void loop();

  return {
    close() {
      if (closed) return;
      closed = true;
      current?.abort();
      wake?.();
    },
  };
}
