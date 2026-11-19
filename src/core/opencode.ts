// OpenCode V2 service: discovery and HTTP client.
//
// The password is a secret. It lives only in memory, inside the `authorization` header.
// It never goes into a URL, an argument list, a log line or an error message.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { envGet, serviceFileCandidates, type Env } from './paths.ts';
import { describeResolveFailure, resolveExecutable, run as defaultRun, type ResolveResult, type Runner } from './exe.ts';

export interface ServiceInfo {
  url: string;
  password: string;
  version?: string;
  pid?: number;
  /** Where the information came from: the file path, or 'env'. */
  source: string;
}

export interface DiscoverDeps {
  env?: Env;
  platform?: NodeJS.Platform;
  homedir?: string;
  readFile?: (p: string) => Promise<string>;
}

/** Find the running service. Returns null when it is not running (no service file). */
export async function discoverService(deps: DiscoverDeps = {}): Promise<ServiceInfo | null> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const url = envGet(env, 'CORRAL_OPENCODE_URL', platform);
  if (url) {
    return { url: url.replace(/\/+$/, ''), password: envGet(env, 'CORRAL_OPENCODE_PASSWORD', platform) ?? '', source: 'env' };
  }
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  for (const file of serviceFileCandidates(env, platform, deps.homedir ?? os.homedir())) {
    let text: string;
    try {
      text = await read(file);
    } catch {
      continue;
    }
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      if (typeof v.url !== 'string' || !v.url) continue;
      return {
        url: v.url.replace(/\/+$/, ''),
        password: typeof v.password === 'string' ? v.password : '',
        version: typeof v.version === 'string' ? v.version : undefined,
        pid: typeof v.pid === 'number' ? v.pid : undefined,
        source: file,
      };
    } catch {
      // A half-written file during a service start. The caller retries.
      continue;
    }
  }
  return null;
}

export interface EnsureDeps extends DiscoverDeps {
  run?: Runner;
  resolve?: (name: string) => ResolveResult;
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for the service file after the start command. */
  waitMs?: number;
  /**
   * Tells whether the service process still runs. A killed service leaves its file behind
   * (always on Windows, where a process cannot clean up), and that file must count as absent.
   */
  isAlive?: (pid: number) => boolean;
}

function usable(info: ServiceInfo | null, isAlive: ((pid: number) => boolean) | undefined): ServiceInfo | null {
  if (!info || !isAlive || info.source === 'env' || info.pid === undefined) return info;
  return isAlive(info.pid) ? info : null;
}

/** Find the service. When it is not running, run `opencode service start` and look again. */
export async function ensureService(deps: EnsureDeps = {}): Promise<ServiceInfo> {
  const found = usable(await discoverService(deps), deps.isAlive);
  if (found) return found;
  const resolved = (deps.resolve ?? ((n: string) => resolveExecutable(n, { env: deps.env, platform: deps.platform })))('opencode');
  if (!resolved.ok) throw new OpenCodeError(0, 'ServiceNotFound', `OpenCode service is not running, and ${describeResolveFailure('opencode', resolved)}`);
  const r = await (deps.run ?? defaultRun)(resolved.path, ['service', 'start'], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    const detail = (r.error?.message ?? r.stderr.trim()) || `exit code ${r.code}`;
    throw new OpenCodeError(0, 'ServiceStartFailed', `opencode service start failed: ${detail.slice(0, 500)}`);
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const deadline = deps.waitMs ?? 10_000;
  for (let waited = 0; ; waited += 200) {
    const again = usable(await discoverService(deps), deps.isAlive);
    if (again) return again;
    if (waited >= deadline) break;
    await sleep(200);
  }
  throw new OpenCodeError(0, 'ServiceNotFound', 'opencode service start ran, but the service file did not appear');
}

/** Error from the service, or a connection error (status 0). The message never holds the password. */
export class OpenCodeError extends Error {
  readonly status: number;
  /** `_tag` of the service error, or a local tag such as 'ConnectionError', 'Timeout'. */
  readonly tag: string;
  constructor(status: number, tag: string, message: string) {
    super(message);
    this.name = 'OpenCodeError';
    this.status = status;
    this.tag = tag;
  }
}

export type QueryValue = string | number | boolean | null | undefined | readonly string[];
export type Query = Record<string, QueryValue>;

/** Query parameters that select an OpenCode location (deepObject style). */
export function locationQuery(directory: string): Query {
  return { 'location[directory]': directory };
}

export function buildQuery(q: Query | undefined): string {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, item);
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Default 15 s. 0 = no timeout. */
  timeoutMs?: number;
}

export interface Connection {
  /** Base URL without a trailing slash, for example `http://127.0.0.1:49374`. */
  url: string;
  /** Value of the `authorization` header. Do not log it. */
  authorization: string;
}

export interface ClientOptions {
  /** Finds the service. Called again after a connection error, because the service can restart. */
  discover?: () => Promise<ServiceInfo | null>;
  fetch?: typeof fetch;
}

/** The subset of the client that other modules use. Tests can give a fake. */
export interface OpenCodeApi {
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  connection(refresh?: boolean): Promise<Connection>;
}

export class OpenCodeClient implements OpenCodeApi {
  #discover: () => Promise<ServiceInfo | null>;
  #fetch: typeof fetch;
  #conn: Connection | null = null;
  #secret = '';
  #pending: Promise<Connection> | null = null;

  constructor(opts: ClientOptions = {}) {
    this.#discover = opts.discover ?? (() => discoverService());
    this.#fetch = opts.fetch ?? fetch;
  }

  /** URL and authorization header. `refresh` reads the service file again. */
  connection(refresh = false): Promise<Connection> {
    if (this.#conn && !refresh) return Promise.resolve(this.#conn);
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      try {
        const info = await this.#discover();
        if (!info) throw new OpenCodeError(0, 'ServiceNotFound', 'OpenCode service is not running');
        this.#secret = info.password;
        this.#conn = {
          url: info.url,
          authorization: 'Basic ' + Buffer.from('opencode:' + info.password).toString('base64'),
        };
        return this.#conn;
      } finally {
        this.#pending = null;
      }
    })();
    return this.#pending;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    let conn = await this.connection();
    try {
      return await this.#once<T>(conn, method, path, opts);
    } catch (err) {
      // The service can restart on a new port with a new password: look again, then retry one time.
      if (!(err instanceof OpenCodeError) || !(err.tag === 'ConnectionError' || err.status === 401)) throw err;
      if (opts.signal?.aborted) throw err;
      const before = conn;
      try {
        conn = await this.connection(true);
      } catch {
        throw err;
      }
      if (conn.url === before.url && conn.authorization === before.authorization) throw err;
      return await this.#once<T>(conn, method, path, opts);
    }
  }

  async #once<T>(conn: Connection, method: string, path: string, opts: RequestOptions): Promise<T> {
    const url = conn.url + path + buildQuery(opts.query);
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const headers: Record<string, string> = { authorization: conn.authorization, accept: 'application/json' };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    } catch (err) {
      throw this.#networkError(err, method, path, opts.signal);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw this.#networkError(err, method, path, opts.signal);
    }
    let value: unknown = undefined;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    const tagged = isErrorShape(value);
    if (!res.ok || tagged) {
      const v = (value ?? {}) as Record<string, unknown>;
      const tag = typeof v._tag === 'string' ? v._tag : `HTTP${res.status}`;
      const raw = typeof v.message === 'string' ? v.message : typeof value === 'string' ? value : res.statusText;
      throw new OpenCodeError(res.ok ? 500 : res.status, tag, this.redact(`${method} ${path}: ${res.status} ${tag}: ${String(raw).slice(0, 500)}`));
    }
    return value as T;
  }

  #networkError(err: unknown, method: string, path: string, signal: AbortSignal | undefined): OpenCodeError {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (signal?.aborted) return new OpenCodeError(0, 'Aborted', `${method} ${path}: aborted`);
    if (e?.name === 'TimeoutError') return new OpenCodeError(0, 'Timeout', `${method} ${path}: timed out`);
    const code = e?.cause?.code ?? e?.name ?? 'Error';
    return new OpenCodeError(0, 'ConnectionError', this.redact(`${method} ${path}: cannot connect to OpenCode service (${code})`));
  }

  /** Remove the password and the header value from a text. */
  redact(text: string): string {
    let out = text;
    const secrets = [this.#secret, this.#conn?.authorization, this.#conn?.authorization.slice(6)];
    for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
    return out;
  }
}

function isErrorShape(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const tag = (v as Record<string, unknown>)._tag;
  return typeof tag === 'string' && /Error$/.test(tag);
}
