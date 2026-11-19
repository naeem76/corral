# nebula-enterprise

nebula-enterprise is a terminal program that manages OpenCode and GitHub Copilot CLI sessions.
It shows a Projects column, a Git column (the main checkout, worktrees, pull requests, and
folders without Git), a Sessions column, and a pane that runs the OpenCode TUI or Copilot.

It is a client of the OpenCode V2 background service, and it reads the session files of the
Copilot CLI. It keeps the sessions in the agents and stores only its own list of projects,
view state and session marks. It runs on Windows 11 (Windows Terminal,
PowerShell, without `cmd.exe`) and on Linux.

## Requirements

- Node.js 26. Node 26 runs the `.ts` files directly. There is no build step.
- At least one agent: OpenCode 2.x with its background service (`opencode service start`),
  or the GitHub Copilot CLI (`copilot`). See [Agents](#agents).
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
`--opencode-pty` (starts the real OpenCode TUI for a few seconds), `--copilot` (the structure
of the 3 newest Copilot sessions, without their content) and `--only <groups>`.
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
| `NEBULA_COPILOT_HOME` | Copilot home folder for this program (holds `session-state`). Default: `COPILOT_HOME`, else `~/.copilot`. |
| `NEBULA_COPILOT_BIN` | Path of the Copilot program (on Windows a `.exe`). Default: found on PATH. |
| `COPILOT_HOME` | Copilot's own home folder variable; read when `NEBULA_COPILOT_HOME` is not set. |
| `NEBULA_LIVE` | Set to `1` to run the live tests against the real OpenCode service. |

## Keys

The in-app `?` overlay is the source of truth for the key bindings. `v` switches between the
projects view and the inbox view; the program starts in the view that was shown last.

## Agents

The program lists, starts and resumes sessions of two agents: OpenCode and the GitHub Copilot
CLI. Both appear in the Sessions column and in the inbox, in one order.

- **Tag.** When both agents are in use on the machine, each row has a short dim tag: `oc`
  (OpenCode) or `cp` (Copilot). A machine with one agent shows no tags. The information panel
  always names the agent.
- **New session (`n`).** In the Sessions column, with both agents available, a small menu asks:
  `1 OpenCode`, `2 Copilot`. The default is first; `Enter` takes it. The choice becomes the
  new default (`ui.defaultAgent` in `state.json`). With one agent there is no menu. In the
  inbox, `n` uses the agent of the selected session.
- **What works for Copilot:** list, status (needs input, working, finished and not seen),
  start, resume, archive, snooze and settle. The archive of a Copilot session is a mark of
  this program (Copilot has no archive).
- **What does not:** rename (use `/rename` in Copilot) and delete (use `/session delete` in
  Copilot). The program never writes Copilot's files.
- **Pane.** The pane needs a pseudo-terminal from the OpenCode service. With the service, a
  Copilot session runs in the pane like an OpenCode session. Without it, a Copilot session
  opens in the full window, and the program comes back when Copilot exits.
- **Copilot only.** A machine without OpenCode works: the footer shows `Copilot only`, and
  there is no service error.
- A Copilot program in the pane runs in the pane's terminal: closing the pane or quitting this
  program stops it (an OpenCode session keeps running in the service). Resume it with Enter.

Copilot sessions come from `<Copilot home>/session-state/<id>/`: the title and folder from
`workspace.yaml`, the status from the end of `events.jsonl`. The program checks the files of
the sessions in your project folders every 2 seconds and looks for new sessions every 5
seconds. A Copilot session that shows "working" or "needs input" without a change for 30
minutes (4 hours while a tool runs or a question waits) counts as stopped: a closed terminal
leaves no end mark. Turns that ended before the first start of this version count as seen.

## Inbox view

The inbox view shows one list of the sessions of all projects (the root folders and their
worktrees), with the pane at the right. Archived sessions and child sessions are not in it.
The list has five sections, in this order:

| Section | A session is here when |
| --- | --- |
| Needs input | a permission request or a form waits for you (always first; it ends a snooze) |
| Working | a turn is in progress, and the session is not snoozed |
| Open | every other session; sessions that came back from a snooze (`back`) or have an unseen turn come first |
| Snoozed | its snooze time is not reached yet |
| Settled | you settled it, and it had no activity since (collapsed; `E` shows it) |

Snooze and settle are this program's own marks, kept in `state.json`. They do not change the
session in OpenCode, and OpenCode's archive is a different thing.

- **Snooze** hides a session until a time. The menu offers the snooze choices soonest first,
  each with its local time: by default in 1 hour, in 3 hours, this evening (today 18:00),
  tomorrow 09:00 and next week (Monday 09:00; on a Monday, the Monday of next week). A choice
  whose time has passed (today 18:00 in the evening) is not offered. `c` asks for a custom time.
  The snooze ends early, at once and for good, when the session needs input or when a turn
  fails after you snoozed it. A turn that ends normally, or one that you interrupt, does not end
  it. When the time passes, the session returns to Open with a `back` tag; opening the session
  removes the tag.
- **Settle** means "done for now". It is not possible while the session works or needs input.
  A settled session returns to Open (or Working) by itself when it has new activity.
- A snooze deletes a settle mark, and a settle deletes a snooze.

| Key | Action |
| --- | --- |
| `v` | Switch to the projects view (the selected session goes along) |
| `j`/`k`, arrows, `PgUp`/`PgDn`, `Home`/`End`, `Ctrl+d`/`Ctrl+u`, wheel | Move or scroll; headers are skipped |
| click, double click | A click selects; a double click opens like `Enter` |
| `Enter` | Open the session in the pane and focus the pane |
| `l`, `→`, `Tab` | Focus the pane when the session is open |
| `s` | Snooze menu: `1`…`8` a choice (or `j`/`k` and `Enter`), `c` custom time, `u` remove the snooze, `Esc` cancel |
| `e` | Settle, or unsettle a settled session |
| `u` | Back to Open: remove the snooze or the settle mark |
| `E` | Show or hide the Settled section |
| `n` | New session in the folder of the selected session |
| `r`, `a`, `d` | Rename, archive, delete (as in the Sessions column; delete also drops the marks) |
| `g` | Show the session in the projects view |
| `]`, `[` | Next / previous session that wants attention (needs input, then unseen or back) |
| `O`, `z`, `R`, `?`, `q` | Full window, zoom, refresh, help, quit (as in the projects view) |
| `Ctrl+q` | In the pane: back to the list |

In the projects view, `s` and `e` in the Sessions column set the same marks. A row with an active
snooze shows `zz`, a settled row shows `✓`.

A custom time is one of these forms, in local time:

| Form | Meaning |
| --- | --- |
| `17:30` | today at that time, or tomorrow when the time has passed |
| `2026-12-01 09:00` | that day at that time |
| `2026-12-01` | that day at 09:00 |
| `30m`, `2h`, `3d`, `1w` | that much time from now (`90 m` and `2H` also work) |

The snooze choices are `ui.snoozePresets` in `state.json`: a list of 1 to 8 items. `after` is a
number of minutes from now (1 to 525600). `at` is a time `HH:MM` on a `day`: `today`,
`tomorrow`, or a weekday (`monday` … `sunday`, the next such day after today). When one item
is not valid, the program uses the defaults and writes one line to the log.

```json
"ui": {
  "snoozePresets": [
    { "kind": "after", "minutes": 30 },
    { "kind": "after", "minutes": 120 },
    { "kind": "at", "day": "today", "time": "17:00" },
    { "kind": "at", "day": "tomorrow", "time": "08:30" },
    { "kind": "at", "day": "friday", "time": "09:00" }
  ]
}
```

The width of the inbox list is `ui.inboxWidth` in `state.json` (default 56, minimum 30).

## Tests

```
node --test "test/**/*.test.ts"
```

The default run needs no OpenCode service and no Copilot. Live tests run only with `NEBULA_LIVE=1`. They work
in new scratch folders and delete what they create. Scripts under `test/manual/` and
`test/tui/manual/` drive the program in a pseudo-terminal; they are not part of the default run.
`test/copilot/manual/check.ts` runs the real Copilot CLI offline against a fake local model
and checks that the program reads its session (see the comment at the top of the file).

The type check (`npx tsc --noEmit -p .`) needs `typescript` and `@types/node` installed with
`npm i --no-save`. The program itself does not need them.

## Layout

```
src/main.ts      entry: the TUI, or the `doctor` command
src/doctor.ts    the `doctor` command
src/types.ts     shared contracts
src/width.ts     display width of text
src/core/        OpenCode client, events, PTY, state store, Git, sessions (OpenCode, Copilot,
                 the hub that joins them), pull requests
src/term/        terminal emulator for the pane (VT parser and screen grid)
src/tui/         input decoder, renderer, widgets, the application
test/            tests; the folders follow src/
docs/            OpenCode API document, Windows notes
bin/ne.ps1       optional PowerShell launcher
```
