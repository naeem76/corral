# corral

A terminal program that manages OpenCode and GitHub Copilot CLI sessions: a Projects column, a Git column
(checkouts, worktrees, pull requests, and folders without Git), a Sessions column, and a pane
that shows the OpenCode TUI. A second view, the inbox, shows the same sessions in sections
with snooze and settle.

It covers the core of Nebula (a Rust TUI) and the inbox of T3 Code for machines where only
Node.js is available and neither of those tools is permitted.

## Hard constraints

- **Target: Windows 11, Windows Terminal, PowerShell. `cmd.exe` is disabled.**
  Development and tests run on Linux. All code must work on both.
- **Runtime: Node.js 26. Zero npm packages.** No `dependencies`, no `devDependencies`, no
  vendored third-party code. The program and its tests must run with no `node_modules`.
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
npx tsc --noEmit -p .                                   # type check, dev machine only (see below)
```

The type check uses `typescript` and `@types/node` from a local `node_modules` that is not
recorded anywhere: `npm i --no-save typescript @types/node`. It is already installed on the
development machine. `package.json` must stay without dependencies. Other workers can be in the
middle of a change, so judge only the errors in your own files.

Tests use `node:test` and `node:assert/strict`. Unit tests must not need a running OpenCode
service: use a fake HTTP/WebSocket server from `node:http`, or inject a transport.

## Layout

```
src/types.ts        shared contracts (owner: planner; do not edit in a worker task)
src/width.ts        display width of text (owner: planner; do not edit in a worker task)
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
  (`CORRAL_OPENCODE_URL`, `CORRAL_OPENCODE_PASSWORD`, `CORRAL_OPENCODE_SERVICE_FILE`).
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

## Copilot CLI: verified facts (GitHub Copilot CLI 1.0.114, Linux)

Checked by experiment with the CLI in offline mode against a fake local model (see
`test/copilot/manual/`). No GitHub login and no network are necessary for such a check.

- Home: `$COPILOT_HOME`, default `~/.copilot`. Not moved by the XDG variables.
- One folder per session: `<home>/session-state/<session-id>/`. The id is a UUID.
  - `workspace.yaml`: flat `key: value` lines. Seen keys: `id`, `cwd`, `client_name`,
    `last_client_name`, `name` (the title; the first prompt until the user renames),
    `user_named`, `summary_count`, `fork_count`, `created_at`, `updated_at` (ISO 8601).
  - `events.jsonl`: one JSON object per line: `{ id, timestamp, parentId, type, data }`
    (`ephemeral` events are not written). It grows fast: about 29 KB for one short prompt,
    because the system message is in it. Never read the whole file to get the status.
  - Other entries: `checkpoints/`, `files/`, `research/`, `rewind-file-snapshots/`, lock files.
- `<home>/session-store.db` is an SQLite index of the sessions. Do not read or write it.
  `<home>/session-state/.session-operation-locks/<id>.lock` are empty files that stay after
  the program exits: they do not tell whether a session is in use.
- Event order seen for one prompt with one tool call:
  `session.start`, `user.message`, `assistant.turn_start`, `assistant.message`,
  `tool.execution_start`, [`permission.requested`, `permission.completed`],
  `tool.execution_complete`, `assistant.turn_end`, then again `assistant.turn_start` …
  `assistant.turn_end` for the next model call, and `session.shutdown` when the program exits.
  One user prompt gives several `turn_start`/`turn_end` pairs. `abort` is written when the
  user interrupts. While a permission question waits, `permission.requested` is the last line.
  Documented but not seen here: `user_input.requested`/`.completed`,
  `elicitation.requested`/`.completed`, `exit_plan_mode.requested`/`.completed`,
  `session.error`, `subagent.*` (https://github.com/microsoft/copilot-sdk, docs/features/streaming-events.md).
- `copilot --session-id <uuid>` resumes that session, or starts a new session with that id.
  The session folder appears when the program starts. `copilot --resume=<id>` resumes only.
  `-C <dir>` sets the working directory.
- The first start in a folder shows a "trust this folder" question in the TUI.
- The npm package `@github/copilot` is a small loader (`npm-loader.js`) plus one native
  package per platform (`@github/copilot-linux-x64/copilot`,
  `@github/copilot-win32-x64/copilot.exe`). On Windows the npm shim is `copilot.cmd`, which
  cannot run there: resolve the real `.exe`. **Not verified on Windows.**
- Offline test setup: `COPILOT_OFFLINE=true`, `COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:<port>/v1`,
  `COPILOT_PROVIDER_API_KEY=x`, `COPILOT_MODEL=<any name>`, `COPILOT_AUTO_UPDATE=false`, and a
  scratch `COPILOT_HOME`. Never use the owner's `~/.copilot` in a test.
- There is no service and no event stream. The SDK (`@microsoft/copilot-sdk`) has native
  dependencies and is not permitted here; use the files.

## Safety rules for the live service on the development machine

The service on this machine holds the owner's real sessions.

- Never stop or restart the service. Never run `opencode upgrade`.
- Use a new scratch directory for every live test. Create sessions only there. Delete the
  sessions and PTYs that the test created. Never change or delete any other session.
- Live tests are opt-in: they run only when `CORRAL_LIVE=1` is set. The default test run must
  pass with the service stopped.
- Do not send prompts to a model in tests. That costs money.

## Product scope (stage 1)

Reference for behavior and keys: Nebula (https://github.com/AgentSystemLabs/nebula; read its
`docs/keys.md` and `README.md`). Take the ideas and the key bindings for the features in scope.
Do not port the Rust code.

In scope: Projects column (add and remove folders, Git or not, order, scroll, filter), Git
column (root checkout, worktrees: list, create, delete; branch; dirty mark; pull requests from
Azure DevOps through `az` when it exists), Sessions column (list by directory, status dot, new,
resume, rename, archive), embedded pane with the OpenCode TUI, `doctor` command.

Out of scope: other agent CLIs, presets, issues, diff viewer, file finder, SSH, tunnel,
browser mode, workspaces, notes, links, run commands, hooks, plugins, settings overlay.

## Product scope (stage 2): the inbox view

A second view of the same sessions, in the style of the T3 Code inbox. `v` switches between the
projects view and the inbox view; the choice is saved in `ui.view` (`'projects'` | `'inbox'`).

- One list of all sessions of all registered projects (root folders and worktrees), with the
  pane at the right. Archived sessions and child sessions are not shown.
- Sections in this order: Needs input, Working, Open, Snoozed, Settled. The rules are in
  `src/types.ts` (`InboxSection`). The classification is a pure function in `src/core/inbox.ts`.
- Marks are the program's own data (`SessionMarks` in `state.json`, key = OpenCode session id).
  OpenCode's archive is a different thing and stays as it is.
- Snooze ends at the chosen time, or earlier when the session needs input. A session whose
  snooze time passed returns to Open with a "back" tag until the user opens it.
- Settle means "done for now". A settled session returns to Open or Working by itself when it
  has new activity.

## Product scope (stage 3): Copilot CLI sessions

The program also lists, starts and resumes GitHub Copilot CLI sessions, next to OpenCode ones.

- Each session row has an agent (`AgentId`). The contract is `SessionSource` in `src/types.ts`;
  the app talks to one hub that joins the OpenCode source and the Copilot source.
- Copilot sessions come from the files in the Copilot home. The status comes from the tail of
  `events.jsonl`.
- The pane needs a pseudo-terminal, and only the OpenCode service has one. With the service,
  a Copilot session runs in the pane. Without it, a Copilot session opens in the full window.
- The program must be useful on a machine that has only Copilot (no OpenCode at all).

Own state: one JSON file (`state.json`) in the user data directory
(`%LOCALAPPDATA%\corral` on Windows, `$XDG_STATE_HOME/corral` or
`~/.local/state/corral` elsewhere; override: `CORRAL_STATE_DIR`). Write it
atomically (temporary file, then rename). Sessions stay in OpenCode; do not copy them.

## Code rules

- Small modules with explicit inputs. Side effects (process, file system, network, clock) come
  in through parameters, so tests can replace them.
- A key or mouse handler never blocks. Slow work is asynchronous, and the UI shows the old
  state until the result arrives.
- Comments say why, not what. Keep them short.
- Do not commit. The planner reviews and commits.
