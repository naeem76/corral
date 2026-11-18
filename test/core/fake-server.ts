// A fake OpenCode service for unit tests: plain `node:http`, SSE, and a minimal
// WebSocket server written by hand (RFC 6455, enough for text/binary/close frames).

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export const PASSWORD = 's3cr3t-Pa55word-xyz';
export const AUTH = 'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64');

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
}

export type Handler = (req: FakeRequest) => FakeReply | Promise<FakeReply> | undefined;

export class FakeSocket {
  readonly socket: Duplex;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: http.IncomingHttpHeaders;
  received: Array<{ text: boolean; data: Buffer }> = [];
  onMessage: ((m: { text: boolean; data: Buffer }) => void) | null = null;
  closed = false;
  #buf = Buffer.alloc(0);

  constructor(socket: Duplex, path: string, query: URLSearchParams, headers: http.IncomingHttpHeaders) {
    this.socket = socket;
    this.path = path;
    this.query = query;
    this.headers = headers;
    socket.on('data', (d: Buffer) => this.#read(d));
    socket.on('close', () => (this.closed = true));
    socket.on('error', () => {});
  }

  sendText(s: string): void {
    this.#frame(0x1, Buffer.from(s, 'utf8'));
  }

  sendBinary(b: Buffer): void {
    this.#frame(0x2, b);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#frame(0x8, p);
    this.socket.end();
    this.closed = true;
  }

  /** Drop the TCP connection without a close frame. */
  destroy(): void {
    this.socket.destroy();
    this.closed = true;
  }

  #frame(op: number, payload: Buffer): void {
    if (this.closed) return;
    let head: Buffer;
    if (payload.length < 126) head = Buffer.from([0x80 | op, payload.length]);
    else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  #read(d: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < 2) return;
      const b0 = this.#buf[0] as number;
      const b1 = this.#buf[1] as number;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.#buf.length < 4) return;
        len = this.#buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.#buf.length < 10) return;
        len = Number(this.#buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (this.#buf.length < need) return;
      const mask = masked ? this.#buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.#buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      this.#buf = this.#buf.subarray(need);
      const op = b0 & 0x0f;
      if (op === 0x8) {
        if (!this.closed) {
          this.#frame(0x8, payload.subarray(0, 2));
          this.socket.end();
          this.closed = true;
        }
        return;
      }
      if (op === 0x9) {
        this.#frame(0xa, payload);
        continue;
      }
      if (op === 0x1 || op === 0x2) {
        const m = { text: op === 0x1, data: payload };
        this.received.push(m);
        this.onMessage?.(m);
      }
    }
  }
}

export interface FakeServer {
  url: string;
  requests: FakeRequest[];
  handler: Handler;
  /** Open SSE responses. */
  sse: http.ServerResponse[];
  sseRequests: FakeRequest[];
  sendEvent(ev: unknown): void;
  /** End all SSE responses (simulates a dropped stream). */
  dropSse(): void;
  sockets: FakeSocket[];
  onSocket: ((s: FakeSocket) => void) | null;
  /** Reject WebSocket upgrades with this status (for example 404). */
  upgradeStatus: number | null;
  close(): Promise<void>;
}

export async function startFakeServer(handler: Handler = () => undefined): Promise<FakeServer> {
  const fake: FakeServer = {
    url: '',
    requests: [],
    handler,
    sse: [],
    sseRequests: [],
    sockets: [],
    onSocket: null,
    upgradeStatus: null,
    sendEvent(ev) {
      const text = 'data: ' + JSON.stringify(ev) + '\n\n';
      for (const r of fake.sse) r.write(text);
    },
    dropSse() {
      for (const r of fake.sse) r.destroy();
      fake.sse = [];
    },
    close: async () => {},
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const fr: FakeRequest = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body };
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }));
      return;
    }
    if (fr.path === '/api/event' && fr.method === 'GET') {
      const reply = await fake.handler(fr);
      if (reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json ?? null));
        return;
      }
      fake.sseRequests.push(fr);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"id":"evt_0","type":"server.connected","data":{}}\n\n: heartbeat\n\n');
      fake.sse.push(res);
      res.on('close', () => (fake.sse = fake.sse.filter((r) => r !== res)));
      return;
    }
    fake.requests.push(fr);
    const reply = (await fake.handler(fr)) ?? { status: 404, json: { _tag: 'NotFound', message: 'no route' } };
    const status = reply.status ?? 200;
    if (status === 204 || reply.json === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.headers.authorization !== AUTH) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (fake.upgradeStatus) {
      socket.end(`HTTP/1.1 ${fake.upgradeStatus} Nope\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new FakeSocket(socket, u.pathname, u.searchParams, req.headers);
    fake.sockets.push(ws);
    fake.onSocket?.(ws);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      for (const s of fake.sockets) s.destroy();
      fake.dropSse();
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}

export function waitFor(cond: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}
