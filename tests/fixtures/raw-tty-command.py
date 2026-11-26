"""Observe the real with-env caller using a terminal and an inherited descriptor."""

import json
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import tempfile


def target():
    signal.signal(signal.SIGUSR2, lambda *_: sys.exit(37))
    print(
        json.dumps(
            {
                "pid": os.getpid(),
                "descriptor": os.fstat(int(sys.argv[2])).st_ino,
                "tty": all(os.isatty(fd) for fd in range(3)),
                "mask": signal.SIGUSR1 in signal.pthread_sigmask(signal.SIG_BLOCK, []),
                "ignore": signal.getsignal(signal.SIGINT) == signal.SIG_IGN,
                "argv": [os.fsencode(arg).hex() for arg in sys.argv[3:]],
                "prepared": os.environ["HOOK_VAR"],
            }
        ),
        flush=True,
    )
    if sys.stdin.readline().strip() != "terminal input":
        sys.exit(1)
    print("input received", flush=True)
    while True:
        signal.pause()


def supervise():
    assert Path("/bin/bash").resolve(strict=True) == Path(sys.argv[1])
    with tempfile.TemporaryFile() as inherited:
        master, slave = pty.openpty()
        try:
            descriptor = inherited.fileno()
            mask = signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGUSR1])
            handler = signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                child = subprocess.Popen(
                    [
                        "with-env", "--prepared", "--", sys.executable, "-I", "-B",
                        __file__, "target", str(descriptor), "literal argument", b"byte-\xff",
                    ],
                    stdin=slave, stdout=slave, stderr=slave,
                    pass_fds=(descriptor,), restore_signals=False,
                )
            finally:
                signal.signal(signal.SIGINT, handler)
                signal.pthread_sigmask(signal.SIG_SETMASK, mask)
                os.close(slave)
            try:
                with os.fdopen(os.dup(master), "rb") as terminal:
                    result = json.loads(terminal.readline())
                    result["samePid"] = result.pop("pid") == child.pid
                    result["sameDescriptor"] = (
                        result.pop("descriptor") == os.fstat(descriptor).st_ino
                    )
                    os.write(master, b"terminal input\n")
                    result["input"] = False
                    for line in terminal:
                        if line.strip() == b"input received":
                            result["input"] = True
                            break
                child.send_signal(signal.SIGUSR2)
                result["exit"] = child.wait(timeout=5)
                print("RAW_TTY " + json.dumps(result, sort_keys=True))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
        finally:
            os.close(master)


if sys.argv[1:] and sys.argv[1] == "target":
    target()
else:
    def deadline(*_):
        raise TimeoutError("terminal command did not complete")

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(15)
    supervise()
