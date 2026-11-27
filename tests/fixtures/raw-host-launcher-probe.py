"""Control verification and report a detached process identity to the host test."""

import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import sys


def hold():
    os.setsid()
    mode = os.environ["LAUNCHER_TEST_STALL"]
    if mode == "blocked":
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    elif mode == "ignored":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    identities = [os.pidfd_open(pid) for pid in (os.getpid(), os.getppid())]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.connect(os.environ["LAUNCHER_TEST_READY"])
        channel.sendmsg(
            [b"R"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("ii", *identities))]
        )
    for identity in identities:
        os.close(identity)
    while True:
        signal.pause()


def bun():
    real = os.environ["LAUNCHER_TEST_BUN"]
    if not any(arg.endswith("/verify-raw-codex-launcher.ts") for arg in sys.argv[1:]):
        os.execv(real, [real, *sys.argv[1:]])
    import re

    descriptor = int(re.fullmatch(r"/proc/self/fd/(\d+)", sys.argv[-1])[1])
    result = subprocess.run([real, *sys.argv[1:]], pass_fds=(descriptor,), check=False)
    if result.returncode:
        return result.returncode
    if os.environ.get("LAUNCHER_TEST_REPLACE"):
        binary = Path(sys.argv[-2]) / "launcher"
        renamed = binary.with_suffix(".old")
        binary.rename(renamed)
        shutil.copy2(renamed, binary)
    if os.environ.get("LAUNCHER_TEST_STALL"):
        return subprocess.call([sys.executable, __file__, "hold"])
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["hold"]:
        hold()
    sys.exit(bun())
