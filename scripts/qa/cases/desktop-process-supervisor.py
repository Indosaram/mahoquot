"""Creation-owned macOS QA process group; used only inside an admitted guest.

The supervisor never polls/reaps the group leader until after killpg. The
leader remains alive (or an unreaped zombie), reserving its PID/PGID even when
the application exits. Thus cleanup never signals a recycled remembered PID.
No GUI or security operations live here. Descendants must not call setsid.
"""
import json
import os
import signal
import subprocess
import sys
import threading

PREFIX = 'MAHOQUOT_QA_SUPERVISOR '


def emit(event, **fields):
    print(PREFIX + json.dumps(dict(event=event, **fields)), flush=True)


def keeper(argv):
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, text=True)
    child_input = child.stdin
    assert child_input is not None  # Popen PIPE contract, narrowed for Pyright.
    emit('app-spawned', pid=child.pid)

    def commands():
        for line in sys.stdin:
            try:
                child_input.write(line)
                child_input.flush()
            except (BrokenPipeError, ValueError):
                return

    threading.Thread(target=commands, daemon=True).start()
    code = child.wait()
    emit('app-exited', code=code if code >= 0 else None,
         signal=signal.Signals(-code).name if code < 0 else None)
    # Keep the process-group identity reserved until the owning parent kills
    # the group. No condition polling and no application descendants escape
    # merely because the direct app exited.
    threading.Event().wait()


def supervise(argv):
    leader = subprocess.Popen([sys.executable, __file__, '--keeper', *argv],
                              stdin=subprocess.PIPE, text=True,
                              start_new_session=True)
    leader_input = leader.stdin
    assert leader_input is not None  # Popen PIPE contract.
    try:
        for line in sys.stdin:
            if line.strip() == 'supervisor-stop':
                break
            leader_input.write(line)
            leader_input.flush()
    finally:
        # Never call poll()/wait() before killpg: the unreaped leader reserves
        # this group ID even on unexpected keeper failure.
        try:
            os.killpg(leader.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # No group exists; wait still harvests our exact child.
        except OSError as error:
            emit('cleanup-error', error=str(error))
            raise
        leader.wait(timeout=10)
        emit('group-terminated', pgid=leader.pid)


if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] not in ('--keeper', '--supervise'):
        raise SystemExit('expected --supervise/--keeper followed by executable')
    (keeper if sys.argv[1] == '--keeper' else supervise)(sys.argv[2:])
