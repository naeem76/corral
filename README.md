# nebula-enterprise

nebula-enterprise is a terminal program that manages OpenCode sessions. It shows a Projects
column, a Git column (the main checkout, worktrees, pull requests, and folders without Git), a
Sessions column, and a pane that runs the OpenCode TUI.

It is a client of the OpenCode V2 background service. It keeps its sessions in OpenCode and
stores only its own list of projects and view state. It runs on Windows 11 (Windows Terminal,
PowerShell, without `cmd.exe`) and on Linux.

## Requirements

- Node.js 26. Node 26 runs the `.ts` files directly. There is no build step.
- OpenCode 2.x with its background service (`opencode service start`).
- Git, for the Git column. Without Git, every project is a plain folder.
- Optional: the Azure CLI (`az`) with the `azure-devops` extension, for pull requests.

There is nothing to install. The program uses no npm packages, so `npm install` is not necessary.

## Run

```
node src/main.ts            # start the TUI
node src/main.ts doctor     # check this machine and print a report
node src/main.ts --help
```

`doctor` takes `--json`, `--full-paths`, `--keys` (interactive input check),
`--opencode-pty` (starts the real OpenCode TUI for a few seconds) and `--only <groups>`.
Its output contains no password or token, so you can paste it into a chat.
For the first run on Windows, read [docs/windows.md](docs/windows.md).

## State

The program keeps one file, `state.json`, in:

- Windows: `%LOCALAPPDATA%\nebula-enterprise`
- Other systems: `$XDG_STATE_HOME/nebula-enterprise`, else `~/.local/state/nebula-enterprise`

It writes the file atomically (a temporary file, then a rename).

## Environment variables

| Name | Use |
| --- | --- |
| `NEBULA_OPENCODE_URL` | URL of the OpenCode service. Skips the `service.json` lookup. |
| `NEBULA_OPENCODE_PASSWORD` | Password for `NEBULA_OPENCODE_URL`. |
| `NEBULA_OPENCODE_SERVICE_FILE` | Path of the OpenCode `service.json` file. |
| `NEBULA_STATE_DIR` | Folder for `state.json`. |
| `NEBULA_LOG` | Path of a debug log file. Secrets are removed from each line. |
| `NEBULA_LIVE` | Set to `1` to run the live tests against the real OpenCode service. |

## Keys

Placeholder. The in-app `?` overlay is the source of truth for the key bindings.

## Tests

```
node --test "test/**/*.test.ts"
```

The default run needs no OpenCode service. Live tests run only with `NEBULA_LIVE=1`. They work
in new scratch folders and delete what they create. Scripts under `test/manual/` and
`test/tui/manual/` drive the program in a pseudo-terminal; they are not part of the default run.

The type check (`npx tsc --noEmit -p .`) needs `typescript` and `@types/node` installed with
`npm i --no-save`. The program itself does not need them.

## Layout

```
src/main.ts      entry: the TUI, or the `doctor` command
src/doctor.ts    the `doctor` command
src/types.ts     shared contracts
src/width.ts     display width of text
src/core/        OpenCode client, events, PTY, state store, Git, sessions, pull requests
src/term/        terminal emulator for the pane (VT parser and screen grid)
src/tui/         input decoder, renderer, widgets, the application
test/            tests; the folders follow src/
docs/            OpenCode API document, Windows notes
bin/ne.ps1       optional PowerShell launcher
```
