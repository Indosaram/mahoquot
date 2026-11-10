#!/usr/bin/env python3
"""Real Unix PTY observer. No execution on import; stdout is one JSON observation.

Invoke with an absolute gateway binary followed by its tui arguments. The caller
must own this helper's process tree and both output pipes, including on timeout.
The observer and TUI stay in the existing supervisor keeper's process group.
Only that live/unreaped keeper authorizes group termination; this helper never
signals a remembered PID. Abrupt observer death fails observation, while the
outer supervisor still owns and terminates the entire group on stdin EOF.
"""
import errno
import json
import os
import pty
import selectors
import signal
import sys
import termios
import time


def observe(argv, timeout=15):
    selector = selectors.DefaultSelector()
    master, slave = pty.openpty()
    wake_read, wake_write = os.pipe()
    os.set_blocking(wake_read, False)
    os.set_blocking(wake_write, False)
    original = termios.tcgetattr(slave)
    old_handler = signal.signal(signal.SIGCHLD, lambda *_: None)
    def terminate(*_):
        raise InterruptedError("PTY owner requested shutdown")
    old_term = signal.signal(signal.SIGTERM, terminate)
    old_wakeup = signal.set_wakeup_fd(wake_write)
    selector.register(master, selectors.EVENT_READ, "output")
    selector.register(wake_read, selectors.EVENT_READ, "exit")
    pid = None
    status = None
    output = bytearray()
    screens = []
    raw_entered = False
    restored = False
    failure = None

    def wait_events(end, navigate):
        nonlocal status, raw_entered
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("PTY completion deadline")
        ready = selector.select(remaining)
        if not ready:
            raise TimeoutError("PTY completion deadline")
        for key, _ in ready:
            if key.data == "exit":
                os.read(wake_read, 65536)
            else:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    selector.unregister(master)
                else:
                    output.extend(chunk)
                    if len(output) > 4 * 1024 * 1024:
                        raise RuntimeError("PTY output limit exceeded")
                    if navigate:
                        target = ["DASHBOARD", "CONFIGURATION", "ACCOUNTS LIST"]
                        if len(screens) < len(target):
                            screen = target[len(screens)]
                            # Each input follows an actual completed render marker;
                            # output is subscribed before exec, never timing-drained.
                            if ("SCREEN: " + screen).encode() in output:
                                attrs = termios.tcgetattr(slave)
                                if not screens:
                                    raw_entered = not bool(attrs[3] & (termios.ICANON | termios.ECHO))
                                    if not raw_entered:
                                        raise RuntimeError("TUI did not enter raw mode")
                                screens.append(screen)
                                os.write(master, b"q" if len(screens) == 3 else b"\t")
        if status is None:
            assert pid is not None
            waited, result = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = result

    try:
        pid = os.fork()
        if pid == 0:
            try:
                signal.set_wakeup_fd(-1)
                signal.signal(signal.SIGCHLD, signal.SIG_DFL)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                os.close(wake_read)
                os.close(wake_write)
                os.close(master)
                # Do not setsid: parent-death ownership belongs to the outer
                # desktop-process-supervisor keeper. isatty/termios work on the
                # open slave without assigning a separate controlling session.
                for fd in (0, 1, 2):
                    os.dup2(slave, fd)
                if slave > 2:
                    os.close(slave)
                os.execve(argv[0], argv, {**os.environ, "TERM": "xterm-256color"})
            except BaseException:
                os._exit(127)
        end = time.monotonic() + timeout
        while status is None:
            wait_events(end, True)
        restored = termios.tcgetattr(slave) == original
        if os.waitstatus_to_exitcode(status) != 0 or len(screens) != 3 or not restored:
            raise RuntimeError("TUI exited without complete navigation/restoration")
    except BaseException as error:
        failure = error
    finally:
        cleanup_errors = []
        # On failure the child may still be running. Closing the slave/master
        # and returning nonzero hands termination to the retained outer keeper.
        # Never signal after waitpid, and never claim reaping on that path.

        # Restoration is observed BEFORE harness repair, never credited to it.
        try:
            termios.tcsetattr(slave, termios.TCSANOW, original)
        except OSError as error:
            cleanup_errors.append(str(error))
        signal.set_wakeup_fd(old_wakeup)
        signal.signal(signal.SIGCHLD, old_handler)
        signal.signal(signal.SIGTERM, old_term)
        selector.close()
        for fd in (master, slave, wake_read, wake_write):
            os.close(fd)
        if cleanup_errors:
            failure = RuntimeError(f"{failure}; cleanup: {cleanup_errors}")
    return {
        "code": os.waitstatus_to_exitcode(status) if status is not None else None,
        "output_subscribed_before_exec": True,
        "screens": screens,
        "raw_entered": raw_entered,
        "restored": restored,
        "reaped": status is not None,
        "pipes_closed": True,
        "output": output.decode("utf-8", errors="replace"),
        "failure": str(failure) if failure else None,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2 or not os.path.isabs(sys.argv[1]):
        raise SystemExit("absolute gateway binary and tui argv required")
    result = observe(sys.argv[1:])
    print(json.dumps(result))
    raise SystemExit(1 if result["failure"] else 0)
