#!/usr/bin/env python3
"""PTY driver for the real Copilot CLI (called by check.ts; not a test on its own).

    drive.py <node> <copilot-loader.js> <copilot-home> <project> <model-port> <session-id> <out-dir>

Runs `copilot --session-id <id>` offline against the fake model, in a pseudo-terminal, and
types: Enter (trust the folder), a prompt that makes the fake model call a shell tool, Enter.
Then it waits while the permission question is open, presses Esc (abort) and ends the program.
It writes `phase` lines to <out-dir>/phases.txt so check.ts knows what to expect.

GH_TOKEN and GITHUB_TOKEN are removed; COPILOT_HOME is the scratch home, never ~/.copilot.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

node, loader, home, proj, port, sid, out = sys.argv[1:8]
env = dict(os.environ)
for k in ("GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"):
    env.pop(k, None)
env.update(
    COPILOT_HOME=home,
    COPILOT_OFFLINE="true",
    COPILOT_AUTO_UPDATE="false",
    COPILOT_PROVIDER_BASE_URL=f"http://127.0.0.1:{port}/v1",
    COPILOT_PROVIDER_API_KEY="x",
    COPILOT_MODEL="fake-model",
    TERM="xterm-256color",
)
assert os.path.abspath(home) != os.path.abspath(os.path.expanduser("~/.copilot")), "never the real home"

pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.execve(node, [node, loader, "--disable-client-telemetry", "--no-auto-update", "--session-id", sid], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
raw = b""


def phase(name):
    with open(os.path.join(out, "phases.txt"), "a") as f:
        f.write(f"{time.time():.3f} {name}\n")


def pump(sec):
    global raw
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                raw += os.read(fd, 65536)
            except OSError:
                return


phase("started")
pump(8)
os.write(fd, b"\r")  # trust the folder
phase("trusted")
pump(2)
os.write(fd, b"please run the command")
pump(1)
os.write(fd, b"\r")
phase("prompted")
pump(10)  # the permission question waits here
phase("abort")
os.write(fd, b"\x1b")
pump(3)
phase("exit")
os.kill(pid, signal.SIGTERM)
pump(3)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
with open(os.path.join(out, "tui.raw"), "wb") as f:
    f.write(raw)
phase("done")
