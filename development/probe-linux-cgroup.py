#!/usr/bin/env python3
"""委譲された cgroup v2 で準備子孫を cgroup.kill で終了できるかを測る可否確認（#116）。

select MARKER: userns → cgroup の順に実際に試し、どちらも使えなければ準備（MARKER の作成）を始めない。
run LABEL: 方式を選んだ後、直接の cgroup.kill とランチャー SIGKILL 時の watchdog を各3回測る。
終了コード: 0 成立 / 1 実測で不成立 / 2 測定器の不具合 / 3 select で拒否（fail closed）。
"""

import errno
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time

PREFIX = "[DEBUG-cgroup]"
LIMIT_NS = 5_000_000_000
DEADLINE_NS = 10_000_000_000
REPEAT = 3
# テストとリハーサル専用の上書き。実行時の値は environment に記録する。
UNSHARE = os.environ.get("PROBE_UNSHARE", "/usr/bin/unshare")
CGROUP_ROOT = os.environ.get("PROBE_CGROUP_ROOT", "/sys/fs/cgroup")
USERNS_ARGV = ["--user", "--map-current-user", "--pid", "--fork",
               "--kill-child=SIGKILL", "--mount-proc", "--", "/usr/bin/true"]


class Failed(Exception):
    """測定対象の操作が失敗した。可否の結果として記録する。"""

    def __init__(self, operation, error=None):
        super().__init__(operation)
        self.operation = operation
        self.error = error


def emit(event, **fields):
    print(PREFIX, json.dumps({"event": event, **fields}, ensure_ascii=False, sort_keys=True),
          flush=True)


def errname(error):
    return errno.errorcode.get(error.errno, str(error.errno))


def op(operation, fn, *args):
    try:
        return fn(*args)
    except OSError as error:
        raise Failed(operation, errname(error)) from None


def read(path):
    with open(path) as handle:
        return handle.read()


def write(path, text):
    fd = os.open(path, os.O_WRONLY)
    try:
        os.write(fd, text.encode())
    finally:
        os.close(fd)


def own_cgroup():
    for line in op("proc-self-cgroup", read, "/proc/self/cgroup").splitlines():
        if line.startswith("0::"):
            return os.path.normpath(CGROUP_ROOT + "/" + line[3:])
    raise Failed("cgroup-v2-membership")


def procs(cg):
    return {int(pid) for pid in op("cgroup.procs", read, cg + "/cgroup.procs").split()}


def populated(cg):
    for line in op("cgroup.events", read, cg + "/cgroup.events").splitlines():
        key, _, value = line.partition(" ")
        if key == "populated":
            return value == "1"
    raise Failed("cgroup.events")


def state(pid):
    try:
        return read(f"/proc/{pid}/stat").rpartition(")")[2].split()[0]
    except FileNotFoundError:
        return "gone"


def gone(pid):
    return state(pid) in ("gone", "Z")


def child_main(body):
    """fork 後の子で body を実行し、親のコードへ戻らずに終了する。"""
    status = 1
    try:
        body()
        status = 0
    finally:
        os._exit(status)


def to_devnull():
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    os.close(null)


def spawn_prep(cg, inherited):
    """準備子を cg へ移してから、setsid と二重 fork で離脱した孫を作らせる。"""
    go_r, go_w = os.pipe()
    report_r, report_w = os.pipe()
    prep = os.fork()
    if prep == 0:
        def prep_body():
            for fd in (go_w, report_r, *inherited):
                os.close(fd)
            to_devnull()
            os.read(go_r, 1)
            middle = os.fork()
            if middle == 0:
                def middle_body():
                    os.setsid()
                    if os.fork() == 0:
                        def detached_body():
                            os.write(report_w, f"{os.getpid()}\n".encode())
                            os.close(report_w)
                            signal.signal(signal.SIGTERM, signal.SIG_IGN)
                            signal.signal(signal.SIGHUP, signal.SIG_IGN)
                            while True:
                                signal.pause()
                        child_main(detached_body)
                child_main(middle_body)
            os.waitpid(middle, 0)
            os.close(report_w)
            while True:
                signal.pause()
        child_main(prep_body)
    os.close(go_r)
    os.close(report_w)
    try:
        op("move-prep", write, cg + "/cgroup.procs", str(prep))
        os.write(go_w, b"x")
        os.close(go_w)
        detached = read_line(report_r, "detached-report")
    except Failed:
        os.kill(prep, signal.SIGKILL)
        os.waitpid(prep, 0)
        raise
    finally:
        os.close(report_r)
    return prep, int(detached)


def read_line(fd, operation):
    deadline = time.monotonic() + DEADLINE_NS / 1e9
    data = b""
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise Failed(operation, "timeout")
        chunk = os.read(fd, 4096)
        if not chunk:
            raise Failed(operation, "eof")
        data += chunk
    return data.split(b"\n", 1)[0].decode()


def assert_contained(cg, inside, outside=()):
    members = procs(cg)
    for pid in inside:
        if pid not in members or gone(pid):
            raise Failed("contained-before-kill", f"pid {pid} state {state(pid)}")
    for pid in outside:
        if pid in members or gone(pid):
            raise Failed("outside-before-kill", f"pid {pid} state {state(pid)}")


def wait_empty(cg, pids, t0):
    """populated 0 かつ記録した全 PID が消滅またはゾンビになった単調時刻を返す。"""
    while True:
        now = time.monotonic_ns()
        if not populated(cg) and all(gone(pid) for pid in pids):
            return now, []
        if now - t0 > DEADLINE_NS:
            return None, sorted(procs(cg) | {pid for pid in pids if not gone(pid)})
        time.sleep(0.001)


def teardown(cg, pids, children):
    """結果に関わらず cgroup と子を片付け、rmdir の結果を返す。"""
    if os.path.exists(cg + "/cgroup.events") and populated(cg):
        try:
            write(cg + "/cgroup.kill", "1")
        except OSError:
            pass
        wait_empty(cg, [], time.monotonic_ns() - DEADLINE_NS + 2_000_000_000)
    for pid in pids:
        if not gone(pid):
            os.kill(pid, signal.SIGKILL)
    for pid in children:
        os.waitpid(pid, 0)
    try:
        os.rmdir(cg)
        return "ok"
    except FileNotFoundError:
        return "missing"
    except OSError as error:
        return errname(error)


def direct_kill(cg):
    op("mkdir", os.mkdir, cg)
    prep = detached = None
    record = {}
    try:
        prep, detached = spawn_prep(cg, [])
        assert_contained(cg, [prep, detached])
        record.update(prep=prep, detached=detached, detached_sid=os.getsid(detached))
        t0 = time.monotonic_ns()
        op("cgroup.kill", write, cg + "/cgroup.kill", "1")
        t_empty, survivors = wait_empty(cg, [prep, detached], t0)
        record.update(t0_ns=t0, empty_ns=t_empty, survivors=survivors,
                      elapsed_ms=None if t_empty is None else (t_empty - t0) / 1e6)
    finally:
        record["rmdir"] = teardown(cg, [p for p in (prep, detached) if p],
                                   [prep] if prep else [])
    record["passed"] = (record["empty_ns"] is not None
                        and record["empty_ns"] - record["t0_ns"] < LIMIT_NS
                        and record["rmdir"] == "ok")
    return record


def launcher(cg, report):
    """準備を cg に入れ、ランチャー死亡を pipe の EOF で検知する watchdog を cg の外に置く。"""
    try:
        os.mkdir(cg)
    except OSError as error:
        print(json.dumps({"ready": False, "operation": "mkdir", "error": errname(error)}),
              flush=True)
        return 1
    alive_r, alive_w = os.pipe()
    watchdog = os.fork()
    if watchdog == 0:
        def watchdog_body():
            os.close(alive_w)
            to_devnull()
            while os.read(alive_r, 1):
                pass
            kill_ns = time.monotonic_ns()
            error = None
            try:
                write(cg + "/cgroup.kill", "1")
            except OSError as failure:
                error = errname(failure)
            with open(report + ".tmp", "w") as handle:
                json.dump({"kill_ns": kill_ns, "error": error}, handle)
            os.rename(report + ".tmp", report)
        child_main(watchdog_body)
    os.close(alive_r)
    try:
        prep, detached = spawn_prep(cg, [alive_w])
    except Failed as failure:
        print(json.dumps({"ready": False, "operation": failure.operation,
                          "error": failure.error}), flush=True)
        return 1
    print(json.dumps({"ready": True, "launcher": os.getpid(), "watchdog": watchdog,
                      "prep": prep, "detached": detached}), flush=True)
    while True:
        signal.pause()


def watchdog_kill(cg):
    report = os.path.join(tempfile.mkdtemp(prefix="cgroup-probe-"), "watchdog.json")
    process = subprocess.Popen([sys.executable, os.path.abspath(__file__), "launcher", cg, report],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
    record = {}
    pids = [process.pid]
    try:
        ready = json.loads(read_line(process.stdout.fileno(), "launcher-ready"))
        if not ready["ready"]:
            raise Failed("launcher-" + ready["operation"], ready["error"])
        prep, detached, watchdog = ready["prep"], ready["detached"], ready["watchdog"]
        pids += [prep, detached, watchdog]
        assert_contained(cg, [prep, detached], [watchdog, process.pid])
        record.update(launcher=process.pid, watchdog=watchdog, prep=prep, detached=detached)
        t0 = time.monotonic_ns()
        os.kill(process.pid, signal.SIGKILL)
        process.wait()
        t_empty, survivors = wait_empty(cg, [prep, detached], t0)
        while not os.path.exists(report) and time.monotonic_ns() - t0 < DEADLINE_NS:
            time.sleep(0.001)
        written = json.loads(read(report)) if os.path.exists(report) else None
        while not gone(watchdog) and time.monotonic_ns() - t0 < DEADLINE_NS:
            time.sleep(0.001)
        record.update(t0_ns=t0, empty_ns=t_empty, survivors=survivors,
                      elapsed_ms=None if t_empty is None else (t_empty - t0) / 1e6,
                      watchdog_report=written, watchdog_exited=gone(watchdog))
    finally:
        record["rmdir"] = teardown(cg, pids, [])
        if process.poll() is None:
            process.kill()
            process.wait()
    written = record["watchdog_report"]
    record["watchdog_caused"] = bool(
        written and written["error"] is None and record["empty_ns"] is not None
        and record["t0_ns"] <= written["kill_ns"] <= record["empty_ns"])
    record["passed"] = (record["watchdog_caused"]
                        and record["empty_ns"] - record["t0_ns"] < LIMIT_NS
                        and record["rmdir"] == "ok")
    return record


def measure(event, fn, *args):
    try:
        result = fn(*args)
        record = {"outcome": "passed" if result["passed"] else "failed", **result}
    except Failed as failure:
        record = {"outcome": "failed", "operation": failure.operation, "error": failure.error}
    emit(event, **record)
    return record["outcome"] == "passed"


def attempt(fn):
    try:
        return fn()
    except (OSError, Failed) as error:
        return {"error": getattr(error, "operation", None) or errname(error)}


def environment():
    def cgroup_info():
        cg = own_cgroup()
        info = {"path": cg, "owner_uid": os.stat(cg).st_uid,
                "kill_file": os.path.exists(cg + "/cgroup.kill")}
        for name in ("cgroup.controllers", "cgroup.subtree_control"):
            info[name] = attempt(lambda: read(cg + "/" + name).split())
        return info

    emit("environment", kernel=os.uname().release, machine=os.uname().machine,
         uid=os.getuid(), euid=os.geteuid(), python=sys.version.split()[0],
         image=os.environ.get("ImageVersion"), cgroup=attempt(cgroup_info),
         overrides={key: os.environ[key] for key in ("PROBE_UNSHARE", "PROBE_CGROUP_ROOT")
                    if key in os.environ},
         # 判定には使わない。前提条件として記録するだけ。
         apparmor_restrict_unprivileged_userns=attempt(lambda: read(
             "/proc/sys/kernel/apparmor_restrict_unprivileged_userns").strip()))


def choose(label):
    """ADR 0005 の順に、sysctl ではなく実際の操作で方式を選ぶ。"""
    try:
        done = subprocess.run([UNSHARE, *USERNS_ARGV], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=10)
        userns = {"exit": done.returncode, "stderr": done.stderr[:512].decode(errors="replace")}
    except (OSError, subprocess.TimeoutExpired) as error:
        userns = {"exit": None, "error": type(error).__name__}
    emit("select-userns", unshare=UNSHARE, argv=USERNS_ARGV, **userns)
    if userns["exit"] == 0:
        return "userns"
    try:
        base = own_cgroup()
    except Failed as failure:
        emit("select-cgroup", outcome="failed", operation=failure.operation, error=failure.error)
        return "refused"
    usable = measure("select-cgroup", direct_kill, f"{base}/probe-{label}-select-{os.getpid()}")
    return "cgroup" if usable else "refused"


def select_command(marker):
    environment()
    selected = choose("select")
    if selected != "refused":
        # 準備の開始に相当する。拒否時はここへ到達しない。
        open(marker, "x").close()
    exists = os.path.exists(marker)
    emit("select", selected=selected, preparation_started=exists)
    if selected == "refused":
        return 2 if exists else 3
    return 0


def run_command(label):
    environment()
    selected = choose(label)
    base = own_cgroup()
    results = {"direct": [], "watchdog": []}
    for index in range(1, REPEAT + 1):
        results["direct"].append(measure(
            "direct-kill", direct_kill, f"{base}/probe-{label}-direct-{index}-{os.getpid()}"))
    for index in range(1, REPEAT + 1):
        results["watchdog"].append(measure(
            "watchdog-kill", watchdog_kill, f"{base}/probe-{label}-watchdog-{index}-{os.getpid()}"))
    feasible = all(results["direct"]) and all(results["watchdog"])
    emit("summary", label=label, selected=selected, feasible=feasible, **results)
    return 0 if feasible else 1


def main(argv):
    if len(argv) == 2 and argv[0] == "select":
        return select_command(argv[1])
    if len(argv) == 2 and argv[0] == "run":
        return run_command(argv[1])
    if len(argv) == 3 and argv[0] == "launcher":
        return launcher(argv[1], argv[2])
    print("usage: probe-linux-cgroup.py select MARKER | run LABEL", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Failed as failure:
        emit("broken", operation=failure.operation, error=failure.error)
        sys.exit(2)
    except Exception as error:  # 測定器の不具合を「不成立」(1) と混同しない。
        emit("broken", error=repr(error))
        sys.exit(2)
