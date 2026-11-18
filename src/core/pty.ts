// PTY hosted by the OpenCode service.
//
// Wire protocol, verified by live experiment against OpenCode 2.3.2 (Linux):
// - `POST /api/pty?location[directory]=D` { command, args, cwd, title, env } -> { data: Pty }.
//   The create call takes no size; `PUT /api/pty/{id}` { size: { rows, cols } } sets it
//   (the program sees the new size and gets SIGWINCH).
// - `GET /api/pty/{id}/connect?location[directory]=D&cursor=N` is a WebSocket. Node's
//   built-in WebSocket sends the `authorization` header through `new WebSocket(url, { headers })`.
// - Server -> client: TEXT frames are terminal output (a JS string). A BINARY frame whose
//   first byte is 0x00 is a control frame; the rest is JSON, seen only as `{"cursor":N}`.
//   N counts UTF-16 code units of output (JS string length), not bytes.
//   On a connect with `cursor=0` the control frame `{"cursor":0}` comes first, then output.
//   On a reconnect with `cursor=K` the replay of output from K comes first, then a control
//   frame with the cursor at the end of the replay.
// - Client -> server: input is accepted as a TEXT frame and as a BINARY frame (UTF-8);
//   we send TEXT.
// - Exit: when the program exits the socket closes with code 1000; `GET /api/pty/{id}`
//   then reports `status: "exited"` and `exitCode`, and a `pty.exited` event is sent.
//   A connect to an exited PTY closes at once with code 4404 "session exited".
//   `DELETE /api/pty/{id}` -> 204; afterwards GET -> 404 PtyNotFoundError.

import type { PtyHandle, PtySpawn } from '../types.ts';
import { locationQuery, OpenCodeError, buildQuery, type OpenCodeApi } from './opencode.ts';

export interface PtyInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
}

/** The part of the WebSocket API that this module uses. */
export interface WsLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

export interface PtyOptions {
  /** Directory that selects the OpenCode location. Default: `spawn.cwd`. */
  directory?: string;
  /** Replaced in tests. */
  webSocket?: WsFactory;
  /** Reconnect attempts after a dropped socket, before giving up with 'disconnected'. */
  maxReconnects?: number;
  reconnectDelayMs?: number;
  /** Called with errors that do not end the PTY (a failed resize, a reconnect). */
  onError?: (err: Error) => void;
}

const defaultWs: WsFactory = (url, headers) =>
  new (WebSocket as unknown as new (u: string, o: unknown) => WsLike)(url, { headers });

const OPEN = 1;

export async function openPty(client: OpenCodeApi, spawn: PtySpawn, opts: PtyOptions = {}): Promise<PtyHandle> {
  const directory = opts.directory ?? spawn.cwd;
  const loc = locationQuery(directory);
  const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(spawn.env ?? {}) };
  const created = await client.request<{ data: PtyInfo }>('POST', '/api/pty', {
    query: loc,
    body: { command: spawn.command, args: spawn.args, cwd: spawn.cwd, title: spawn.title ?? spawn.command, env },
  });
  const id = created.data.id;
  const handle = new ServicePty(client, id, directory, opts);
  try {
    await client.request('PUT', `/api/pty/${encodeURIComponent(id)}`, {
      query: loc,
      body: { size: { rows: clampSize(spawn.rows), cols: clampSize(spawn.cols) } },
    });
  } catch (err) {
    await handle.close();
    throw err;
  }
  handle.start();
  return handle;
}

function clampSize(n: number): number {
  return Math.max(1, Math.min(10_000, Math.floor(n) || 1));
}

class ServicePty implements PtyHandle {
  readonly id: string;
  onData: ((data: string) => void) | null = null;
  onExit: PtyHandle['onExit'] = null;

  #client: OpenCodeApi;
  #directory: string;
  #opts: PtyOptions;
  #ws: WsLike | null = null;
  #cursor = 0;
  #exited = false;
  #closing = false;
  #reconnects = 0;
  #queue: string[] = [];
  #decoder = new TextDecoder();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: OpenCodeApi, id: string, directory: string, opts: PtyOptions) {
    this.#client = client;
    this.id = id;
    this.#directory = directory;
    this.#opts = opts;
  }

  start(): void {
    void this.#connect();
  }

  write(data: string): void {
    if (this.#exited || this.#closing || data === '') return;
    const ws = this.#ws;
    if (ws && ws.readyState === OPEN) ws.send(data);
    else this.#queue.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.#exited || this.#closing) return;
    this.#client
      .request('PUT', `/api/pty/${encodeURIComponent(this.id)}`, {
        query: locationQuery(this.#directory),
        body: { size: { rows: clampSize(rows), cols: clampSize(cols) } },
      })
      .catch((err) => this.#error(err));
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#timer) clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {}
    }
    try {
      await this.#client.request('DELETE', `/api/pty/${encodeURIComponent(this.id)}`, { query: locationQuery(this.#directory) });
    } catch (err) {
      if (!(err instanceof OpenCodeError && err.status === 404)) this.#error(err);
    }
    this.#finish(null, 'closed');
  }

  async #connect(): Promise<void> {
    if (this.#exited || this.#closing) return;
    let conn;
    try {
      conn = await this.#client.connection(this.#reconnects > 0);
    } catch (err) {
      this.#error(err);
      this.#retry();
      return;
    }
    if (this.#exited || this.#closing) return;
    const url =
      conn.url.replace(/^http/, 'ws') +
      `/api/pty/${encodeURIComponent(this.id)}/connect` +
      buildQuery({ ...locationQuery(this.#directory), cursor: String(this.#cursor) });
    let ws: WsLike;
    try {
      ws = (this.#opts.webSocket ?? defaultWs)(url, { authorization: conn.authorization });
    } catch (err) {
      this.#error(err);
      this.#retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.onopen = () => {
      this.#reconnects = 0;
      const q = this.#queue;
      this.#queue = [];
      for (const d of q) ws.send(d);
    };
    ws.onmessage = (ev) => this.#message(ev.data);
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.#ws === ws) this.#ws = null;
      void this.#dropped(ev.code);
    };
  }

  #message(data: unknown): void {
    if (typeof data === 'string') {
      this.#cursor += data.length;
      this.#emit(data);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    if (bytes.length > 0 && bytes[0] === 0) {
      try {
        const ctl = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { cursor?: unknown };
        if (typeof ctl.cursor === 'number' && Number.isFinite(ctl.cursor)) this.#cursor = ctl.cursor;
      } catch {}
      return;
    }
    // Not seen in 2.3.2, but handle binary output in case a later version sends it.
    const text = this.#decoder.decode(bytes, { stream: true });
    this.#cursor += text.length;
    this.#emit(text);
  }

  #emit(text: string): void {
    if (!text || this.#closing) return;
    try {
      this.onData?.(text);
    } catch (err) {
      this.#error(err);
    }
  }

  async #dropped(code: number): Promise<void> {
    if (this.#exited || this.#closing) return;
    // Ask the service whether the program still runs. The close code alone is not enough:
    // 1000 is used both for an exit and for a normal server shutdown.
    let info: PtyInfo | null = null;
    let gone = false;
    try {
      const r = await this.#client.request<{ data: PtyInfo }>('GET', `/api/pty/${encodeURIComponent(this.id)}`, {
        query: locationQuery(this.#directory),
        timeoutMs: 5000,
      });
      info = r.data;
    } catch (err) {
      if (err instanceof OpenCodeError && err.status === 404) gone = true;
      else this.#error(err);
    }
    if (this.#exited || this.#closing) return;
    if (info?.status === 'exited') {
      this.#finish(typeof info.exitCode === 'number' ? info.exitCode : null, 'exited');
      return;
    }
    if (gone || code === 4404) {
      this.#finish(null, 'exited');
      return;
    }
    this.#retry();
  }

  #retry(): void {
    if (this.#exited || this.#closing) return;
    const max = this.#opts.maxReconnects ?? 8;
    if (this.#reconnects >= max) {
      this.#finish(null, 'disconnected');
      return;
    }
    const base = this.#opts.reconnectDelayMs ?? 200;
    const delay = Math.min(5000, base * 2 ** this.#reconnects);
    this.#reconnects++;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
  }

  #finish(exitCode: number | null, reason: 'exited' | 'disconnected' | 'closed'): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#queue = [];
    if (this.#timer) clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch {}
    }
    try {
      this.onExit?.({ exitCode, reason });
    } catch (err) {
      this.#error(err);
    }
  }

  #error(err: unknown): void {
    try {
      this.#opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {}
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
