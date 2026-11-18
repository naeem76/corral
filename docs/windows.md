# Windows: first run

This page is for the Windows work machine (Windows 11, Windows Terminal, PowerShell,
`cmd.exe` disabled). Do the steps in this order. Send back the full output of each step.

## 1. Check the machine

Open Windows Terminal with PowerShell. Go to the program folder and run:

```
node src\main.ts doctor
```

The output contains no password and no token. Your home folder shows as `~`.
Copy all of it and send it back. The last line says "Send this whole output back."

`doctor` prints one line for each check: `PASS`, `WARN`, `FAIL` or `SKIP`.
A line that is not `PASS` has a second line that starts with `->`. It tells you what to do.

The important results:

| Check | If it is not PASS |
| --- | --- |
| Node.js version | Install Node.js 26. |
| opencode on PATH | `WARN ... script shim`: PowerShell finds only `opencode.cmd` or `opencode.ps1`. These need `cmd.exe`, so the program cannot start them. Put the folder of the real `opencode.exe` on PATH. |
| service.json location | The OpenCode service does not run, or its file is in an unknown place. Run `opencode service start`. The output lists every place that `doctor` looked at. |
| Service version vs CLI version | `WARN`: the service and the `opencode` program have different versions. The OpenCode TUI then restarts the service. Update OpenCode so that both are the same. |
| OpenAPI operations | `FAIL`: this OpenCode version does not have an API part that the program needs. Send the output. |
| PTY steps | These steps check the embedded pane. A `FAIL` here is the most important result to send. |
| Directory path forms | Not an error. It shows which forms of a folder path OpenCode accepts. |
| git --version | `WARN` below 2.31: update Git for Windows. |
| az on PATH | Optional. On Windows `az` is `az.cmd`. The program then starts the Python that comes with the Azure CLI directly. A `WARN` means pull requests stay off. |

`doctor` creates a temporary folder, a test session and a test PTY. It deletes them at the end.

## 2. Check keys, mouse and paste

```
node src\main.ts doctor --keys --only terminal
```

The program asks you to press an arrow key, Ctrl+], Tab, to click, to scroll, to paste some
text, and to change the window size. Each step waits 10 seconds. Press `s` to skip a step.
Press Ctrl+C to stop. The report shows only the length of the pasted text, not the text.
Send the output back.

## 3. Check the OpenCode TUI in the pane

```
node src\main.ts doctor --opencode-pty --only service,pty
```

This starts the real OpenCode TUI in a hidden terminal for a few seconds. It sends no keys and
no prompt. It runs only when the service and the CLI have the same version. Send the output back.

## A short command: `ne`

You do not need `cmd.exe` for this.

Option A: a function in your PowerShell profile. Open the profile with `notepad $PROFILE`
(create the file if it does not exist) and add this line, with your own path:

```
function ne { node "C:\path\to\nebula-enterprise\src\main.ts" @args }
```

Open a new PowerShell window. Then `ne` starts the program and `ne doctor` runs the checks.

Option B: the launcher `bin\ne.ps1`. It finds `src\main.ts` from its own folder and passes all
arguments through. Put the `bin` folder on PATH, or call it with its full path.

The execution policy can block `$PROFILE` and every `.ps1` file. Then the full command always
works:

```
node C:\path\to\nebula-enterprise\src\main.ts
```

## Files

- The program state is in `%LOCALAPPDATA%\nebula-enterprise\state.json`.
- If the OpenCode service file is in an unusual place, set `NEBULA_OPENCODE_SERVICE_FILE` to its path.
