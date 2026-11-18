#!/usr/bin/env python3
"""Drive src/tui/demo.ts in a real pseudo-terminal and check that it draws, reacts to keys and
mouse, and restores the terminal when it quits.

Not part of the default test run. Linux/macOS only (uses the pty module).

    python3 test/tui/manual/demo_pty_check.py            # uses: fnm exec --using=26 node
    NODE_CMD="node" python3 test/tui/manual/demo_pty_check.py
"""

import fcntl
import os
import pty
import select
import shlex
import signal
import struct
import sys
import termios
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
NODE = shlex.split(os.environ.get("NODE_CMD", "fnm exec --using=26 node"))
RESTORE = (
    b"\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l"
    b"\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l"
)

failures = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Session:
    def __init__(self, rows=30, cols=110):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(ROOT)
            env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
            os.execvpe(NODE[0], NODE + ["src/tui/demo.ts"], env)
        set_size(self.fd, rows, cols)
        self.out = b""
        self.status = None

    def read_for(self, seconds):
        end = time.time() + seconds
        got = b""
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                got += data
        self.out += got
        return got

    def wait_for(self, needle, seconds=8.0):
        end = time.time() + seconds
        start = len(self.out)
        while time.time() < end:
            self.read_for(0.1)
            if needle in self.out[start:]:
                return True
        return False

    def send(self, data, settle=0.3):
        os.write(self.fd, data)
        return self.read_for(settle)

    def wait_exit(self, seconds=5.0):
        end = time.time() + seconds
        while time.time() < end:
            self.read_for(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == self.pid:
                self.status = status
                self.read_for(0.2)
                return True
        return False

    def tty_modes(self):
        # On Linux tcgetattr on the master returns the slave's settings.
        attrs = termios.tcgetattr(self.fd)
        return attrs[3]

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_main():
    print("== keyboard, mouse, modals, resize, quit with q")
    s = Session()
    try:
        check(s.wait_for(b"Projects"), "draws the Projects column")
        check(b"\x1b[?1049h" in s.out and b"\x1b[?1006h" in s.out and b"\x1b[?2004h" in s.out, "enters alt screen, SGR mouse, bracketed paste")
        lflags = s.tty_modes()
        check(not (lflags & termios.ICANON) and not (lflags & termios.ECHO), "raw mode while running")
        check(b"\x1b[?2026h" in s.out, "frames use synchronized update")

        got = s.send(b"j")
        check(b"key j" in got, "key j shows in the readout")
        got = s.send(b"\t")
        check(b"Git" in got or b"focus" in got, "Tab moves focus (output changed)")
        got = s.send(b"\x1b[B")
        # The readout is diffed: only the changed part "down" is written.
        check(b"down  raw=" in got, "arrow key decoded")
        got = s.send(b"\x1b[<0;50;6M\x1b[<0;50;6m")
        check(b"mouse up left @49,5" in got, "SGR mouse click decoded with 0-based coordinates")
        got = s.send(b"\x1b[<65;50;6M")
        check(b"wheel-down" in got, "mouse wheel decoded")

        got = s.send(b"n")
        check(b"New item in" in got, "n opens the text input modal")
        s.send("wé宽".encode())
        got = s.send(b"\r")
        check("wé宽".encode() in s.out, "typed text with wide characters appears")

        got = s.send(b"d")
        check(b"Delete from" in got, "d opens the confirm modal")
        got = s.send(b"\x1b", settle=0.5)
        check(b"Delete from" not in got and len(got) > 0, "Esc (lone, after the timeout) closes the modal")

        got = s.send(b"\x1b[200~pasted text\x1b[201~")
        check(b"paste 11 chars" in got, "bracketed paste is one event")

        set_size(s.fd, 20, 90)
        os.kill(s.pid, signal.SIGWINCH)
        got = s.read_for(0.5)
        check(b"\x1b[2J" in got and b"size 90" in got, "resize gives a full repaint at the new size")

        before = len(s.out)
        s.send(b"q", settle=0.1)
        check(s.wait_exit(), "q quits")
        tail = s.out[before:]
        check(tail.endswith(RESTORE), "output ends with the restore sequence")
        check(os.WIFEXITED(s.status) and os.WEXITSTATUS(s.status) == 0, "exit code 0")
        lflags = s.tty_modes()
        check(bool(lflags & termios.ICANON) and bool(lflags & termios.ECHO), "cooked mode restored (ICANON, ECHO)")
    finally:
        s.kill()


def run_ctrl_c():
    print("== Ctrl+C quits and restores")
    s = Session()
    try:
        check(s.wait_for(b"Projects"), "draws")
        before = len(s.out)
        s.send(b"\x03", settle=0.1)
        check(s.wait_exit(), "Ctrl+C quits")
        check(s.out[before:].endswith(RESTORE), "restore sequence after Ctrl+C")
    finally:
        s.kill()


def run_sigterm():
    print("== SIGTERM restores")
    s = Session()
    try:
        check(s.wait_for(b"Projects"), "draws")
        before = len(s.out)
        os.kill(s.pid, signal.SIGTERM)
        check(s.wait_exit(), "SIGTERM ends the process")
        check(s.out[before:].endswith(RESTORE), "restore sequence after SIGTERM")
        code = os.WEXITSTATUS(s.status) if os.WIFEXITED(s.status) else -os.WTERMSIG(s.status)
        print(f"     (exit status {code}; 143 from node, a wrapper such as fnm may report its own)")
    finally:
        s.kill()


if __name__ == "__main__":
    run_main()
    run_ctrl_c()
    run_sigterm()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        sys.exit(1)
    print("all checks passed")
