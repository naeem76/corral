import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/core/store.ts';

const made: string[] = [];
after(() => Promise.all(made.map((d) => rm(d, { recursive: true, force: true }))));
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'nebula-store-'));
  made.push(d);
  return d;
};

test('missing file gives defaults; save is atomic and leaves no temp file', async () => {
  const dir = await tmp();
  const stateDir = path.join(dir, 'nested', 'state');
  const s = new Store({ dir: stateDir, debounceMs: 5 });
  await s.load();
  assert.deepEqual(s.projects, []);
  assert.equal(s.ui.view, 'main');
  const proj = path.join(dir, 'My Repo é');
  await mkdir(proj);
  const p = await s.addProject(proj);
  assert.equal(p.name, 'My Repo é');
  assert.equal(p.kind, 'dir');
  await s.flush();
  const files = await readdir(stateDir);
  assert.deepEqual(files, ['state.json']);
  const saved = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.projects[0].path, proj);
});

test('debounced save writes after the delay', async () => {
  const dir = await tmp();
  const s = new Store({ dir, debounceMs: 20 });
  await s.load();
  s.setUi({ selectedSessionId: 'ses_1' });
  await assert.rejects(readFile(path.join(dir, 'state.json'), 'utf8'));
  await new Promise((r) => setTimeout(r, 80));
  const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.ui.selectedSessionId, 'ses_1');
});

test('corrupt file is moved aside and defaults are used', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'state.json'), '{"version":1,"projects":[');
  const s = new Store({ dir, now: () => 1234 });
  await s.load();
  assert.deepEqual(s.projects, []);
  assert.equal(s.recoveredFrom, path.join(dir, 'state.json.corrupt-1234'));
  assert.equal(await readFile(path.join(dir, 'state.json.corrupt-1234'), 'utf8'), '{"version":1,"projects":[');
});

test('unknown keys are kept on save', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'state.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      future: { a: 1 },
      projects: [{ id: 'p1', path: dir, name: 'x', kind: 'git', color: 'red' }, { bad: true }],
      ui: { view: 'inbox', selectedProjectId: 'p1', selectedCheckoutPath: null, selectedSessionId: null, extra: 5 },
      sessions: { ses_1: { lastSeen: 5, note: 'n' } },
    }),
  );
  const s = new Store({ dir, debounceMs: 1 });
  await s.load();
  assert.equal(s.projects.length, 1);
  s.setSessionMeta('ses_1', { snoozedUntil: 10 });
  await s.flush();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.future, { a: 1 });
  assert.equal(saved.projects[0].color, 'red');
  assert.equal(saved.ui.extra, 5);
  assert.equal(saved.ui.view, 'inbox');
  assert.deepEqual(saved.sessions.ses_1, { lastSeen: 5, note: 'n', snoozedUntil: 10 });
});

test('project operations: duplicates, remove, rename, move', async () => {
  const dir = await tmp();
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  await mkdir(a);
  await mkdir(b);
  const s = new Store({ dir: path.join(dir, 'st'), detectKind: async (p) => (p === a ? 'git' : 'dir') });
  await s.load();
  const pa = await s.addProject(a);
  const pb = await s.addProject(b + path.sep, 'Bee');
  assert.equal(pa.kind, 'git');
  assert.equal(pb.name, 'Bee');
  assert.equal(pb.path, b);
  await assert.rejects(s.addProject(a + path.sep), /already/);
  await assert.rejects(s.addProject(path.join(dir, 'missing')), /does not exist/);
  assert.equal(s.moveProject(pa.id, -1), false);
  assert.equal(s.moveProject(pa.id, 1), true);
  assert.deepEqual(s.projects.map((p) => p.id), [pb.id, pa.id]);
  assert.equal(s.renameProject(pa.id, '  New  '), true);
  assert.equal(s.findProject(pa.id)?.name, 'New');
  s.setUi({ selectedProjectId: pa.id });
  assert.equal(s.removeProject(pa.id), true);
  assert.equal(s.ui.selectedProjectId, null);
  assert.equal(s.removeProject(pa.id), false);
  await s.flush();
});

test('duplicate check ignores case on win32 rules', async () => {
  const dir = await tmp();
  const s = new Store({ dir: path.join(dir, 'st'), platform: 'win32' });
  await s.load();
  const a = path.join(dir, 'Repo');
  await mkdir(a);
  await s.addProject(a);
  // On Linux the other-case path does not exist, so only check the comparison through rename of a stored path.
  (s.data.projects[0] as { path: string }).path = a.toUpperCase();
  await assert.rejects(s.addProject(a), /already/);
  await s.flush();
});
