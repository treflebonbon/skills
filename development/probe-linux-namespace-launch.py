"""起動経路・cwd・各出力streamを一条件ずつ比較する開発用診断。"""

import datetime
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import socket
import subprocess
import sys
import time

SELF = Path(__file__).resolve()
NODE_HELPER = SELF.with_name("probe-linux-namespace-caller.mjs")
EXACT_ERROR = "unshare: write failed /proc/self/uid_map: Operation not permitted\n"
SCENARIOS = [
    ("minimal", ["--map-current-user", "--", "/usr/bin/true"]),
    ("control", ["--", "/usr/bin/true"]),
]
CONTEXTS = [
    "/proc/self/uid_map",
    "/proc/self/gid_map",
    "/proc/self/attr/current",
    "/sys/module/apparmor/parameters/enabled",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "/proc/sys/kernel/unprivileged_userns_clone",
    "/proc/sys/user/max_user_namespaces",
]


def digest(path):
    """実行体または測定コードのSHA-256を返す。"""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def context():
    """自身の資格情報・namespace・限定LSM/環境条件を観測する。"""
    environment = {
        key: os.environ.get(key) for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")
    }
    for name, value in environment.items():
        if value is not None:
            try:
                value.encode("utf-8", errors="strict")
            except UnicodeEncodeError:
                raise ValueError(f"比較環境の{name}がUTF-8ではありません") from None
    status = Path("/proc/self/status").read_text().splitlines()
    values = {}
    for path in CONTEXTS:
        try:
            values[path] = {"value": Path(path).read_text().strip()}
        except OSError as error:
            values[path] = {"error": errno.errorcode.get(error.errno, "UNKNOWN")}
    return {
        "uid": os.getuid(),
        "euid": os.geteuid(),
        "gid": os.getgid(),
        "groups": sorted(set(os.getgroups()) | {os.getegid()}),
        "namespaces": {
            name: os.readlink("/proc/self/ns/" + name) for name in ("user", "pid", "mnt")
        },
        "status": [
            line for line in status
            if re.match(r"^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):", line)
        ],
        "contexts": values,
        "environment": environment,
    }


def capture(executable, argv, root, environment, timeout=5, limit=32 * 1024 * 1024, stdout_pipe=False, stderr_pipe=False):
    """指定streamのsocket/pipeを上限内で取得し、超過時は所有する子をSIGKILLする。"""
    started = time.monotonic()
    result = {
        "argv": argv, "pid": 0,
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "status": None, "signal": None,
    }
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    child = None
    channels = {}
    pipes = {"stdout": stdout_pipe, "stderr": stderr_pipe}
    try:
        for name in buffers:
            if not pipes[name]:
                channels[name] = socket.socketpair()
        with open(os.devnull, "rb") as null_input:
            child = subprocess.Popen(
                [str(executable), *argv], cwd=root, env=environment,
                stdin=null_input, stdout=subprocess.PIPE if stdout_pipe else channels["stdout"][1],
                stderr=subprocess.PIPE if stderr_pipe else channels["stderr"][1],
            )
        result["pid"] = child.pid
        for name, piped in pipes.items():
            if piped:
                channels[name] = (getattr(child, name), None)
        for reader, writer in channels.values():
            if writer is not None:
                writer.close()
        with selectors.DefaultSelector() as selector:
            for name in buffers:
                selector.register(channels[name][0], selectors.EVENT_READ, name)
            while selector.get_map() and "error" not in result:
                remaining = started + timeout - time.monotonic()
                if remaining <= 0:
                    result["error"] = "ETIMEDOUT"
                    break
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buffer = buffers[key.data]
                    available = limit - sum(len(data) for data in buffers.values())
                    buffer.extend(chunk[:available])
                    if len(chunk) > available:
                        result["error"] = "ENOBUFS"
                        break
        if "error" in result and child.poll() is None:
            child.kill()
        try:
            child.wait(timeout=5 if "error" in result else max(0.001, started + timeout - time.monotonic()))
        except subprocess.TimeoutExpired:
            result["error"] = "ETIMEDOUT"
            child.kill()
            child.wait(timeout=5)
        if child.returncode is not None:
            if child.returncode < 0:
                result["signal"] = signal.Signals(-child.returncode).name
            else:
                result["status"] = child.returncode
    except OSError as error:
        result["error"] = errno.errorcode.get(error.errno, "UNKNOWN")
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
        for pair in channels.values():
            for stream in pair:
                if stream is not None:
                    stream.close()
    result.update({name: data.decode("utf-8", errors="replace") for name, data in buffers.items()})
    result["endedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    result["elapsedMs"] = (time.monotonic() - started) * 1000
    return result


def classify(probe):
    """exact EPERM・成功・それ以外を分ける。"""
    if probe.get("error") or probe.get("signal") or type(probe.get("pid")) is not int or probe["pid"] <= 0:
        return "unavailable"
    if type(probe.get("status")) is not int or probe.get("stdout") != "":
        return "unavailable"
    if probe.get("status") == 0 and probe.get("stderr") == "":
        return "passed"
    if probe.get("status") == 1 and probe.get("stderr") == EXACT_ERROR:
        return "uid-map-eperm"
    return "unavailable"


def outcome(record):
    """同じ条件の3反復と成功対照から測定の分類を再計算する。"""
    if record.get("probeEnvironment") != "empty" or record.get("before") != record.get("after"):
        return "unavailable"
    cases = record.get("cases", [])
    if len(cases) != 2:
        return "unavailable"
    outcomes = []
    for case, (name, argv) in zip(cases, SCENARIOS):
        probes = case.get("probes", [])
        if case.get("name") != name or case.get("argv") != argv or len(probes) != 3:
            return "unavailable"
        results = [
            classify(probe) if probe.get("argv") == argv and probe.get("repetition") == index else "unavailable"
            for index, probe in enumerate(probes, 1)
        ]
        outcomes.append(results[0] if len(set(results)) == 1 else "unavailable")
    if outcomes == ["uid-map-eperm", "passed"]:
        return "uid-map-eperm"
    return "not-reproduced" if outcomes == ["passed", "passed"] else "unavailable"


def measure(executable, root, stdout_pipe=False, stderr_pipe=False):
    """Nodeを祖先に置かず、共通Python親から空環境で6回直接起動する。"""
    version = capture(executable, ["--version"], root, dict(os.environ), limit=64 * 1024)
    if version.get("error") or version["signal"] or version["status"] != 0 or version["stderr"] or not version["stdout"].strip():
        raise ValueError("unshareの版を確認できません")
    record = {
        "runtime": {
            "name": "python", "version": platform.python_version(),
            "path": str(Path(sys.executable).resolve()), "hash": digest(sys.executable),
            "pid": os.getpid(), "ppid": os.getppid(),
        },
        "probeEnvironment": "empty", "controllerHash": digest(SELF),
        "unshare": {"path": str(executable), "hash": digest(executable), "version": version["stdout"].strip()},
        "before": context(), "cases": [],
    }
    for name, argv in SCENARIOS:
        case = {"name": name, "argv": argv, "probes": []}
        record["cases"].append(case)
        for repetition in (1, 2, 3):
            case["probes"].append({"repetition": repetition, **capture(executable, argv, root, {}, stdout_pipe=stdout_pipe, stderr_pipe=stderr_pipe)})
    record["after"] = context()
    record["outcome"] = outcome(record) if digest(executable) == record["unshare"]["hash"] else "unavailable"
    return record


def node_outcome(node):
    """直接起動を許可する前に、既存Node測定器の版・hash・raw結果を再検証する。"""
    runtime = node.get("runtime", {})
    version = runtime.get("version", "")
    if (
        runtime.get("name") != "node" or not re.fullmatch(r"\d+\.\d+\.\d+", version)
        or int(version.split(".")[0]) < 22 or node.get("controllerHash") != digest(NODE_HELPER)
        or node.get("outcome") != outcome(node)
    ):
        return "unavailable"
    return node["outcome"]


def compare(node, direct):
    """共通親・空環境・固定条件を確認し、Node起動経路の要否だけを分類する。"""
    baseline = node_outcome(node)
    if baseline == "not-reproduced" and direct is None:
        return "not-reproduced"
    if baseline != "uid-map-eperm" or direct is None:
        return "unavailable"
    if (
        direct.get("runtime", {}).get("name") != "python"
        or node["runtime"].get("ppid") != direct["runtime"].get("pid")
        or direct.get("controllerHash") != digest(SELF)
        or node.get("unshare") != direct.get("unshare")
        or node.get("before") != direct.get("before")
        or direct.get("outcome") != outcome(direct)
    ):
        return "unavailable"
    return {
        "uid-map-eperm": "node-not-required",
        "not-reproduced": "node-launch-dependent",
    }.get(direct["outcome"], "unavailable")


def validate(root):
    """probe前後のOS・非root・source・既存実行体と準備省略を照合する。"""
    env = os.environ
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if (
        sys.platform != "linux" or os.getuid() == 0 or os.geteuid() == 0 or not sys.flags.isolated
        or arch not in ("x64", "arm64") or env.get("PROOF_ARCH") != arch
        or env.get("ImageOS") != ("ubuntu24" if arch == "x64" else "ubuntu24-arm64")
        or not env.get("ImageVersion")
        or not re.search(r'^VERSION_ID="24\.04"$', Path("/etc/os-release").read_text(), re.M)
    ):
        raise ValueError("起動経路比較はUbuntu 24.04・指定architecture・Python -I・非rootで実行してください")
    if any(Path(path).exists() for path in ("/nix", "/etc/nix/nix.conf")) or any(
        name in env for name in ("NIX_REMOTE", "PROCESS_PROOF_NIX_BASH", "PROCESS_PROOF_NIX_STDENV", "PROCESS_PROOF_GROUP_FILE", "PROCESS_PROOF_GROUP_GID")
    ):
        raise ValueError("起動経路比較では専用のNix・group準備を省略してください")
    if any(name in env for name in ("NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD")):
        raise ValueError("起動経路比較では追加runtime optionを指定できません")
    source = env.get("PROOF_SOURCE_SHA", "")
    run_id, attempt = env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", "")
    if (
        not re.fullmatch(r"[a-f0-9]{40}", source) or env.get("GITHUB_SHA") != source
        or not re.fullmatch(r"[1-9][0-9]*", run_id) or not re.fullmatch(r"[1-9][0-9]*", attempt)
        or int(attempt) > 2**53 - 1
    ):
        raise ValueError("source/workflow/run/attemptの入力が不正です")
    control = SELF.parent.parent
    for checkout in (root, control):
        observed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, capture_output=True, check=True, timeout=5)
        if observed.stdout.decode().strip() != source:
            raise ValueError("checkoutのSHAが一致しません")
    for path in (SELF, NODE_HELPER):
        relative = path.relative_to(control)
        committed = subprocess.run(["git", "show", source + ":" + relative.as_posix()], cwd=root, capture_output=True, check=True, timeout=5).stdout
        if hashlib.sha256(committed).hexdigest() != digest(path) or digest(Path(root) / relative) != digest(path):
            raise ValueError("測定コードが対象commitと一致しません")
    for path in CONTEXTS[:3]:
        Path(path).read_text()
    return {
        "sourceSha": source, "workflowSha": source, "runId": run_id, "attempt": int(attempt),
        "arch": arch, "kernel": platform.release(), "imageOS": env["ImageOS"],
        "imageVersion": env["ImageVersion"], "setupAbsent": True,
    }


def emit(value, prefix="launch"):
    """新しい比較に限定したJSON行を出力する。"""
    print("[DEBUG-ns-" + prefix + "] " + json.dumps(value, ensure_ascii=False), flush=True)


def log_measurement(name, record, prefix="launch"):
    """caller条件と各probeの出力をstreamごと1024文字まで記録する。"""
    dimension = prefix + "Type" if prefix in ("stdout", "stderr") else prefix
    labels = {dimension: name, **{key: record[key] for key in ("stdoutType", "stderrType") if key in record}}
    header = {**labels, **{key: record[key] for key in ("runtime", "probeEnvironment", "controllerHash", "unshare", "before", "after", "outcome")}}
    if "cwd" in record:
        header["workingDirectory"] = record["cwd"]
    emit(header, prefix)
    for case in record["cases"]:
        for probe in case["probes"]:
            emit({
                **labels, "case": case["name"], **probe,
                "stdout": probe["stdout"][:1024], "stderr": probe["stderr"][:1024],
                "logTruncated": len(probe["stdout"]) > 1024 or len(probe["stderr"]) > 1024,
                "outcome": classify(probe),
            }, prefix)


def direct_outcome(record, directory):
    """cwd以外を固定した直接起動のraw結果と実行体を再検証する。"""
    runtime = record.get("runtime", {})
    if (
        record.get("cwd") != str(directory) or runtime.get("name") != "python"
        or runtime.get("pid") != os.getpid() or runtime.get("ppid") != os.getppid()
        or runtime.get("version") != platform.python_version()
        or runtime.get("path") != str(Path(sys.executable).resolve())
        or runtime.get("hash") != digest(sys.executable)
        or record.get("controllerHash") != digest(SELF)
        or record.get("outcome") != outcome(record)
    ):
        return "unavailable"
    return record["outcome"]


def same_direct_conditions(baseline, changed):
    """直接起動の同じ親・実行体・caller条件を両測定間で照合する。"""
    return all(baseline.get(key) == changed.get(key) for key in ("runtime", "unshare", "before"))


def compare_cwd(source, changed, root):
    """checkout側の再現と成功対照を前提に、cwdだけの比較を分類する。"""
    baseline = direct_outcome(source, root)
    if baseline == "not-reproduced" and changed is None:
        return "not-reproduced"
    if baseline != "uid-map-eperm" or changed is None:
        return "unavailable"
    if not same_direct_conditions(source, changed):
        return "unavailable"
    return {
        "uid-map-eperm": "cwd-not-required",
        "not-reproduced": "cwd-dependent",
    }.get(direct_outcome(changed, "/"), "unavailable")


def measure_cwd(executable, root, record=None):
    """同じ親から再現確認後だけ/を測り、途中までの取得結果も保持する。"""
    if record is None:
        record = {"measurements": {}, "outcome": "unavailable"}
    source = {**measure(executable, root), "cwd": str(root)}
    record["measurements"]["source"] = source
    changed = None
    if direct_outcome(source, root) == "uid-map-eperm":
        changed = {**measure(executable, "/"), "cwd": "/"}
        record["measurements"]["root"] = changed
    record["outcome"] = compare_cwd(source, changed, root)
    return record


def compare_stdout(baseline, changed):
    """socket側の再現と成功対照を前提に、stdoutの種類だけの比較を分類する。"""
    if baseline.get("stdoutType") != "socket":
        return "unavailable"
    baseline_outcome = direct_outcome(baseline, "/")
    if baseline_outcome == "not-reproduced" and changed is None:
        return "not-reproduced"
    if baseline_outcome != "uid-map-eperm" or changed is None:
        return "unavailable"
    if (
        changed.get("stdoutType") != "pipe"
        or not same_direct_conditions(baseline, changed)
    ):
        return "unavailable"
    return {
        "uid-map-eperm": "stdout-socket-not-required",
        "not-reproduced": "stdout-type-dependent",
    }.get(direct_outcome(changed, "/"), "unavailable")


def measure_stdout(executable, record=None):
    """cwd /でsocket側の再現確認後だけstdoutをpipeに変え、途中記録も保持する。"""
    if record is None:
        record = {"measurements": {}, "outcome": "unavailable"}
    baseline = {**measure(executable, "/"), "cwd": "/", "stdoutType": "socket"}
    record["measurements"]["socket"] = baseline
    changed = None
    if direct_outcome(baseline, "/") == "uid-map-eperm":
        changed = {**measure(executable, "/", stdout_pipe=True), "cwd": "/", "stdoutType": "pipe"}
        record["measurements"]["pipe"] = changed
    record["outcome"] = compare_stdout(baseline, changed)
    return record


def compare_stderr(baseline, changed):
    """stdout pipe固定でsocket側の再現と対照を確認し、stderrだけの比較を分類する。"""
    if baseline.get("stdoutType") != "pipe" or baseline.get("stderrType") != "socket":
        return "unavailable"
    baseline_outcome = direct_outcome(baseline, "/")
    if baseline_outcome == "not-reproduced" and changed is None:
        return "not-reproduced"
    if baseline_outcome != "uid-map-eperm" or changed is None:
        return "unavailable"
    if (
        changed.get("stdoutType") != "pipe" or changed.get("stderrType") != "pipe"
        or not same_direct_conditions(baseline, changed)
    ):
        return "unavailable"
    return {
        "uid-map-eperm": "stderr-socket-not-required",
        "not-reproduced": "stderr-type-dependent",
    }.get(direct_outcome(changed, "/"), "unavailable")


def measure_stderr(executable, record=None):
    """stdoutをpipeに固定し、stderr socketの再現確認後だけpipeへ変えて途中記録も保持する。"""
    if record is None:
        record = {"measurements": {}, "outcome": "unavailable"}
    baseline = {**measure(executable, "/", stdout_pipe=True), "cwd": "/", "stdoutType": "pipe", "stderrType": "socket"}
    record["measurements"]["socket"] = baseline
    changed = None
    if direct_outcome(baseline, "/") == "uid-map-eperm":
        changed = {**measure(executable, "/", stdout_pipe=True, stderr_pipe=True), "cwd": "/", "stdoutType": "pipe", "stderrType": "pipe"}
        record["measurements"]["pipe"] = changed
    record["outcome"] = compare_stderr(baseline, changed)
    return record


def main_direct(args, comparison):
    """cwdまたは各出力streamの一条件比較を、正式実証と別の記録に保存する。"""
    if len(args) != 2:
        raise ValueError("compare-" + comparison + " SOURCE OUTPUTが必要です")
    root, output = Path(args[0]).resolve(), Path(args[1]).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output / ("namespace-" + comparison + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-" + comparison + "-comparison/v1", "outcome": "unavailable", "measurements": {}}
    try:
        identity = validate(root)
        os.chdir(root)
        before = context()
        python_hash = digest(sys.executable)
        record.update({
            "identity": identity, "controllerHash": digest(SELF),
            "runtimeHash": python_hash,
            "workingDirectories": {"source": str(root), "root": "/"} if comparison == "cwd" else {"socket": "/", "pipe": "/"},
        })
        emit({key: value for key, value in record.items() if key not in ("outcome", "measurements")}, comparison)
        if comparison == "cwd":
            measure_cwd("/usr/bin/unshare", root, record)
        elif comparison == "stdout":
            measure_stdout("/usr/bin/unshare", record)
        else:
            measure_stderr("/usr/bin/unshare", record)
        if (
            context() != before or validate(root) != identity
            or digest(sys.executable) != python_hash
            or next(iter(record["measurements"].values()))["before"] != before
        ):
            raise ValueError("測定中にcaller条件または実行体が変化しました")
    except Exception as error:
        record.update({"outcome": "unavailable", "error": type(error).__name__ + ": " + str(error)})
    finally:
        for name, measurement in record["measurements"].items():
            log_measurement(name, measurement, comparison)
        emit({"outcome": record["outcome"], "error": record.get("error")}, comparison)
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return 1 if record["outcome"] in ("cwd-not-required", "cwd-dependent", "stdout-socket-not-required", "stdout-type-dependent", "stderr-socket-not-required", "stderr-type-dependent") else 0 if record["outcome"] == "not-reproduced" else 2


def main(args):
    """比較方式を選び、起動経路比較はNodeの再現確認後に直接起動する。"""
    if args[:1] == ["compare-cwd"]:
        return main_direct(args[1:], "cwd")
    if args[:1] == ["compare-stdout"]:
        return main_direct(args[1:], "stdout")
    if args[:1] == ["compare-stderr"]:
        return main_direct(args[1:], "stderr")
    if len(args) != 3:
        raise ValueError("SOURCE OUTPUT NODEが必要です")
    root, output, node_path = Path(args[0]).resolve(), Path(args[1]).resolve(), Path(args[2]).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output / "namespace-launch.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-launch-comparison/v1", "outcome": "unavailable", "measurements": {}}
    try:
        identity = validate(root)
        os.chdir(root)
        hashes = {"python": digest(sys.executable), "node": digest(node_path)}
        before = context()
        record.update({"identity": identity, "runtimeHashes": hashes, "controllerHashes": {"python": digest(SELF), "node": digest(NODE_HELPER)}})
        emit({key: record[key] for key in ("schema", "identity", "runtimeHashes", "controllerHashes")})
        node_result = capture(node_path, [str(NODE_HELPER), "measure-environment", str(root), str(output / "launch-node.json"), "empty"], root, dict(os.environ), timeout=40, limit=256 * 1024)
        if node_result.get("error") or node_result["signal"] or node_result["status"] not in (0, 1) or node_result["stderr"]:
            raise ValueError("Node経由の比較前提を確認できません")
        node = json.loads((output / "launch-node.json").read_text())
        record["measurements"]["node"] = node
        log_measurement("node", node)
        if (
            node_outcome(node) not in ("uid-map-eperm", "not-reproduced")
            or node.get("identity") != identity or node["runtime"]["path"] != str(node_path)
            or node["runtime"]["hash"] != hashes["node"] or node["runtime"]["ppid"] != os.getpid()
            or node["before"] != before or node["after"] != before
            or node_result["status"] != (0 if node["outcome"] == "not-reproduced" else 1)
        ):
            raise ValueError("Nodeと共通親の条件が一致しません")
        direct = None
        if node["outcome"] == "uid-map-eperm":
            direct = measure("/usr/bin/unshare", root)
            record["measurements"]["direct"] = direct
            log_measurement("direct", direct)
        record["outcome"] = compare(node, direct)
        if context() != before or validate(root) != identity or any(
            digest(path) != hashes[name] for name, path in (("python", sys.executable), ("node", node_path))
        ):
            raise ValueError("測定中にcaller条件または実行体が変化しました")
    except Exception as error:
        record.update({"outcome": "unavailable", "error": type(error).__name__ + ": " + str(error)})
    finally:
        emit({"outcome": record["outcome"], "error": record.get("error")})
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return 1 if record["outcome"] in ("node-not-required", "node-launch-dependent") else 0 if record["outcome"] == "not-reproduced" else 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError) as error:
        prefix = {"compare-cwd": "cwd", "compare-stdout": "stdout", "compare-stderr": "stderr"}.get(sys.argv[1] if len(sys.argv) > 1 else "", "launch")
        emit({"outcome": "unavailable", "error": type(error).__name__ + ": " + str(error)}, prefix)
        sys.exit(2)
