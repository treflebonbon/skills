"""共通Bash親の下で起動層とstdinの比較を検証・分類する。"""

import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

SELF = Path(__file__).resolve()
PERL_HELPER = SELF.with_suffix(".pl")
DRIVER = SELF.with_suffix(".sh")
PERL = Path("/usr/bin/perl").resolve()
# 通常のinterpreter終了コードと区別する段階間protocol。Bashが最終0/1/2へ変換する。
BASELINE_CLEAR = 41
BASELINE_REPRODUCED = 42
FINAL_REPRODUCED = 43
FINAL_CLEAR = 44
STDIN_READY = 45
_spec = importlib.util.spec_from_file_location("namespace_launch", SELF.with_name("probe-linux-namespace-launch.py"))
launch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(launch)


def ancestry():
    """command lineを読まず、PID世代と共通親を固定する祖先列を取得する。"""
    chain, pid = [], os.getpid()
    for _ in range(64):
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        entry = {
            "pid": pid, "ppid": int(fields[1]), "processGroup": int(fields[2]),
            "session": int(fields[3]), "startTimeTicks": int(fields[19]),
        }
        try:
            entry["path"] = os.readlink(f"/proc/{pid}/exe")
        except OSError as error:
            entry["pathError"] = errno.errorcode.get(error.errno, "ERRNO_" + str(error.errno))
        chain.append(entry)
        if entry["ppid"] == 0:
            return chain
        pid = entry["ppid"]
    raise ValueError("祖先列が64件を超えました")


def measure_python(executable):
    """既存captureで両streamを通常pipeにし、Python測定器自身の祖先を残す。"""
    before = ancestry()
    record = {
        **launch.measure(executable, "/", stdout_pipe=True, stderr_pipe=True),
        "ancestry": before, "cwd": "/", "stdoutType": "pipe", "stderrType": "pipe",
    }
    record["runtime"]["cwd"] = os.getcwd()
    if ancestry() != before:
        raise ValueError("測定中に祖先のidentityが変わりました")
    return record


def measurement_outcome(record, name, common, stdin_type=None):
    """終了済み測定器のraw結果・実行体と、現在も同じ共通親を照合する。"""
    try:
        runtime, chain = record["runtime"], record["ancestry"]
        expected_path = str(Path(sys.executable).resolve()) if name == "python" else str(PERL)
        controller = launch.SELF if name == "python" else PERL_HELPER
        if (
            record.get("error") or name not in ("python", "perl")
            or type(runtime["pid"]) is not int or runtime["pid"] <= 0
            or type(runtime["ppid"]) is not int or runtime["ppid"] <= 0
            or runtime["name"] != name or runtime["path"] != expected_path
            or runtime["hash"] != launch.digest(expected_path)
            or runtime["cwd"] != os.getcwd()
            or record["controllerHash"] != launch.digest(controller)
            or record["cwd"] != "/" or record["stdoutType"] != "pipe" or record["stderrType"] != "pipe"
            or stdin_type is not None and record.get("stdinType") != stdin_type
            or not common or Path(common[0].get("path", "")).name != "bash"
            or len(chain) < 2 or chain[1:] != common
            or chain[0]["pid"] != runtime["pid"] or chain[0]["ppid"] != runtime["ppid"]
            or chain[0].get("path") != expected_path or runtime["ppid"] != common[0]["pid"]
            or chain[0]["processGroup"] != common[0]["processGroup"]
            or chain[0]["session"] != common[0]["session"]
            or type(chain[0]["startTimeTicks"]) is not int or chain[0]["startTimeTicks"] < 0
            or len({row["pid"] for row in chain}) != len(chain)
            or any(chain[index]["ppid"] != chain[index + 1]["pid"] for index in range(len(chain) - 1))
            or chain[-1]["ppid"] != 0
            or record["before"]["uid"] == 0 or record["before"]["euid"] == 0
            or record["unshare"]["hash"] != launch.digest(record["unshare"]["path"])
        ):
            return "unavailable"
        if name == "python":
            if runtime["version"] != platform.python_version():
                return "unavailable"
        elif not re.fullmatch(r"5\.\d+\.\d+", runtime["version"]) or record.get("forkCount") != 6:
            return "unavailable"
        probes = [probe for case in record["cases"] for probe in case["probes"]]
        if len(probes) != 6 or len({probe["pid"] for probe in probes}) != 6:
            return "unavailable"
        if any(probe["pid"] in {row["pid"] for row in chain} for probe in probes):
            return "unavailable"
        result = launch.outcome(record)
        if "outcome" in record and record["outcome"] != result:
            return "unavailable"
        return result
    except (KeyError, IndexError, TypeError, AttributeError, OSError, ValueError):
        return "unavailable"


def compare_parent(baseline, changed, common):
    """Python測定器を含む起動層の要否を、祖先と起動APIを分離せず分類する。"""
    first = measurement_outcome(baseline, "python", common)
    if first == "not-reproduced" and changed is None:
        return "not-reproduced"
    if first != "uid-map-eperm" or changed is None:
        return "unavailable"
    second = measurement_outcome(changed, "perl", common)
    if second == "unavailable":
        return "unavailable"
    if (
        baseline["before"] != changed.get("before") or baseline["unshare"] != changed.get("unshare")
        or all(baseline["ancestry"][0][key] == changed["ancestry"][0][key] for key in ("pid", "startTimeTicks"))
    ):
        return "unavailable"
    return {
        "uid-map-eperm": "python-layer-not-required",
        "not-reproduced": "python-layer-dependent",
    }.get(second, "unavailable")


def compare_stdin(baseline, changed, common):
    """同じPerl親・起動条件を再検証し、devnull stdinの要否だけを分類する。"""
    first = measurement_outcome(baseline, "perl", common, stdin_type="devnull")
    if first == "not-reproduced" and changed is None:
        return "not-reproduced"
    if first != "uid-map-eperm" or changed is None:
        return "unavailable"
    second = measurement_outcome(changed, "perl", common, stdin_type="closed")
    if second == "unavailable":
        return "unavailable"
    if any(baseline[key] != changed[key] for key in ("runtime", "ancestry", "before", "unshare")):
        return "unavailable"
    probes = [probe for record in (baseline, changed) for case in record["cases"] for probe in case["probes"]]
    if len({probe["pid"] for probe in probes}) != 12:
        return "unavailable"
    return {
        "uid-map-eperm": "stdin-devnull-not-required",
        "not-reproduced": "stdin-devnull-dependent",
    }.get(second, "unavailable")


def controller_hashes():
    """共通判定器と両起動経路のsource hashをまとめる。"""
    return {
        "parent": launch.digest(SELF), "python": launch.digest(launch.SELF),
        "perl": launch.digest(PERL_HELPER), "driver": launch.digest(DRIVER),
    }


def validate(root):
    """既存の実VM前提に加え、新しい3測定器のcommit一致とPerlの追加optionを検査する。"""
    identity = launch.validate(root)
    if any(name in os.environ for name in ("PERL5OPT", "PERL5LIB")):
        raise ValueError("起動層・stdin比較では追加Perl optionを指定できません")
    if Path(ancestry()[1].get("path", "")).name != "bash":
        raise ValueError("PythonとPerlは共通Bash親から起動してください")
    for path in (SELF, PERL_HELPER, DRIVER):
        relative = path.relative_to(SELF.parent.parent)
        committed = subprocess.run(
            ["git", "show", identity["sourceSha"] + ":" + relative.as_posix()],
            cwd=root, capture_output=True, check=True, timeout=5,
        ).stdout
        if hashlib.sha256(committed).hexdigest() != launch.digest(path) or launch.digest(root / relative) != launch.digest(path):
            raise ValueError("Python起動層の測定器が対象commitと一致しません")
    return identity


def log_measurement(name, record, prefix="parent"):
    """途中記録も、方式と各probeの上限付き出力を区別して記録する。"""
    if not isinstance(record, dict):
        launch.emit({"parent": name, "error": "測定記録がobjectではありません"}, prefix)
        return
    header = {"parent": name}
    for key in ("runtime", "ancestry", "probeEnvironment", "controllerHash", "unshare", "before", "after", "cwd", "stdoutType", "stderrType", "stdinType", "forkCount", "error"):
        if key in record:
            header[key] = record[key]
    launch.emit(header, prefix)
    cases = record.get("cases", [])
    for case in cases if isinstance(cases, list) else []:
        probes = case.get("probes", []) if isinstance(case, dict) else []
        for probe in probes if isinstance(probes, list) else []:
            if not isinstance(probe, dict):
                continue
            stdout, stderr = probe.get("stdout"), probe.get("stderr")
            stdout = stdout if isinstance(stdout, str) else ""
            stderr = stderr if isinstance(stderr, str) else ""
            launch.emit({
                "parent": name, "stdoutType": record.get("stdoutType"), "stderrType": record.get("stderrType"),
                **({"stdinType": record["stdinType"]} if "stdinType" in record else {}),
                "case": case.get("name"),
                **{key: probe[key] for key in ("argv", "pid", "startedAt", "endedAt", "elapsedMs", "status", "signal", "error", "repetition") if key in probe},
                "stdout": stdout[:1024], "stderr": stderr[:1024],
                "logTruncated": len(stdout) > 1024 or len(stderr) > 1024,
                "outcome": launch.classify(probe),
            }, prefix)


def baseline(root, output):
    """6回のPython測定をwx0600で保存し、正確な再現を専用の段階終了コードで返す。"""
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output / "namespace-parent-python.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-parent-checkpoint/v1", "outcome": "unavailable"}
    try:
        record["identity"] = validate(root)
        os.chdir(root)
        record["controllerHashes"] = controller_hashes()
        record["runtimeHashes"] = {"python": launch.digest(sys.executable), "perl": launch.digest(PERL)}
        record["measurement"] = measure_python("/usr/bin/unshare")
        record["outcome"] = measurement_outcome(record["measurement"], "python", ancestry()[1:])
        if validate(root) != record["identity"] or controller_hashes() != record["controllerHashes"]:
            raise ValueError("測定中にsourceまたは測定器が変化しました")
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        launch.emit({"stage": "python-baseline", "outcome": record["outcome"], "error": record.get("error")}, "parent")
    return BASELINE_REPRODUCED if record["outcome"] == "uid-map-eperm" else BASELINE_CLEAR if record["outcome"] == "not-reproduced" else 2


def finalize(root, output, baseline_status, perl_status):
    """両測定のraw証跡を再検証し、Perl側の途中失敗でもbaselineを保持する。"""
    fd = os.open(output / "namespace-parent.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-parent-comparison/v1", "outcome": "unavailable", "measurements": {}}
    try:
        checkpoint = json.loads((output / "namespace-parent-python.json").read_text())
        if "measurement" in checkpoint:
            record["measurements"]["python"] = checkpoint["measurement"]
        record.update({key: checkpoint[key] for key in ("identity", "controllerHashes", "runtimeHashes") if key in checkpoint})
        perl_file = output / "namespace-parent-perl.json"
        if perl_file.exists():
            record["measurements"]["perl"] = json.loads(perl_file.read_text())
        os.chdir(root)
        identity = validate(root)
        if (
            checkpoint.get("schema") != "linux-namespace-parent-checkpoint/v1"
            or record.get("identity") != identity or record.get("controllerHashes") != controller_hashes()
            or record.get("runtimeHashes") != {"python": launch.digest(sys.executable), "perl": launch.digest(PERL)}
        ):
            raise ValueError("baselineのidentityまたは測定器が一致しません")
        python = record["measurements"]["python"]
        changed = record["measurements"].get("perl")
        common = ancestry()[1:]
        first = measurement_outcome(python, "python", common)
        expected_status = BASELINE_REPRODUCED if first == "uid-map-eperm" else BASELINE_CLEAR if first == "not-reproduced" else 2
        if (
            checkpoint.get("outcome") != first or baseline_status != expected_status
            or (first == "uid-map-eperm" and (perl_status != 0 or changed is None))
            or (first != "uid-map-eperm" and (perl_status != -1 or changed is not None))
            or python["unshare"]["path"] != "/usr/bin/unshare"
            or changed is not None and changed.get("unshare", {}).get("path") != "/usr/bin/unshare"
            or launch.context() != python["before"]
        ):
            raise ValueError("baselineの判定・実行順・caller条件が一致しません")
        record["outcome"] = compare_parent(python, changed, common)
        if validate(root) != identity:
            raise ValueError("判定中にsourceが変化しました")
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        launch.emit({key: value for key, value in record.items() if key not in ("outcome", "measurements")}, "parent")
        for name, measurement in record["measurements"].items():
            log_measurement(name, measurement)
        launch.emit({"outcome": record["outcome"], "error": record.get("error")}, "parent")
    return FINAL_REPRODUCED if record["outcome"] in ("python-layer-not-required", "python-layer-dependent") else FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def stdin_prepare(root, output):
    """namespaceを起動せず前提と版を保存し、Perl測定を専用コードで許可する。"""
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output / "namespace-stdin-checkpoint.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-stdin-checkpoint/v1", "outcome": "unavailable"}
    try:
        record["identity"] = validate(root)
        os.chdir(root)
        record["controllerHashes"] = controller_hashes()
        record["runtimeHashes"] = {"python": launch.digest(sys.executable), "perl": launch.digest(PERL)}
        executable = "/usr/bin/unshare"
        version = launch.capture(executable, ["--version"], "/", {}, limit=64 * 1024, stdout_pipe=True, stderr_pipe=True)
        if version.get("error") or version["signal"] or version["status"] != 0 or version["stderr"] or not version["stdout"].strip():
            raise ValueError("unshareの版を確認できません")
        record["unshare"] = {"path": executable, "hash": launch.digest(executable), "version": version["stdout"].strip()}
        record["context"] = launch.context()
        record["ancestry"] = ancestry()
        if (
            validate(root) != record["identity"] or controller_hashes() != record["controllerHashes"]
            or launch.context() != record["context"] or ancestry() != record["ancestry"]
        ):
            raise ValueError("stdin比較の準備中に条件が変化しました")
        record["outcome"] = "ready"
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        launch.emit({"stage": "stdin-prepare", "outcome": record["outcome"], "error": record.get("error")}, "stdin")
    return STDIN_READY if record["outcome"] == "ready" else 2


def stdin_finalize(root, output, prepare_status, perl_status):
    """同じPerl親の両測定を再検証し、途中記録と準備時の出所を保持する。"""
    fd = os.open(output / "namespace-stdin.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    record = {"schema": "linux-namespace-stdin-comparison/v1", "outcome": "unavailable", "measurements": {}}
    try:
        checkpoint = json.loads((output / "namespace-stdin-checkpoint.json").read_text())
        record.update({key: checkpoint[key] for key in ("identity", "controllerHashes", "runtimeHashes", "unshare") if key in checkpoint})
        perl_file = output / "namespace-stdin-perl.json"
        pair = json.loads(perl_file.read_text()) if perl_file.exists() else {}
        if not isinstance(pair, dict):
            raise ValueError("Perlの比較記録がobjectではありません")
        record["measurements"] = pair.get("measurements", {})
        os.chdir(root)
        identity = validate(root)
        common = ancestry()[1:]
        if (
            checkpoint.get("schema") != "linux-namespace-stdin-checkpoint/v1"
            or checkpoint.get("outcome") != "ready" or prepare_status != STDIN_READY or perl_status != 0
            or pair.get("error") or not isinstance(record["measurements"], dict)
            or set(record["measurements"]) not in ({"devnull"}, {"devnull", "closed"})
            or record.get("identity") != identity or record.get("controllerHashes") != controller_hashes()
            or record.get("runtimeHashes") != {"python": launch.digest(sys.executable), "perl": launch.digest(PERL)}
            or checkpoint.get("ancestry", [])[1:] != common
            or checkpoint.get("context") != launch.context()
            or record["unshare"]["path"] != "/usr/bin/unshare"
            or record["unshare"]["hash"] != launch.digest("/usr/bin/unshare")
        ):
            raise ValueError("stdin比較の準備・測定段階・caller条件が一致しません")
        baseline = record["measurements"]["devnull"]
        changed = record["measurements"].get("closed")
        if baseline.get("before") != checkpoint["context"] or baseline.get("unshare") != record["unshare"]:
            raise ValueError("stdin baselineのcallerまたは実行体が一致しません")
        record["outcome"] = compare_stdin(baseline, changed, common)
        if validate(root) != identity:
            raise ValueError("stdin比較の判定中にsourceが変化しました")
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        launch.emit({key: value for key, value in record.items() if key not in ("outcome", "measurements")}, "stdin")
        measurements = record["measurements"]
        for measurement in measurements.values() if isinstance(measurements, dict) else []:
            log_measurement("perl", measurement, prefix="stdin")
        launch.emit({"outcome": record["outcome"], "error": record.get("error")}, "stdin")
    return FINAL_REPRODUCED if record["outcome"] in ("stdin-devnull-not-required", "stdin-devnull-dependent") else FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def main(args):
    """Bashが指定する段階だけを実行し、自身からPerlを子起動しない。"""
    if not args or args[0] not in ("baseline", "finalize", "stdin-prepare", "stdin-finalize"):
        raise ValueError("baseline / finalize / stdin-prepare / stdin-finalizeを指定してください")
    preparing = args[0] in ("baseline", "stdin-prepare")
    if len(args) != (3 if preparing else 5):
        raise ValueError("段階に対応するSOURCE OUTPUTと終了コードが必要です")
    root, output = Path(args[1]).resolve(), Path(args[2]).resolve()
    if args[0] == "baseline":
        return baseline(root, output)
    if args[0] == "stdin-prepare":
        return stdin_prepare(root, output)
    if args[0] == "stdin-finalize":
        return stdin_finalize(root, output, int(args[3]), int(args[4]))
    return finalize(root, output, int(args[3]), int(args[4]))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError) as error:
        launch.emit({"outcome": "unavailable", "error": type(error).__name__ + ": " + str(error)}, "stdin" if sys.argv[1:2] and sys.argv[1].startswith("stdin-") else "parent")
        sys.exit(2)
