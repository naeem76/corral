# nebula-enterprise

A terminal program that manages OpenCode sessions: a Projects column, a Git column
(checkouts, worktrees, pull requests, and folders without Git), a Sessions column, and a pane
that shows the OpenCode TUI. A second view (an inbox with snooze) comes later.

It replaces Nebula (a Rust TUI) and T3 Code for a workplace where neither is permitted.

## Hard constraints

- **Target: Windows 11, Windows Terminal, PowerShell. `cmd.exe` is disabled.**
  Development and tests run on Linux. All code must work on both.
- **Runtime: Node.js 26. Zero npm packages**, at run time and at development time.
  No `dependencies`, no `devDependencies`, no vendored third-party code.
- **TypeScript without a build step.** Node 26 removes the types itself. Use only erasable
  syntax: no `enum`, no `namespace`, no constructor parameter properties, no decorators.
  Import with the full file name: `import { x } from './store.ts'`. Use `import type` for types.
- **Never start a shell.** No `shell: true`, no `exec`, no `cmd /c`. Use `execFile` / `spawn`
  with an argument array. On Windows a `.cmd` shim cannot run, so resolve a real `.exe`.
- **No experimental Node modules:** do not use `node:sqlite` or `node:ffi`.
- Paths: use `node:path` and `node:os`. Do not assume `/`. Compare paths with a helper that
  ignores case and separator style on Windows.
- No daemon and no OpenCode plugin. This program is a client of the OpenCode background service.

## Commands

On the development machine the default Node is 24, so select 26:

```
fnm exec --using=26 node --test "test/**/*.test.ts"     # all tests
fnm exec --using=26 node src/main.ts                    # run the TUI
fnm exec --using=26 node src/main.ts doctor             # check the machine
npx -y -p typescript tsc --noEmit -p .                  # optional type check, dev machine only
```

Tests use `node:test` and `node:assert/strict`. Unit tests must not need a running OpenCode
service: use a fake HTTP/WebSocket server from `node:http`, or inject a transport.

## Layout

```
src/types.ts        shared contracts (owner: planner; do not edit in a worker task)
src/main.ts         entry: TUI by default, `doctor` subcommand
src/core/           OpenCode client, events, PTY, state store, Git, session status
src/term/           terminal emulator (VT parser + screen grid)
src/tui/            input decoder, renderer, widgets, the app (columns, pane)
test/               mirrors src/: test/core/*.test.ts, test/term/*.test.ts, test/tui/*.test.ts
docs/opencode-openapi-2.3.2.json   OpenAPI document of the service, saved from 2.3.2
```

## OpenCode V2 service: verified facts (OpenCode 2.3.2, Linux)

- Discovery: `~/.local/state/opencode/service.json` holds `{ id, version, url, pid, password }`.
  The file is absent when the service is stopped. `opencode service status` prints the URL or
  `stopped`; `opencode service start` starts it. The Windows location of this file is **not
  verified**; keep the lookup in one function with an environment override
  (`NEBULA_OPENCODE_URL`, `NEBULA_OPENCODE_PASSWORD`, `NEBULA_OPENCODE_SERVICE_FILE`).
- Auth: HTTP Basic, user `opencode`, password from `service.json`. Without it: `401`.
  Never print, log or store the password. Never put it in a URL or in command arguments.
- HTTP API under `/api`. See the OpenAPI file. Important operations:
  `session.list` (`GET /api/session?directory=…`), `session.active`, `session.get`,
  `session.create`, `session.update`, `session.remove`, `permission.request.list`, `form.list`,
  `project.list`, `worktree.*`, `event.subscribe` (`GET /api/event`, server-sent events).
- Errors come back as JSON with a `_tag` field (for example `UnauthorizedError`).
- The event stream is volatile: events during a disconnect are lost. After each reconnect,
  read the full state again.
- PTY: `POST /api/pty?location[directory]=<dir>` with `{ command, args, cwd, title, env }`
  creates a PTY. `PUT /api/pty/{id}` with `{ size: { rows, cols } }` resizes it.
  `DELETE /api/pty/{id}` removes it. `GET /api/pty/{id}/connect?location[directory]=<dir>` is a
  WebSocket. Node's built-in `WebSocket` connects with
  `new WebSocket(url, { headers: { authorization } })`.
  Frames from the server: a **binary** frame that starts with byte `0x00` followed by JSON
  (`{"cursor":0}`) is a control frame; **text** frames are terminal output.
  The `cursor` query parameter asks for a replay from an output offset.
- The OpenCode TUI runs correctly in such a PTY (`command: "opencode"`). At start it sends many
  terminal queries (cursor position `CSI 6n`, device attributes `CSI c`, kitty keyboard
  `CSI ?u`, mode queries `CSI ?…$p`, OSC 10/11 colors, XTVERSION `CSI >0q`).
- `opencode --session <id>` continues a session, or creates it when the id does not exist.

## Safety rules for the live service on the development machine

The service on this machine holds the owner's real sessions.

- Never stop or restart the service. Never run `opencode upgrade`.
- Use a new scratch directory for every live test. Create sessions only there. Delete the
  sessions and PTYs that the test created. Never change or delete any other session.
- Live tests are opt-in: they run only when `NEBULA_LIVE=1` is set. The default test run must
  pass with the service stopped.
- Do not send prompts to a model in tests. That costs money.

## Product scope (stage 1)

Reference for behavior and keys: the owner's Nebula fork at
`/home/naeem/dev/Work-OSS-fixing/nebula` (read `docs/keys.md`, `README.md`). Take the ideas and
the key bindings for the features in scope. Do not port the Rust code.

In scope: Projects column (add and remove folders, Git or not, order, scroll, filter), Git
column (root checkout, worktrees: list, create, delete; branch; dirty mark; pull requests from
Azure DevOps through `az` when it exists), Sessions column (list by directory, status dot, new,
resume, rename, archive), embedded pane with the OpenCode TUI, `doctor` command.

Out of scope: other agent CLIs, presets, issues, diff viewer, file finder, SSH, tunnel,
browser mode, workspaces, notes, links, run commands, hooks, plugins, settings overlay.

Own state: one JSON file (`state.json`) in the user data directory
(`%LOCALAPPDATA%\nebula-enterprise` on Windows, `$XDG_STATE_HOME/nebula-enterprise` or
`~/.local/state/nebula-enterprise` elsewhere; override: `NEBULA_STATE_DIR`). Write it
atomically (temporary file, then rename). Sessions stay in OpenCode; do not copy them.

## Code rules

- Small modules with explicit inputs. Side effects (process, file system, network, clock) come
  in through parameters, so tests can replace them.
- A key or mouse handler never blocks. Slow work is asynchronous, and the UI shows the old
  state until the result arrives.
- Comments say why, not what. Keep them short.
- Do not commit. The planner reviews and commits.
