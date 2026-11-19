// Optional debug log (CORRAL_LOG=<path>). Lines are redacted before they are queued, and the
// writes are asynchronous so a slow disk never blocks a key handler.

import { appendFile } from 'node:fs/promises';

export type Logger = (line: string) => void;

export interface LogOptions {
  file: string | undefined;
  redact: (text: string) => string;
  now?: () => number;
  append?: (file: string, text: string) => Promise<void>;
}

export function createLogger(opts: LogOptions): Logger {
  if (!opts.file) return () => {};
  const file = opts.file;
  const now = opts.now ?? Date.now;
  const append = opts.append ?? ((f: string, t: string) => appendFile(f, t, 'utf8'));
  let queue: string[] = [];
  let busy = false;
  const drain = async (): Promise<void> => {
    busy = true;
    while (queue.length > 0) {
      const text = queue.join('');
      queue = [];
      try {
        await append(file, text);
      } catch {
        // A log that cannot be written must never break the program.
      }
    }
    busy = false;
  };
  return (line: string) => {
    queue.push(`${new Date(now()).toISOString()} ${opts.redact(line).replace(/\r?\n/g, ' | ')}\n`);
    if (!busy) void drain();
  };
}

/** Remove every given secret (and its base64 forms in a Basic header) from a text. */
export function makeRedactor(secrets: () => Array<string | undefined>): (text: string) => string {
  return (text: string) => {
    let out = text;
    for (const s of secrets()) {
      if (!s || s.length < 4) continue;
      out = out.split(s).join('***');
      const b64 = Buffer.from('opencode:' + s).toString('base64');
      out = out.split(b64).join('***');
    }
    return out;
  };
}
