"""Drive an isolated benchmark terminal without fixed post-completion sleeps."""

from contextlib import contextmanager
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import termios
import time

ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")

def deadline_ns(seconds):
    local = time.monotonic_ns() + int(seconds * 1e9)
    outer = os.environ.get("OMC_BENCH_DEADLINE_NS")
    return min(local, int(outer)) if outer is not None else local


def remaining(deadline):
    return max(0, (deadline - time.monotonic_ns()) / 1e9)


@contextmanager
def unwind_on_term():
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    old = signal.signal(signal.SIGTERM, interrupt)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, old)


def completed_main_messages(root, cache=None):
    messages = []
    if cache is None:
        cache = {}
    for trace in (root / "interactive" / "trace").glob("*/payloads"):
        payloads = []
        for path in trace.glob("*.json"):
            if path not in cache:
                try:
                    cache[path] = json.loads(path.read_text())
                except (OSError, ValueError):
                    continue  # Retry a payload that is still being written.
            payloads.append(cache[path])
        if any(p.get("tools") and "input" in p and "stream" in p for p in payloads):
            messages.extend(p.get("last_agent_message") or {"task_complete": p.get("status")}
                            for p in payloads if p.get("type") == "task_complete")
    return messages


@unwind_on_term()
def drive(argv, env, root, deadline, *, canary=None):
    pid, fd = pty.fork()
    if not pid:
        try:
            os.execve(argv[0], argv, env)
        finally:
            os._exit(127)

    transcript = bytearray()
    trace_cache = {}
    started = sent_exit = entered_outcome = saw_canary = False
    completed_at = native_exit = None
    eof = False
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 132, 0, 0))
        while remaining(deadline):
            if select.select([] if eof else [fd], [], [], min(0.05, remaining(deadline)))[0]:
                try:
                    chunk = os.read(fd, 65_536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                eof = not chunk
                transcript.extend(chunk)
                cleaned = ANSI.sub(b"", transcript)
                if not started and b"Type start" in cleaned:
                    os.write(fd, b"start\n")
                    started = True
                if canary and canary.encode() in cleaned:
                    saw_canary = True
                if b"Session outcome" in cleaned and not entered_outcome:
                    candidate = saw_canary if canary is not None else completed_at is not None
                    os.write(fd, b"candidate\n" if candidate else b"blocked\n")
                    entered_outcome = True
            if completed_at is None and completed_main_messages(root, trace_cache) and remaining(deadline):
                completed_at = time.monotonic_ns()
            # The gateway meters the terminal response before forwarding it to Codex.
            if completed_at is not None and not (sent_exit or eof) and remaining(deadline):
                os.write(fd, b"\x04")
                sent_exit = True
            child, status = os.waitpid(pid, os.WNOHANG)
            if child:
                native_exit = os.waitstatus_to_exitcode(status)
                break
    except KeyboardInterrupt:
        if remaining(deadline):
            raise
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        # forkpty owns a separate session and therefore escapes the outer process group.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            if native_exit is None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            os.close(fd)
            if native_exit is None:
                _, status = os.waitpid(pid, 0)
                if remaining(deadline):
                    native_exit = os.waitstatus_to_exitcode(status)
            (root / "terminal.log").write_bytes(transcript)
    timed_out = native_exit is None
    return {
        "native_exit": 124 if timed_out else native_exit,
        "started": started,
        "saw_canary": saw_canary,
        "main_completed_at_ns": completed_at,
        "timed_out": timed_out,
    }
