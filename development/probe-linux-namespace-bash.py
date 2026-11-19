"""Bashの別の子で匿名pipeを観測し、PID再利用を避けて対象だけを停止する。"""

import datetime
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import sys
import time

SELF = Path(__file__).resolve()

import importlib.util

_spec = importlib.util.spec_from_file_location("namespace_parent", SELF.with_name("probe-linux-namespace-parent.py"))
parent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(parent)
launch = parent.launch
DRIVER = SELF.with_suffix(".sh")
UNSHARE = "/usr/bin/unshare"
READY = 46
BASELINE_READY = 47


def digest(path):
    """実行体と測定コードのSHA-256を返す。"""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    """所有する新しい記録だけを0600で作成する。"""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def timestamp():
    """UTCの壁時計をprobe記録へ残す。"""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def process_entry(pid):
    """command lineや環境全体を読まず、PID世代・親・実体を確認する。"""
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    executable = os.readlink(f"/proc/{pid}/exe")
    try:
        executable.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ValueError("観測した実行体pathがUTF-8ではありません") from None
    return {
        "pid": pid, "ppid": int(fields[1]), "processGroup": int(fields[2]),
        "session": int(fields[3]), "startTimeTicks": int(fields[19]),
        "path": executable,
    }


def protocol_line(fd, timeout=5):
    """実出力より前の短い制御行を、期限と長さを固定して読む。"""
    deadline, value = time.monotonic() + timeout, bytearray()
    while not value.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError("制御行の期限を超えました")
        chunk = os.read(fd, 1)
        if not chunk or len(value) >= 64:
            raise ValueError("制御行が不正です")
        value.extend(chunk)
    return bytes(value)


def donate():
    """stderr用pipeは読まず、観測側がreaderを確保した後に制御行だけを消費して終了する。"""
    if protocol_line(0) != b"RELEASE\n":
        raise ValueError("pipeの引継ぎが不正です")


def observe(args):
    """同じBashが作った子をgate中にpidfdへ固定し、別々の匿名pipeを上限内で収集する。"""
    owner, donor, writer = map(int, args[:3])
    path, timeout, limit, executable, expected = args[3], float(args[4]), int(args[5]), args[6], args[7]
    argv = args[8:]
    result = {"argv": argv, "pid": 0, "ownerPid": owner, "observerPid": os.getpid(),
              "status": None, "signal": None}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    raw_fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    pidfd, err_reader, started = None, None, None
    try:
        if owner != os.getppid() or owner <= 0 or donor <= 0:
            raise ValueError("観測子の共通Bash親が一致しません")
        if not math.isfinite(timeout) or not 0 < timeout <= 5 or not 0 < limit <= 32 * 1024 * 1024:
            raise ValueError("captureの上限が不正です")
        if not re.fullmatch(r"[a-f0-9]{64}", expected) or digest(executable) != expected:
            raise ValueError("対象実行体が一致しません")
        common, donated = process_entry(owner), process_entry(donor)
        if Path(common["path"]).name != "bash" or donated["ppid"] != owner:
            raise ValueError("pipe補助の共通親が一致しません")
        err_reader = os.open(f"/proc/{donor}/fd/0", os.O_RDONLY | os.O_NONBLOCK)
        observed, supplied = os.fstat(err_reader), os.stat(f"/proc/{owner}/fd/{writer}")
        if not stat.S_ISFIFO(observed.st_mode) or (observed.st_dev, observed.st_ino) != (supplied.st_dev, supplied.st_ino):
            raise ValueError("stderrの匿名pipeが一致しません")
        os.write(1, b"READY\n")
        command = protocol_line(0).decode("ascii").strip().split()
        if len(command) != 2 or command[0] != "START" or not re.fullmatch(r"[1-9][0-9]*", command[1]):
            raise ValueError("probe開始要求が不正です")
        child = int(command[1])
        # gate中に開いたpidfdだけを使い、終了後の同じ数値PIDへsignalを送らない。
        pinned = os.pidfd_open(child)
        entry = process_entry(child)
        if child in (owner, donor, os.getpid()) or entry["ppid"] != owner or any(
            entry[key] != common[key] for key in ("path", "processGroup", "session")
        ):
            os.close(pinned)
            raise ValueError("Bashの所有probeではありません")
        pidfd = pinned
        result.update(pid=child, childBefore=entry, executableHash=expected)
        if digest(executable) != expected:
            raise ValueError("開始前に対象実行体が変化しました")
        result["startedAt"], started = timestamp(), time.monotonic()
        os.write(1, b"GO\n")
        if protocol_line(0, timeout) != b"ACK\n":
            raise ValueError("probeのexec gateが不正です")
        os.close(1)
        os.set_blocking(0, False)
        with selectors.DefaultSelector() as selector:
            selector.register(0, selectors.EVENT_READ, "stdout")
            selector.register(err_reader, selectors.EVENT_READ, "stderr")
            selector.register(pidfd, selectors.EVENT_READ, "exit")
            while selector.get_map() and "error" not in result:
                remaining = started + timeout - time.monotonic()
                if remaining <= 0:
                    result["error"] = "ETIMEDOUT"
                    break
                for key, _ in selector.select(remaining):
                    if key.data == "exit":
                        selector.unregister(pidfd)
                        continue
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fd)
                        continue
                    available = limit - sum(len(data) for data in buffers.values())
                    buffers[key.data].extend(chunk[:available])
                    if len(chunk) > available:
                        result["error"] = "ENOBUFS"
                        break
        result["executableHashAfter"] = digest(executable)
        if result["executableHashAfter"] != expected:
            raise ValueError("測定中に対象実行体が変化しました")
    except Exception as error:
        result.setdefault("error", errno.errorcode.get(getattr(error, "errno", None), type(error).__name__))
        result["detail"] = str(error)[:1024]
    finally:
        if pidfd is not None:
            if not select.select([pidfd], [], [], 0)[0]:
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    result.setdefault("error", errno.errorcode.get(error.errno, "UNKNOWN"))
                    result["cleanupError"] = errno.errorcode.get(error.errno, "UNKNOWN")
            if not select.select([pidfd], [], [], 5)[0]:
                result.setdefault("error", "ECHILD")
            os.close(pidfd)
        if err_reader is not None:
            os.close(err_reader)
        result.update({name: value.decode("utf-8", errors="replace") for name, value in buffers.items()})
        result["endedAt"] = timestamp()
        result["elapsedMs"] = (time.monotonic() - started) * 1000 if started is not None else 0
        with os.fdopen(raw_fd, "w") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")


def merge_capture(args):
    """Bashがwaitした状態を保持し、signalと128以上の通常終了を推測で区別しない。"""
    prefix, wait_status, observer_status, owner, executable, expected = args[:6]
    argv = args[6:]
    path = Path(prefix + "-streams.json")
    try:
        result = json.loads(path.read_text())
        if not isinstance(result, dict):
            raise ValueError("stream記録がobjectではありません")
    except (OSError, ValueError):
        result = {
            "argv": argv, "pid": 0, "ownerPid": int(owner), "status": None, "signal": None,
            "stdout": "", "stderr": "", "error": "EOBSERVER",
        }
    result["waitStatus"], result["observerStatus"] = int(wait_status), int(observer_status)
    if result.get("argv") != argv or result.get("ownerPid") != int(owner) or int(observer_status) != 0:
        result.setdefault("error", "EOBSERVER")
    if 0 <= int(wait_status) < 128:
        result["status"] = int(wait_status)
    else:
        result.setdefault("error", "EWAITSTATUS")
    if digest(executable) != expected:
        result.setdefault("error", "executable-changed")
    save(prefix + ".json", result)


def hashes():
    """既存判定器と今回のBash・観測子を同じcommitへ固定する。"""
    return {**parent.controller_hashes(), "bash": digest(DRIVER), "observer": digest(SELF)}


def validate(root):
    """既存の実VM前提を保ち、追加sourceとpidfd利用可能性を確認する。"""
    identity = parent.validate(root)
    if any(name in os.environ for name in ("BASH_ENV", "ENV")):
        raise ValueError("Bash直接比較では追加shell初期化を指定できません")
    for path in (SELF, DRIVER):
        relative = path.relative_to(SELF.parent.parent)
        committed = parent.subprocess.run(
            ["git", "show", identity["sourceSha"] + ":" + relative.as_posix()],
            cwd=root, capture_output=True, check=True, timeout=5,
        ).stdout
        if hashlib.sha256(committed).hexdigest() != digest(path) or digest(root / relative) != digest(path):
            raise ValueError("Bash直接比較のsourceがcommitと一致しません")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    return identity


def bash_context(pid):
    """Bash自身の限定proc情報と、その子へ継承された5環境値だけを照合する。"""
    lines = Path(f"/proc/{pid}/status").read_text().splitlines()
    fields = {line.split(":", 1)[0]: line.split(":", 1)[1].split() for line in lines if ":" in line}
    values = {}
    for path in launch.CONTEXTS:
        target = path.replace("/proc/self/", f"/proc/{pid}/")
        try:
            values[path] = {"value": Path(target).read_text().strip()}
        except OSError as error:
            values[path] = {"error": errno.errorcode.get(error.errno, "UNKNOWN")}
    return {
        "uid": int(fields["Uid"][0]), "euid": int(fields["Uid"][1]), "gid": int(fields["Gid"][0]),
        "groups": sorted(set(map(int, fields["Groups"])) | {int(fields["Gid"][1])}),
        "namespaces": {name: os.readlink(f"/proc/{pid}/ns/{name}") for name in ("user", "pid", "mnt")},
        "status": [line for line in lines if re.match(r"^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):", line)],
        "contexts": values, "environment": launch.context()["environment"],
    }


def snapshot(version):
    """namespace probeの親となるBashのPID世代・実体・限定contextを保存する。"""
    common = parent.ancestry()[1:]
    runtime = common[0]
    if Path(runtime.get("path", "")).name != "bash" or not re.fullmatch(r"[5-9]\.\d+\.\d+\(\d+\)-release", version):
        raise ValueError("Bash 5以上の共通親が必要です")
    cwd = os.readlink(f'/proc/{runtime["pid"]}/cwd')
    try:
        for value in (cwd, *(entry["path"] for entry in common if "path" in entry)):
            value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ValueError("観測したBashのcwd/pathがUTF-8ではありません") from None
    context = bash_context(runtime["pid"])
    if context != launch.context() or context["uid"] == 0 or context["euid"] == 0:
        raise ValueError("Bashと観測子のcaller条件が一致しません")
    return {
        "runtime": {"name": "bash", "path": runtime["path"], "hash": digest(runtime["path"]),
                    "version": version, "pid": runtime["pid"], "ppid": runtime["ppid"],
                    "cwd": cwd},
        "ancestry": common, "context": context,
    }


def runtime_hashes(version):
    """両経路と観測子の実行体を準備時へ固定する。"""
    return {"python": digest(sys.executable), "perl": digest(parent.PERL),
            "bash": snapshot(version)["runtime"]["hash"]}


def comparison_kind():
    """同じcaptureで比較する対照と、結果の保存先を選ぶ。"""
    return "userns" if os.environ.get("PROOF_MODE") == "probe-userns" else "bash"


def comparison_scenarios():
    """userns方式ではnamespace作成を保ち、mapping関連操作だけを省く。"""
    if comparison_kind() == "userns":
        return [launch.SCENARIOS[0], ("control", ["--user", "--", "/usr/bin/true"])]
    return launch.SCENARIOS


def prepare(root, output, version):
    """namespaceは起動せず、実体・版・共通Bashの前提を先に保存する。"""
    record = {"schema": "linux-namespace-bash-checkpoint/v1", "comparisonKind": comparison_kind(), "outcome": "unavailable"}
    try:
        record["identity"] = validate(root)
        os.chdir(root)
        record.update(controllerHashes=hashes(), runtimeHashes=runtime_hashes(version), bash=snapshot(version))
        expected = digest(UNSHARE)
        observed = launch.capture(UNSHARE, ["--version"], "/", {}, limit=65536, stdout_pipe=True, stderr_pipe=True)
        if observed.get("error") or observed["signal"] or observed["status"] != 0 or observed["stderr"] or not observed["stdout"].strip():
            raise ValueError("unshareの版を確認できません")
        if digest(UNSHARE) != expected:
            raise ValueError("版確認中にunshareが変化しました")
        record["unshare"] = {"path": str(Path(UNSHARE).resolve()), "hash": expected, "version": observed["stdout"].strip()}
        # Perlの既存検査と同じ形で、準備子自身の祖先とcallerも保持する。
        record.update(context=launch.context(), ancestry=parent.ancestry())
        if validate(root) != record["identity"] or hashes() != record["controllerHashes"] or snapshot(version) != record["bash"]:
            raise ValueError("準備中に条件が変化しました")
        record["outcome"] = "ready"
    except Exception as error:
        record["error"] = type(error).__name__ + ": " + str(error)
    finally:
        save(output / "namespace-bash-checkpoint.json", record)
        launch.emit({"stage": comparison_kind() + "-prepare", "outcome": record["outcome"], "error": record.get("error")}, comparison_kind())
    return READY if record["outcome"] == "ready" else 2


def check_checkpoint(root, output, version):
    """段階ごとに同じsource・Bash・caller・実行体を再確認する。"""
    checkpoint = json.loads((output / "namespace-bash-checkpoint.json").read_text())
    if (
        checkpoint.get("schema") != "linux-namespace-bash-checkpoint/v1" or checkpoint.get("outcome") != "ready"
        or checkpoint.get("comparisonKind") != comparison_kind()
        or checkpoint.get("identity") != validate(root) or checkpoint.get("controllerHashes") != hashes()
        or checkpoint.get("runtimeHashes") != runtime_hashes(version) or checkpoint.get("bash") != snapshot(version)
        or checkpoint.get("context") != launch.context() or checkpoint.get("ancestry", [])[1:] != parent.ancestry()[1:]
        or checkpoint["unshare"]["path"] != str(Path(UNSHARE).resolve())
        or checkpoint["unshare"]["hash"] != digest(UNSHARE)
    ):
        raise ValueError("段階間のsource・共通Bash・callerが一致しません")
    return checkpoint


def baseline_check(root, output, version, status):
    """閉鎖stdinのPerlが正確に再現した場合だけ、Bash直接側を許可する。"""
    record = {"schema": "linux-namespace-bash-gate/v1", "outcome": "unavailable"}
    try:
        record["baseline"] = json.loads((output / "namespace-bash-perl.json").read_text())
        checkpoint = check_checkpoint(root, output, version)
        baseline = record["baseline"]
        common = parent.ancestry()[1:]
        if status != 0 or baseline.get("before") != checkpoint["context"] or baseline.get("unshare") != checkpoint["unshare"]:
            raise ValueError("Perl baselineの段階または条件が一致しません")
        outcome = parent.measurement_outcome(baseline, "perl", common, stdin_type="closed")
        if outcome not in ("uid-map-eperm", "not-reproduced"):
            raise ValueError("Perl baselineは正確なEPERMまたは全成功ではありません")
        record.update(outcome=outcome, identity=checkpoint["identity"], controllerHashes=checkpoint["controllerHashes"])
    except Exception as error:
        record["error"] = type(error).__name__ + ": " + str(error)
    finally:
        save(output / "namespace-bash-gate.json", record)
        launch.emit({"stage": "perl-baseline", "outcome": record["outcome"], "error": record.get("error")}, comparison_kind())
    return BASELINE_READY if record["outcome"] == "uid-map-eperm" else parent.FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def start_bash(root, output, version):
    """baselineの許可を再確認し、Bash直接測定の開始点を排他的に保存する。"""
    checkpoint = check_checkpoint(root, output, version)
    gate = json.loads((output / "namespace-bash-gate.json").read_text())
    if gate.get("outcome") != "uid-map-eperm" or gate.get("identity") != checkpoint["identity"] or gate.get("controllerHashes") != hashes():
        raise ValueError("Bash直接測定は許可されていません")
    if parent.measurement_outcome(gate["baseline"], "perl", parent.ancestry()[1:], stdin_type="closed") != "uid-map-eperm":
        raise ValueError("baselineが変化しました")
    save(output / "namespace-bash-before.json", snapshot(version))


def bash_outcome(record, common, checkpoint):
    """Bashの直接子の所有権、全raw結果と測定前後の条件を分類する。"""
    try:
        runtime = record["runtime"]
        if (
            record.get("error") or record["ancestry"] != common or runtime != checkpoint["bash"]["runtime"]
            or record["before"] != checkpoint["context"] or record["after"] != record["before"]
            or record["controllerHash"] != digest(DRIVER) or record["unshare"] != checkpoint["unshare"]
            or record["stdinType"] != "closed" or record["cwd"] != "/"
            or record["stdoutType"] != "pipe" or record["stderrType"] != "pipe"
            or record["probeEnvironment"] != "empty" or record["forkCount"] != 6
        ):
            return "unavailable"
        probes = [probe for case in record["cases"] for probe in case["probes"]]
        ancestor_pids = {entry["pid"] for entry in common}
        if len(probes) != 6 or len({probe["pid"] for probe in probes}) != 6:
            return "unavailable"
        for probe in probes:
            initial = probe["childBefore"]
            if (
                type(probe["pid"]) is not int or probe["pid"] <= 0 or probe["pid"] in ancestor_pids
                or any(type(probe.get(key)) is not int or probe[key] <= 0 for key in ("ownerPid", "observerPid"))
                or probe["ownerPid"] != runtime["pid"] or probe["observerPid"] in ancestor_pids | {probe["pid"]}
                or any(type(initial.get(key)) is not int or initial[key] <= 0 for key in ("pid", "ppid", "processGroup", "session"))
                or type(probe.get("observerStatus")) is not int or type(probe.get("waitStatus")) is not int
                or initial["pid"] != probe["pid"] or initial["ppid"] != runtime["pid"]
                or initial["path"] != runtime["path"]
                or any(initial[key] != common[0][key] for key in ("processGroup", "session"))
                or type(initial["startTimeTicks"]) is not int or initial["startTimeTicks"] < 0
                or probe.get("observerStatus") != 0 or probe.get("waitStatus") != probe.get("status")
                or probe["executableHash"] != checkpoint["unshare"]["hash"]
                or probe["executableHashAfter"] != checkpoint["unshare"]["hash"]
            ):
                return "unavailable"
        return launch.outcome(record, comparison_scenarios())
    except (KeyError, TypeError, ValueError, IndexError, AttributeError, OSError):
        return "unavailable"


def load_bash(output, checkpoint):
    """完了前のcaptureも先に取り込み、後続の検査失敗でも保存する。"""
    before_file = output / "namespace-bash-before.json"
    if not before_file.exists():
        return None
    first = json.loads(before_file.read_text())
    record = {
        "runtime": first["runtime"], "ancestry": first["ancestry"], "before": first["context"],
        "controllerHash": digest(DRIVER), "unshare": checkpoint.get("unshare"),
        "cwd": "/", "stdinType": "closed", "stdoutType": "pipe", "stderrType": "pipe",
        "probeEnvironment": "empty", "cases": [],
    }
    for name, argv in comparison_scenarios():
        case = {"name": name, "argv": argv, "probes": []}
        record["cases"].append(case)
        for repetition in range(1, 4):
            path = output / f"bash-{name}-{repetition}.json"
            try:
                if path.exists():
                    probe = json.loads(path.read_text())
                    probe["repetition"] = repetition
                    case["probes"].append(probe)
            except (OSError, ValueError, TypeError) as error:
                record.setdefault("captureErrors", []).append({
                    "case": name, "repetition": repetition, "error": type(error).__name__,
                })
                record["error"] = "Bash captureの読取・解析に失敗しました"
    record["forkCount"] = sum(len(case["probes"]) for case in record["cases"])
    return record


def finalize(root, output, version, prepare_status, perl_status, gate_status, bash_status):
    """途中証跡と出所を保持し、選択した対照との比較を分類する。"""
    kind = comparison_kind()
    record = {"schema": f"linux-namespace-{kind}-comparison/v1", "outcome": "unavailable", "measurements": {}}
    try:
        checkpoint = json.loads((output / "namespace-bash-checkpoint.json").read_text())
        record.update({key: checkpoint[key] for key in ("identity", "controllerHashes", "runtimeHashes", "unshare") if key in checkpoint})
        baseline_file = output / "namespace-bash-perl.json"
        if baseline_file.exists():
            record["measurements"]["perl"] = json.loads(baseline_file.read_text())
        bash_measurement = load_bash(output, checkpoint)
        if bash_measurement is not None:
            record["measurements"]["bash"] = bash_measurement
            bash_measurement["after"] = snapshot(version)["context"]
        verified = check_checkpoint(root, output, version)
        gate = json.loads((output / "namespace-bash-gate.json").read_text())
        baseline, common = record["measurements"]["perl"], parent.ancestry()[1:]
        perl_outcome = parent.measurement_outcome(baseline, "perl", common, stdin_type="closed")
        if (
            prepare_status != READY or perl_status != 0 or verified != checkpoint
            or gate.get("baseline") != baseline or gate.get("identity") != checkpoint["identity"]
            or gate.get("controllerHashes") != hashes() or gate.get("outcome") != perl_outcome
            or baseline.get("before") != checkpoint["context"] or baseline.get("unshare") != checkpoint["unshare"]
        ):
            raise ValueError("比較段階またはbaselineが一致しません")
        if perl_outcome == "not-reproduced" and gate_status == parent.FINAL_CLEAR and bash_status == -1 and bash_measurement is None:
            record["outcome"] = "not-reproduced"
        elif perl_outcome == "uid-map-eperm" and gate_status == BASELINE_READY and bash_status == 0 and bash_measurement is not None:
            direct_outcome = bash_outcome(bash_measurement, common, checkpoint)
            probes = [probe for item in (baseline, bash_measurement) for case in item["cases"] for probe in case["probes"]]
            if len({probe["pid"] for probe in probes}) == 12:
                outcomes = {"uid-map-eperm": "id-mapping-required", "not-reproduced": "bash-not-reproduced"} if kind == "userns" else {
                    "uid-map-eperm": "perl-layer-not-required", "not-reproduced": "perl-layer-dependent",
                }
                record["outcome"] = outcomes.get(direct_outcome, "unavailable")
        if record["outcome"] == "unavailable":
            raise ValueError("選択した対照の比較条件・raw結果が成立しません")
        if validate(root) != record["identity"] or hashes() != record["controllerHashes"]:
            raise ValueError("最終判定中にsourceが変化しました")
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        save(output / f"namespace-{kind}.json", record)
        launch.emit({key: value for key, value in record.items() if key not in ("measurements", "outcome")}, kind)
        for name, measurement in record["measurements"].items():
            parent.log_measurement(name, measurement, prefix=kind)
        launch.emit({"outcome": record["outcome"], "error": record.get("error")}, kind)
    return parent.FINAL_REPRODUCED if record["outcome"] in ("perl-layer-not-required", "perl-layer-dependent", "id-mapping-required", "bash-not-reproduced") else parent.FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def comparison_main(args):
    """共通Bashが待機する各段階を専用終了コードで接続する。"""
    stage, root, output, version = args[0], Path(args[1]).resolve(), Path(args[2]).resolve(), args[3]
    if stage == "prepare":
        return prepare(root, output, version)
    if stage == "baseline-check":
        return baseline_check(root, output, version, int(args[4]))
    if stage == "start":
        start_bash(root, output, version)
        return 0
    if stage == "finalize":
        return finalize(root, output, version, *map(int, args[4:8]))
    if stage == "settings":
        print(json.loads((output / "namespace-bash-checkpoint.json").read_text())["unshare"]["hash"])
        return 0
    raise ValueError("比較段階が不正です")


def main(args):
    """Bash内の有限なpipe制御だけを提供する。"""
    if not args:
        raise ValueError("方式が必要です")
    if args[0] == "donor":
        donate()
    elif args[0] == "observe":
        observe(args[1:])
    elif args[0] == "merge":
        merge_capture(args[1:])
    else:
        return comparison_main(args)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print("Bash観測補助: " + type(error).__name__, file=sys.stderr)
        sys.exit(2)
