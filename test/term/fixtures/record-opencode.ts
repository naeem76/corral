// Records the real OpenCode TUI output for the emulator fixture tests. Run by hand only:
//
//   fnm exec --using=26 node test/term/fixtures/record-opencode.ts
//
// It starts `opencode` in a PTY of the running OpenCode service, in a new empty scratch
// directory, answers terminal queries through the emulator, records the output at 100x30,
// resizes to 80x24 and records again. It sends no keys and no prompt. Afterwards it removes the
// PTY and any session that appeared in the scratch directory. The password is only sent in the
// authorization header and never written anywhere.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmulator, screenToText } from '../../../src/term/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.NE_FIXTURE_DIR ?? '/tmp/ne-fixture';
const RECORD_MS = Number(process.env.NE_FIXTURE_MS ?? 5000);
const SIZES: Array<[number, number]> = [
  [100, 30],
  [80, 24],
];

function discover(): { url: string; password: string } {
  const file = process.env.CORRAL_OPENCODE_SERVICE_FILE ?? join(homedir(), '.local', 'state', 'opencode', 'service.json');
  const svc = JSON.parse(readFileSync(file, 'utf8')) as { url: string; password: string };
  return {
    url: process.env.CORRAL_OPENCODE_URL ?? svc.url,
    password: process.env.CORRAL_OPENCODE_PASSWORD ?? svc.password,
  };
}

const { url: base, password } = discover();
const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
const loc = '?location[directory]=' + encodeURIComponent(SCRATCH);

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; value: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { status: res.status, value };
}

async function sessionIds(): Promise<string[]> {
  const r = await api('GET', '/api/session?directory=' + encodeURIComponent(SCRATCH));
  const list = Array.isArray(r.value) ? r.value : Array.isArray(r.value?.data) ? r.value.data : [];
  return list.filter((s: any) => s?.directory === SCRATCH).map((s: any) => String(s.id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A fresh, empty directory: refuse to reuse one with content.
mkdirSync(SCRATCH, { recursive: true });
if (readdirSync(SCRATCH).length > 0) throw new Error(`${SCRATCH} is not empty`);
const before = new Set(await sessionIds());

const created = await api('POST', '/api/pty' + loc, {
  command: 'opencode',
  args: [],
  cwd: SCRATCH,
  title: 'ne-fixture',
  env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});
const id: string | undefined = created.value?.data?.id ?? created.value?.id;
if (!id) throw new Error(`PTY create failed: ${created.status}`);
console.log('pty', id);

const queries: string[] = [];
const replies: string[] = [];
try {
  const [c0, r0] = SIZES[0]!;
  await api('PUT', `/api/pty/${id}` + loc, { size: { rows: r0, cols: c0 } });
  const em = createEmulator(c0, r0);
  const phases: string[][] = [[]];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/pty/${id}/connect` + loc, {
    headers: { authorization: auth },
  } as any);
  ws.binaryType = 'arraybuffer';
  em.onReply = (data) => {
    replies.push(data);
    ws.send(data);
  };
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') return; // control frame
    phases[phases.length - 1]!.push(e.data);
    for (const m of e.data.matchAll(/\x1b(\[[?>=<]?[\d;:]*[$ ]?[a-zA-Z]|\][^\x07\x1b]*\?[^\x07\x1b]*(\x07|\x1b\\)|P\+q[^\x1b]*)/g)) {
      const q = m[0];
      if (/\[(\??6n|>?0?c|5n|\?u|.*\$p|>0?q|1[468]t|\?996n)$/.test(q) || q.startsWith('\x1b]') || q.startsWith('\x1bP')) queries.push(q);
    }
    em.write(e.data);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket error'));
  });
  await sleep(RECORD_MS);
  console.log(`--- ${c0}x${r0} ---\n` + screenToText(em));

  const [c1, r1] = SIZES[1]!;
  phases.push([]);
  em.resize(c1, r1);
  await api('PUT', `/api/pty/${id}` + loc, { size: { rows: r1, cols: c1 } });
  await sleep(Math.max(2000, RECORD_MS / 2));
  console.log(`--- ${c1}x${r1} ---\n` + screenToText(em));
  ws.close();

  // The user name can show up in paths (for example in a plugin error toast). Replace it with
  // a placeholder of the same length so the layout of the recorded screen stays the same.
  const user = userInfo().username;
  if (user.length >= 3) {
    const placeholder = 'user'.padEnd(user.length, '0').slice(0, user.length);
    for (const phase of phases) for (let k = 0; k < phase.length; k++) phase[k] = phase[k]!.split(user).join(placeholder);
  }
  const all = JSON.stringify(phases);
  if (all.includes(password) || all.includes(auth)) throw new Error('fixture contains the service password');
  if (user.length >= 3 && all.includes(user)) throw new Error('fixture contains the user name');
  SIZES.forEach(([c, r], k) => {
    const file = join(HERE, `opencode-${c}x${r}.json`);
    writeFileSync(file, JSON.stringify(phases[k], null, 0) + '\n');
    console.log('wrote', file, phases[k]!.length, 'chunks');
  });
  console.log('queries', JSON.stringify([...new Set(queries)]));
  console.log('replies', JSON.stringify([...new Set(replies)]));
} finally {
  const del = await api('DELETE', `/api/pty/${id}` + loc);
  console.log('pty removed', del.status);
  for (const sid of await sessionIds()) {
    if (before.has(sid)) continue;
    const r = await api('DELETE', `/api/session/${sid}`);
    console.log('session removed', sid, r.status);
  }
  rmSync(SCRATCH, { recursive: true, force: true });
}
