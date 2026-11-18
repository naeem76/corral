// The outer terminal: raw mode, alternate screen, mouse and paste modes, resize, input, and a
// restore that runs on every exit path so the user's terminal is never left broken.
//
// Streams and the process object are injected so tests can use fakes. No child process, no
// `stty`, no `/dev/tty`: everything goes through the Node TTY streams.

import { writeSync } from 'node:fs';
import type { InputEvent } from '../types.ts';
import { createInputDecoder } from './input.ts';
import type { InputDecoder, InputDecoderOptions } from './input.ts';

/** The part of `process.stdin` this module uses. */
export interface InputStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  on(event: 'data', cb: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data', cb: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The part of `process.stdout` this module uses. */
export interface OutputStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  fd?: number;
  write(data: string): boolean;
  on(event: 'resize', cb: () => void): unknown;
  removeListener(event: 'resize', cb: () => void): unknown;
}

/** The part of `process` used for exit hooks. */
export interface ProcessLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  removeListener(event: string, cb: (...args: any[]) => void): unknown;
  exit(code?: number): never | void;
  readonly exitCode?: number | string | null | undefined;
}

export interface TimerApi {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TerminalOptions {
  stdin: InputStream;
  stdout: OutputStream;
  /** Default: process.platform. */
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Default: the global process. Pass a fake in tests. */
  proc?: ProcessLike;
  /** Report every mouse motion (mode 1003), not only drags. Default false. */
  mouseAnyMotion?: boolean;
  /** Enable mouse reporting at all. Default true. */
  mouse?: boolean;
  /** Install handlers for signals, uncaught errors and exit. Default true. */
  exitHooks?: boolean;
  /** Write used on the exit path, where async writes may never run. Default: fs.writeSync on stdout.fd. */
  writeSync?: (data: string) => void;
  decoder?: InputDecoderOptions;
  timers?: TimerApi;
  /** Where crash messages go after the terminal is restored. Default: process.stderr. */
  errorOut?: (text: string) => void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface Terminal {
  size(): TerminalSize;
  /** Register a callback; returns a function that removes it. */
  onResize(cb: (size: TerminalSize) => void): () => void;
  onInput(cb: (events: InputEvent[]) => void): () => void;
  /** Called after `resume()`: the screen content is unknown, draw everything (renderDiff with prev = null). */
  onRedraw(cb: () => void): () => void;
  /** One write call. Ignored after `close()` and while suspended. */
  write(data: string): void;
  /** Leave the alternate screen and give the terminal back as it was, stop reading input. */
  suspend(): void;
  /** Enter again after `suspend()`, and ask for a full redraw. */
  resume(): void;
  /** Restore the terminal and remove every hook. Safe to call more than one time. */
  close(): void;
  readonly closed: boolean;
  readonly suspended: boolean;
}

export class NotATerminalError extends Error {
  constructor(which: string) {
    super(`${which} is not a terminal. Run nebula-enterprise in a terminal window (Windows Terminal, PowerShell), not with redirected input or output.`);
    this.name = 'NotATerminalError';
  }
}

/** Sequences sent on enter. `restoreSequence` undoes them in reverse order. */
export function enterSequence(opts: { mouse?: boolean; mouseAnyMotion?: boolean } = {}): string {
  let s = '\x1b[?1049h' + '\x1b[H\x1b[2J' + '\x1b[?25l';
  if (opts.mouse !== false) {
    s += '\x1b[?1000h\x1b[?1002h';
    if (opts.mouseAnyMotion) s += '\x1b[?1003h';
    s += '\x1b[?1006h';
  }
  s += '\x1b[?2004h' + '\x1b[?1004h';
  return s;
}

export function restoreSequence(opts: { mouse?: boolean; mouseAnyMotion?: boolean } = {}): string {
  let s = '\x1b[?1004l' + '\x1b[?2004l';
  if (opts.mouse !== false) {
    s += '\x1b[?1006l';
    if (opts.mouseAnyMotion) s += '\x1b[?1003l';
    s += '\x1b[?1002l\x1b[?1000l';
  }
  // Reset the pen and the autowrap mode the renderer may have touched, show the cursor, leave
  // the alternate screen last so the user's screen comes back.
  s += '\x1b[0m' + '\x1b[?7h' + '\x1b[?25h' + '\x1b[?1049l';
  return s;
}

const SIGNAL_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

export function openTerminal(options: TerminalOptions): Terminal {
  const { stdin, stdout } = options;
  const platform = options.platform ?? process.platform;
  const proc: ProcessLike = options.proc ?? (process as unknown as ProcessLike);
  const timers: TimerApi = options.timers ?? {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const errorOut = options.errorOut ?? ((t: string) => {
    try {
      process.stderr.write(t);
    } catch {
      // Nothing left to report to.
    }
  });
  const seqOpts = { mouse: options.mouse !== false, mouseAnyMotion: options.mouseAnyMotion === true };

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new NotATerminalError('Standard input');
  if (!stdout.isTTY) throw new NotATerminalError('Standard output');

  const syncWrite = options.writeSync ?? ((data: string) => {
    if (typeof stdout.fd === 'number') {
      try {
        writeSync(stdout.fd, data);
        return;
      } catch {
        // Fall back to the stream below.
      }
    }
    stdout.write(data);
  });

  const decoder: InputDecoder = createInputDecoder(options.decoder);
  const inputCbs = new Set<(events: InputEvent[]) => void>();
  const resizeCbs = new Set<(size: TerminalSize) => void>();
  const redrawCbs = new Set<() => void>();
  let closed = false;
  let suspended = false;
  let entered = false;
  let timer: unknown = null;

  function size(): TerminalSize {
    const cols = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
    const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
    return { cols, rows };
  }

  function emit(events: InputEvent[]): void {
    if (events.length === 0) return;
    for (const cb of inputCbs) cb(events);
  }

  function schedule(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    const ms = decoder.pendingTimeout();
    if (ms === null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (closed || suspended) return;
      emit(decoder.flush());
    }, ms);
  }

  const onData = (chunk: string | Buffer): void => {
    if (closed || suspended) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const events = decoder.feed(text);
    schedule();
    emit(events);
  };

  const onResize = (): void => {
    if (closed || suspended) return;
    const s = size();
    for (const cb of resizeCbs) cb(s);
  };

  function enter(): void {
    if (entered) return;
    stdin.setRawMode!(true);
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.resume();
    stdout.on('resize', onResize);
    stdout.write(enterSequence(seqOpts));
    entered = true;
  }

  /** Undo `enter`. Uses the synchronous write: this may run inside an exit handler. */
  function leave(): void {
    if (!entered) return;
    entered = false;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    // A half-received sequence must not leak into input after resume.
    decoder.flush();
    try {
      syncWrite(restoreSequence(seqOpts));
    } catch {
      // The terminal may already be gone (SIGHUP); still try to leave raw mode.
    }
    try {
      stdin.setRawMode!(false);
    } catch {
      // Same as above.
    }
    stdin.removeListener('data', onData);
    stdout.removeListener('resize', onResize);
    try {
      stdin.pause();
    } catch {
      // Ignore: only stops reading.
    }
  }

  // --- exit hooks -----------------------------------------------------------

  const hooks: [string, (...args: any[]) => void][] = [];
  function hook(event: string, cb: (...args: any[]) => void): void {
    try {
      proc.on(event, cb);
      hooks.push([event, cb]);
    } catch {
      // A signal this platform does not know; skip it.
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    leave();
    for (const [event, cb] of hooks) {
      try {
        proc.removeListener(event, cb);
      } catch {
        // Ignore.
      }
    }
    hooks.length = 0;
    inputCbs.clear();
    resizeCbs.clear();
    redrawCbs.clear();
  }

  if (options.exitHooks !== false) {
    // On Windows only SIGINT, SIGBREAK and SIGHUP (console window closed) are delivered.
    const signals = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) {
      hook(sig, () => {
        close();
        proc.exit(SIGNAL_CODES[sig] ?? 1);
      });
    }
    hook('uncaughtException', (err: unknown) => {
      close();
      errorOut(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      proc.exit(1);
    });
    hook('unhandledRejection', (reason: unknown) => {
      close();
      errorOut(`Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
      proc.exit(1);
    });
    // The last net: runs for process.exit() from anywhere.
    hook('exit', () => close());
  }

  enter();

  function addCb<T>(set: Set<T>, cb: T): () => void {
    if (!closed) set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  return {
    size,
    onResize: (cb) => addCb(resizeCbs, cb),
    onInput: (cb) => addCb(inputCbs, cb),
    onRedraw: (cb) => addCb(redrawCbs, cb),
    write(data: string): void {
      if (closed || suspended || data.length === 0) return;
      stdout.write(data);
    },
    suspend(): void {
      if (closed || suspended) return;
      leave();
      suspended = true;
    },
    resume(): void {
      if (closed || !suspended) return;
      suspended = false;
      enter();
      for (const cb of redrawCbs) cb();
    },
    close,
    get closed() {
      return closed;
    },
    get suspended() {
      return suspended;
    },
  };
}
