// Small API helper for live_e2e.py. Prints JSON. Never prints the password.
//   node live_api.ts sessions <dir>          ids of the sessions in <dir>
//   node live_api.ts ptys <dir>              [{ id, title }] of the PTYs of location <dir>
//   node live_api.ts delete-session <id>     delete one session (only ids the test created)
//   node live_api.ts delete-pty <dir> <id>   delete one PTY (only nebula-enterprise: titles)
//   node live_api.ts version                 service version

import { discoverService, OpenCodeClient } from '../../../src/core/opencode.ts';

const [cmd, a, b] = process.argv.slice(2);
const client = new OpenCodeClient();
const loc = (d: string) => ({ 'location[directory]': d });

async function main(): Promise<unknown> {
  switch (cmd) {
    case 'sessions': {
      const r = await client.request<{ data: Array<{ id: string }> }>('GET', '/api/session', { query: { directory: a as string } });
      return r.data.map((s) => s.id);
    }
    case 'ptys': {
      const r = await client.request<{ data: Array<{ id: string; title: string }> }>('GET', '/api/pty', { query: loc(a as string) });
      return r.data.map((p) => ({ id: p.id, title: p.title }));
    }
    case 'delete-session':
      await client.request('DELETE', `/api/session/${encodeURIComponent(a as string)}`);
      return 'deleted';
    case 'delete-pty': {
      const r = await client.request<{ data: Array<{ id: string; title: string }> }>('GET', '/api/pty', { query: loc(a as string) });
      const p = r.data.find((x) => x.id === b);
      if (!p || !p.title.startsWith('nebula-enterprise:')) return 'refused';
      await client.request('DELETE', `/api/pty/${encodeURIComponent(b as string)}`, { query: loc(a as string) });
      return 'deleted';
    }
    case 'version':
      return (await discoverService())?.version ?? null;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().then(
  (v) => process.stdout.write(JSON.stringify(v) + '\n'),
  (err) => {
    process.stderr.write(client.redact(String(err instanceof Error ? err.message : err)) + '\n');
    process.exitCode = 1;
  },
);
