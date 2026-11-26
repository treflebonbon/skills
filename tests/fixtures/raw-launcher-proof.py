"""Observe a launcher and its detached preparation child inside the raw namespace."""

import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
RESULT = Path("/result")
SCRIPT = str(HERE / "supervise.py")


def detached_descendant(launcher):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and launcher.poll() is None:
        if (RESULT / "ready").exists():
            for path in Path("/proc").iterdir():
                if not path.name.isdecimal():
                    continue
                try:
                    argv = (path / "cmdline").read_bytes().split(b"\0")
                    if argv[3:5] == [os.fsencode(SCRIPT), b"descendant"]:
                        status = (path / "status").read_text()
                        pid = int(path.name)
                        assert os.getsid(pid) == pid
                        assert os.getsid(launcher.pid) != pid
                        return pid, status
                except FileNotFoundError:
                    continue
        time.sleep(0.01)
    raise AssertionError(f"detached preparation did not start: launcher exit={launcher.poll()}")


def supervise(executable):
    entry = [str(HERE / "entry"), str(HERE / "run"), str(HERE / "prepare.ts"), executable]
    suffix = [sys.executable, SCRIPT]
    marker = RESULT / "target.json"
    namespace = os.stat("/proc/self/ns/pid").st_ino
    with (RESULT / "lock").open("xb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        suffix.append(str(lock.fileno()))

        launcher = subprocess.Popen([*entry, "hold", *suffix])
        with os.fdopen(os.pidfd_open(launcher.pid), "rb") as launcher_fd:
            descendant, status = detached_descendant(launcher)
            assert os.readlink(f"/proc/{launcher.pid}/exe") == executable
            with os.fdopen(os.pidfd_open(descendant), "rb") as descendant_fd:
                poller = select.poll()
                poller.register(descendant_fd, select.POLLIN)
                assert not poller.poll(0), "observer must hold a running descendant"
                sent = time.monotonic_ns()
                signal.pidfd_send_signal(launcher_fd.fileno(), signal.SIGKILL)
                events = poller.poll(5_000)
                elapsed_ms = (time.monotonic_ns() - sent) / 1_000_000
                assert events and events[0][1] & select.POLLIN, "detached preparation is still alive"
                assert elapsed_ms <= 5_000
            assert launcher.wait(timeout=5) == -signal.SIGKILL
        assert os.stat("/proc/self/ns/pid").st_ino == namespace
        assert not marker.exists(), "target started during killed preparation"

        launcher = subprocess.Popen(
            [*entry, "normal", *suffix],
            pass_fds=(lock.fileno(),),
            env=os.environ | {"RAW_LAUNCHER_PROOF_ENV": "inherited"},
        )
        try:
            assert launcher.wait(timeout=15) == 37
            assert json.loads(marker.read_bytes()) == [launcher.pid, "quoted argument", "inherited"]
        except subprocess.TimeoutExpired:
            launcher.kill()
            launcher.wait(timeout=5)
            raise

    caps = [line for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("Cap")]
    assert len(caps) == 5 and all(int(line.split()[1], 16) == 0 for line in caps)
    namespace_pids = next(line.split()[1:] for line in status.splitlines() if line.startswith("NSpid:"))
    result = {
        "kernel": os.uname().release,
        "architecture": os.uname().machine,
        "containment": "PID namespace" if len(namespace_pids) > 1 else "cgroup v2",
        "detachedExitMilliseconds": elapsed_ms,
        "targetAfterKill": False,
        "normalTargetExit": 37,
        "normalTargetPid": launcher.pid,
        "namespaceUnchanged": True,
        "capabilities": caps,
    }
    print(json.dumps(result), flush=True)


if sys.argv[1] == "descendant":
    os.setsid()
    (RESULT / "ready").touch()
    while True:
        signal.pause()
elif sys.argv[1] == "target":
    fcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX | fcntl.LOCK_NB)
    (RESULT / "target.json").write_text(
        json.dumps([os.getpid(), sys.argv[3], os.environ["RAW_LAUNCHER_PROOF_ENV"]])
    )
    sys.exit(37)
else:
    supervise(sys.argv[1])
