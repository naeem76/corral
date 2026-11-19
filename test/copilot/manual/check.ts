// Manual, opt-in check: the real GitHub Copilot CLI writes a session, and `CopilotSource`
// reads it right (title, cwd, status sequence with a pending permission). Offline: a fake
// model on 127.0.0.1 (fake-model.ts), a scratch COPILOT_HOME, no GitHub login, no network.
// Linux/macOS (the PTY driver uses Python's pty module).
//
//   fnm exec --using=26 node test/copilot/manual/check.ts <path to the copilot program>
//
// The copilot program: `node_modules/.bin/copilot` of an `npm i @github/copilot` in a scratch
// folder outside this repository (never install it here). Exit code 0 when every check passes.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CopilotSource } from '../../../src/core/copilot.ts';
import { samePath } from '../../../src/core/paths.ts';
import type { SessionMarks, SessionStatus } from '../../../src/types.ts';
import { startFakeModel } from './fake-model.ts';

const bin = process.argv[2];
if (!bin) {
  process.stderr.write('usage: node test/copilot/manual/check.ts <path to the copilot program>\n');
  process.exit(2);
}

const marks = new Map<string, SessionMarks>();
const store = {
  sessionMeta: (id: string) => marks.get(id),
  setSessionMeta: (id: string, patch: Partial<SessionMarks>) => {
    marks.set(id, { ...(marks.get(id) ?? {}), ...patch });
  },
};

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}\n`);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'corral-copilot-check-'));
const home = path.join(scratch, 'home');
const proj = path.join(scratch, 'proj');
await mkdir(home);
await mkdir(proj);
const model = await startFakeModel(120_000);
const loader = await realpath(bin);
try {
  const src = new CopilotSource({
    home,
    store,
    launch: () => ({ ok: true, kind: 'exe', command: loader, args: [] }),
    // The fake timers are never fired: this script polls by hand, faster than the defaults.
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  await src.watch([proj]);
  const id = await src.create(proj);
  check(src.isPending(id) && src.row(id)?.title === 'New Copilot session', `pending row before the program starts (${id})`);
  src.opened(id);

  const seen: Array<{ t: number; status: SessionStatus; title: string }> = [];
  const driver = spawn('python3', [path.join(import.meta.dirname, 'drive.py'), process.execPath, loader, home, proj, String(model.port), id, scratch], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
  });
  const exited = new Promise<number | null>((r) => driver.once('exit', (c) => r(c)));
  let done = false;
  void exited.then(() => (done = true));
  const start = Date.now();
  while (!done && Date.now() - start < 90_000) {
    await src.refresh();
    const r = src.row(id);
    if (r && (seen.length === 0 || seen[seen.length - 1]?.status !== r.status)) seen.push({ t: Date.now() - start, status: r.status, title: r.title });
    await new Promise((res) => setTimeout(res, 200));
  }
  check((await exited) === 0, 'the driver ran to the end');
  await src.closed(id);
  const row = src.row(id);
  process.stdout.write(`      status sequence: ${seen.map((s) => `${s.status}@${(s.t / 1000).toFixed(1)}s`).join(' -> ')}\n`);
  process.stdout.write(`      fake model requests: ${model.log.length}\n`);
  check(!src.isPending(id) && row !== undefined, 'the real row replaced the pending one');
  check(row?.title === 'please run the command', `title from workspace.yaml: "${row?.title}"`);
  check(row !== undefined && samePath(row.directory, proj), `cwd is the project folder (${row?.directory})`);
  check(seen.some((s) => s.status === 'needs-input'), 'needs-input while the permission question waits');
  const i = seen.findIndex((s) => s.status === 'needs-input');
  check(i >= 0 && seen.slice(i + 1).some((s) => s.status === 'unseen' || s.status === 'idle'), 'the question ends after Esc');
  check(row?.status === 'unseen' && row.outcome === 'interrupted', `final: ${row?.status} (${row?.outcome ?? 'no outcome'}), after an abort`);
  src.markSeen(id);
  check(src.status(id) === 'idle', 'idle after markSeen');
  const phases = await readFile(path.join(scratch, 'phases.txt'), 'utf8').catch(() => '');
  check(phases.includes('done'), 'driver phases: ' + phases.trim().split('\n').map((l) => l.split(' ')[1]).join(', '));
  src.dispose();
} finally {
  await model.close();
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
