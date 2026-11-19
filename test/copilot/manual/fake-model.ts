// A fake OpenAI-compatible model for offline runs of the real Copilot CLI
// (`COPILOT_OFFLINE=true`, `COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:<port>/v1`).
//
// Every chat completion gets a fixed answer. When the last user message contains "run" and
// the request offers a shell tool, the answer is one shell tool call instead, so Copilot asks
// for permission (a `permission.requested` event). Listens on 127.0.0.1 only and closes itself
// after `lifetimeMs`. No model, no network, no cost.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModel {
  port: number;
  /** One line per request: method, path, body size, offered tools. */
  log: string[];
  close(): Promise<void>;
}

export function startFakeModel(lifetimeMs = 240_000): Promise<FakeModel> {
  const log: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        log.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      let j: { tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role?: string; content?: unknown }>; stream?: boolean } = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const names = (j.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
      log.push(`${req.method} ${req.url} ${body.length} tools=${names.length}`);
      const last = (j.messages ?? []).at(-1);
      const shell = names.find((n) => /^(bash|shell|powershell)$/.test(n));
      let msg: Record<string, unknown> = { role: 'assistant', content: 'Hello from the fake model.' };
      if (last?.role === 'user' && shell && /run/.test(JSON.stringify(last.content))) {
        const args = JSON.stringify({ command: 'touch created-by-tool.txt', description: 'Make a file' });
        msg = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: shell, arguments: args } }] };
      }
      const finish = msg.tool_calls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model' };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: msg, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: msg, finish_reason: finish }], usage }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const timer = setTimeout(() => srv.close(), lifetimeMs);
      timer.unref();
      resolve({
        port: (srv.address() as AddressInfo).port,
        log,
        close: () =>
          new Promise<void>((r) => {
            clearTimeout(timer);
            srv.closeAllConnections();
            srv.close(() => r());
          }),
      });
    });
  });
}
