#!/usr/bin/env python3
"""Drive `doctor --keys` in a real pseudo-terminal: answer each prompt with the bytes a terminal
sends (arrow, Ctrl+], Tab, SGR mouse click, wheel, bracketed paste, a window resize), then check
the report and that the terminal was restored.

Not part of the default test run. Linux/macOS only (uses the pty module). No OpenCode needed.

    python3 test/manual/doctor_keys_check.py            # uses: fnm exec --using=26 node
    NODE_CMD="node" python3 test/manual/doctor_keys_check.py
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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
NODE = shlex.split(os.environ.get("NODE_CMD", "fnm exec --using=26 node"))
PASTE = b"do-not-print-this-paste"

STEPS = [
    (b"Press an arrow key", b"\x1b[A"),
    (b"Press Ctrl+]", b"\x1d"),
    (b"Press Tab", b"\t"),
    (b"Click with the left", b"\x1b[<0;12;4M\x1b[<0;12;4m"),
    (b"Scroll the mouse wheel", b"\x1b[<65;12;4M"),
    (b"Paste any text", b"\x1b[200~" + PASTE + b"\x1b[201~"),
    (b"Change the size", None),
]

failures = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        env = dict(os.environ, TERM="xterm-256color")
        os.execvpe(NODE[0], NODE + ["src/main.ts", "doctor", "--keys", "--only", "terminal"], env)
    set_size(fd, 30, 100)
    out = b""
    step = 0
    sent_at = 0
    deadline = time.time() + 60
    status = None
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            out += data
        if step < len(STEPS) and STEPS[step][0] in out[sent_at:]:
            time.sleep(0.15)
            payload = STEPS[step][1]
            if payload is None:
                set_size(fd, 33, 111)
                os.kill(pid, signal.SIGWINCH)
            else:
                os.write(fd, payload)
            sent_at = out.index(STEPS[step][0], sent_at) + 1
            step += 1
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            # Read what is left.
            while True:
                r, _, _ = select.select([fd], [], [], 0.2)
                if not r:
                    break
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                out += data
            break
    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    text = out.decode("utf8", "replace")
    report = text[text.rfind("corral doctor ") :] if "Summary:" in text else text
    print(report)
    check(step == len(STEPS), "every prompt appeared and was answered")
    check("Keys: Arrow key" in report and "key up (ESC [ A)" in report, "arrow key decoded")
    check("key Ctrl+] (^])" in report, "Ctrl+] decoded")
    check("key tab (^I)" in report, "Tab decoded")
    check("mouse left down at 11,3 (ESC [ < 0 ; 12 ; 4 M)" in report, "mouse click decoded")
    check("mouse none wheel-down" in report, "wheel decoded")
    check("paste of %d chars" % len(PASTE) in report, "paste length reported")
    check(PASTE.decode() not in report, "pasted text never printed in the report")
    check("resize event: 100x30 -> 111x33" in report, "resize reported")
    check(b"\x1b[?1049l" in out and out.rfind(b"\x1b[?1049l") > out.rfind(b"\x1b[?1049h"), "alternate screen left")
    check(out.rfind(b"\x1b[?1000l") > out.rfind(b"\x1b[?1000h"), "mouse reporting switched off")
    check(out.rfind(b"\x1b[?2004l") > out.rfind(b"\x1b[?2004h"), "bracketed paste switched off")
    check(status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, "exit code 0")
    if failures:
        print("\n%d check(s) failed" % len(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
