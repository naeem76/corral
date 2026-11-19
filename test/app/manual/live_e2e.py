#!/usr/bin/env python3
"""Live end-to-end check of the real program against the real OpenCode service.

Opt-in: runs only with CORRAL_LIVE=1. Linux/macOS (uses the pty module for this driver only).

What it does, following the safety rules in AGENTS.md:
  1. Make a fresh scratch folder with an empty project folder and a state.json that lists it.
  2. Start `node src/main.ts` in a pseudo-terminal with CORRAL_STATE_DIR pointing there.
  3. Focus the Sessions column, press n (new session), wait for the OpenCode home screen in
     the pane. No prompt is sent to a model.
  4. Replay the captured output through src/term (replay.ts) and check that the three column
     titles and the OpenCode logo and prompt box are on screen together, in the right places.
  5. Leave the pane (Ctrl+Q), quit (q, Enter), check the terminal restore sequence.
  6. Check through the API that no corral PTY is left; delete the session that the
     test created; remove the scratch folder. The service is never stopped or restarted.

    CORRAL_LIVE=1 python3 test/app/manual/live_e2e.py
"""

import fcntl
import json
import os
import pty
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
NODE = shlex.split(os.environ.get("NODE_CMD", "fnm exec --using=26 node"))
COLS, ROWS = 170, 45
WIDTHS = (26, 30, 36)  # default column widths (src/tui/app/layout.ts)
RESTORE = (
    b"\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l"
    b"\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l"
)
LOGO0 = "█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█"

failures = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)
    return cond


def api(*args):
    r = subprocess.run(NODE + [os.path.join(ROOT, "test/app/manual/live_api.ts"), *args],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"live_api {args[0]} failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


def prompt_box(screen):
    """Rows of the OpenCode prompt box inside the pane: the ┃ bar rows and the ╹▀▀ bottom edge."""
    px = sum(WIDTHS)
    bottom = [i for i, l in enumerate(screen) if "╹▀▀▀" in l[px:]]
    if not bottom:
        return None
    b = bottom[-1]
    bars = [i for i in range(max(0, b - 6), b) if "┃" in screen[i][px:]]
    return (bars, b) if len(bars) >= 2 else None


def our_ptys(project):
    return [p for p in api("ptys", project) if p["title"].startswith("corral:")]


def pty_pid(p):
    # Title: corral:<pid>:<sessionId>; the pid is the node process of the program.
    return int(p["title"].split(":")[1])


def wait_ptys(project, n, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        found = our_ptys(project)
        if len(found) >= n:
            return found
        time.sleep(0.5)
    return our_ptys(project)


def open_selected_session(app):
    app.send(b"l")
    app.send(b"l")
    app.send(b"\r", settle=2.0)


def replay(raw, scratch):
    f = os.path.join(scratch, "out.bin")
    with open(f, "wb") as fh:
        fh.write(raw)
    r = subprocess.run(NODE + [os.path.join(ROOT, "test/app/manual/replay.ts"), f, str(COLS), str(ROWS)],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    return r.stdout.rstrip("\n").split("\n")


class App:
    def __init__(self, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(ROOT)
            os.execvpe(NODE[0], NODE + ["src/main.ts"], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.out = b""
        self.status = None

    def read_for(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 1 << 16)
                except OSError:
                    return
                if not data:
                    return
                self.out += data

    def send(self, data, settle=0.4):
        os.write(self.fd, data)
        self.read_for(settle)

    def wait_exit(self, seconds=10.0):
        end = time.time() + seconds
        while time.time() < end:
            self.read_for(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == self.pid:
                self.status = status
                return True
        return False

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main():
    if os.environ.get("CORRAL_LIVE") != "1":
        print("skipped: set CORRAL_LIVE=1 to run the live end-to-end check")
        return 0
    # A fixed name: OpenCode keeps a project record per directory and cannot delete one.
    scratch = os.path.join(tempfile.gettempdir(), "corral-live-e2e")
    shutil.rmtree(scratch, ignore_errors=True)
    try:
        os.mkdir(scratch, 0o700)
    except OSError:
        scratch = tempfile.mkdtemp(prefix="corral-live-e2e-")
    scratch = os.path.realpath(scratch)
    project = os.path.join(scratch, "live-project")
    state_dir = os.path.join(scratch, "state")
    os.makedirs(project)
    os.makedirs(state_dir)
    with open(os.path.join(state_dir, "state.json"), "w") as fh:
        json.dump({
            "version": 1,
            "projects": [{"id": "live1", "path": project, "name": "live-project", "kind": "dir"}],
            "ui": {"view": "projects", "selectedProjectId": "live1", "selectedCheckoutPath": None, "selectedSessionId": None},
            "sessions": {},
        }, fh)
    print(f"scratch: {scratch}")
    print(f"service version: {api('version')}")
    before = set(api("sessions", project))
    check(len(before) == 0, "the scratch folder has no sessions before the test")

    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
               CORRAL_STATE_DIR=state_dir, CORRAL_LOG=os.path.join(scratch, "app.log"))
    app = App(env)
    screen = []
    created = set()
    try:
        app.read_for(3.0)
        check(b"Projects" in app.out, "the program draws")
        app.send(b"l")
        app.send(b"l")
        app.send(b"n", settle=1.0)
        # Wait for the OpenCode home screen inside the pane.
        deadline = time.time() + 60
        while time.time() < deadline:
            app.read_for(1.0)
            screen = replay(app.out, scratch)
            if prompt_box(screen):
                break
        created = set(api("sessions", project)) - before
        check(len(created) == 1, f"one session was created ({sorted(created)})")
        app.read_for(1.5)  # let the TUI finish its first frames
        screen = replay(app.out, scratch)
        print("\n----- screen with the pane focused -----")
        print("\n".join(screen))
        print("----------------------------------------\n")

        top = screen[0]
        pane_x = sum(WIDTHS)
        check(top.find("Projects") == 3, "Projects title in the first column")
        check(top.find("Git") == WIDTHS[0] + 3, "Git title in the second column")
        check(top.find("Sessions") == WIDTHS[0] + WIDTHS[1] + 3, "Sessions title in the third column")
        # `opencode --session <id>` shows the session view: a header and the prompt box. The
        # home screen logo appears only without --session; report it when present.
        box = prompt_box(screen)
        check(box is not None, "the OpenCode prompt box is in the pane")
        if box:
            bars, b = box
            x = screen[b].find("╹")
            check(x > pane_x + 1 and screen[b].rstrip().endswith("│"), f"the prompt box is inside the pane horizontally (x={x})")
            check(0 < bars[0] and b < ROWS - 2, f"the prompt box is inside the pane vertically (rows {bars[0]}..{b})")
            check(any("Build ·" in screen[i] for i in bars), "the prompt box shows the agent line (Build · model)")
        header = [i for i, l in enumerate(screen) if i > 0 and "New session" in l[pane_x:]]
        check(len(header) >= 1 and 0 < header[0] < 4, "the OpenCode session header is at the top of the pane")
        print("     (OpenCode logo on screen: %s)" % any(LOGO0 in l for l in screen))
        check(all(l[:pane_x].count("│") >= 4 for l in screen[1:ROWS - 2]), "the three columns stay drawn beside the pane")
        check("live-project" in screen[1], "the project row is shown")
        check("Ctrl+q leave pane" in screen[-1], "footer shows the leave chord")

        app.send(b"\x11", settle=1.0)  # Ctrl+Q leaves the pane
        screen2 = replay(app.out, scratch)
        check("Enter open" in screen2[-1], "Ctrl+Q returns to the columns (footer)")
        check(prompt_box(screen2) is not None, "the pane stays visible after leaving it")

        mark = len(app.out)
        app.send(b"q", settle=0.5)
        app.send(b"\r", settle=0.1)
        check(app.wait_exit(15), "q + Enter quits")
        tail = app.out[mark:]
        check(tail.endswith(RESTORE), "the output ends with the terminal restore sequence")
        if app.status is not None:
            check(os.WIFEXITED(app.status) and os.WEXITSTATUS(app.status) == 0, "exit code 0")
        check(len(our_ptys(project)) == 0, "quit deleted the PTY")

        # SIGTERM to the node process: the exit path restores the terminal and deletes the PTY.
        print("\n== SIGTERM while a pane is open")
        app = App(env)
        app.read_for(3.0)
        open_selected_session(app)
        ptys = wait_ptys(project, 1)
        check(len(ptys) == 1, "the restored selection opens one PTY")
        if ptys:
            mark = len(app.out)
            os.kill(pty_pid(ptys[0]), signal.SIGTERM)
            check(app.wait_exit(15), "SIGTERM ends the program")
            check(app.out[mark:].find(RESTORE) >= 0, "the terminal is restored after SIGTERM")
            check(len(our_ptys(project)) == 0, "the PTY was deleted on the SIGTERM path")

        # SIGKILL leaves the PTY behind; the next start deletes it (dead pid).
        print("\n== SIGKILL, then a new start cleans up")
        app = App(env)
        app.read_for(3.0)
        open_selected_session(app)
        ptys = wait_ptys(project, 1)
        if check(len(ptys) == 1, "a PTY is open before the kill"):
            os.kill(pty_pid(ptys[0]), signal.SIGKILL)
            app.wait_exit(10)
            check(len(our_ptys(project)) == 1, "after SIGKILL the PTY is left in the service")
            app = App(env)
            deadline = time.time() + 15
            while time.time() < deadline and our_ptys(project):
                app.read_for(0.5)
            check(len(our_ptys(project)) == 0, "the next start deleted the stale PTY")
            app.send(b"q", settle=0.5)
            app.send(b"\r", settle=0.1)
            check(app.wait_exit(15), "quit after the cleanup")
    finally:
        app.kill()
        # Clean up everything this test created, and only that.
        try:
            left = [p for p in api("ptys", project) if p["title"].startswith("corral:")]
            check(len(left) == 0, f"no corral PTY left in the service ({left})")
            for p in left:
                api("delete-pty", project, p["id"])
        except Exception as err:  # noqa: BLE001
            check(False, f"PTY check: {err}")
        try:
            created = set(api("sessions", project)) - before
            for sid in sorted(created):
                api("delete-session", sid)
            check(len(set(api("sessions", project)) - before) == 0, f"deleted the test session(s) {sorted(created)}")
        except Exception as err:  # noqa: BLE001
            check(False, f"session cleanup: {err}")
        log = os.path.join(scratch, "app.log")
        if os.path.exists(log):
            with open(log) as fh:
                text = fh.read()
            print("----- app log -----\n" + text[-3000:] + "-------------------")
        shutil.rmtree(scratch, ignore_errors=True)
        check(not os.path.exists(scratch), "removed the scratch folder")
    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
