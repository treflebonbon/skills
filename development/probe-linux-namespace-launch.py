"""Node測定器を外した起動経路だけを比較する開発用診断。"""

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
        "environment": {
            key: os.environ.get(key) for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")
        },
    }


def capture(executable, argv, root, environment, timeout=5, limit=32 * 1024 * 1024):
    """Nodeと同種の匿名socketを上限内で取得し、超過時は所有する子をSIGKILLする。"""
    started = time.monotonic()
    result = {
        "argv": argv, "pid": 0,
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "status": None, "signal": None,
    }
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    child = None
    sockets = {}
    try:
        for name in buffers:
            sockets[name] = socket.socketpair()
        with open(os.devnull, "rb") as null_input:
            child = subprocess.Popen(
                [str(executable), *argv], cwd=root, env=environment,
                stdin=null_input, stdout=sockets["stdout"][1], stderr=sockets["stderr"][1],
            )
        result["pid"] = child.pid
        for reader, writer in sockets.values():
            writer.close()
        with selectors.DefaultSelector() as selector:
            for name, (reader, _) in sockets.items():
                selector.register(reader, selectors.EVENT_READ, name)
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
        for pair in sockets.values():
            for stream in pair:
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


def measure(executable, root):
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
            case["probes"].append({"repetition": repetition, **capture(executable, argv, root, {})})
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


def emit(value):
    """新しい比較に限定したJSON行を出力する。"""
    print("[DEBUG-ns-launch] " + json.dumps(value, ensure_ascii=False), flush=True)


def log_measurement(name, record):
    """caller条件と各probeの出力をstreamごと1024文字まで記録する。"""
    emit({"launch": name, **{key: record[key] for key in ("runtime", "probeEnvironment", "controllerHash", "unshare", "before", "after", "outcome")}})
    for case in record["cases"]:
        for probe in case["probes"]:
            emit({
                "launch": name, "case": case["name"], **probe,
                "stdout": probe["stdout"][:1024], "stderr": probe["stderr"][:1024],
                "logTruncated": len(probe["stdout"]) > 1024 or len(probe["stderr"]) > 1024,
                "outcome": classify(probe),
            })


def main(args):
    """Nodeで再現を確認した後にだけ直接起動を測り、正式実証と別に保存する。"""
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
        emit({"outcome": "unavailable", "error": type(error).__name__ + ": " + str(error)})
        sys.exit(2)
