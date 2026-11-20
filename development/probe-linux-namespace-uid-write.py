#!/usr/bin/env python3
"""UID-mapの直接書込みを、同じBashで再現した基準と比較する診断。"""

import errno
import json
import os
import sys


CHILD_SCHEMA = "linux-namespace-uid-write-child/v1"


def read_apparmor_label():
    """許可したAppArmorラベルだけを後続の比較へ渡す。"""
    try:
        with open("/proc/self/attr/apparmor/current", "rb", buffering=0) as attribute:
            raw = attribute.read(256)
    except OSError as error:
        return {"status": "unavailable", "error": errno.errorcode.get(error.errno, "UNKNOWN")}
    if len(raw) == 256:
        return {"status": "truncated"}
    label = raw.rstrip(b"\n\0")
    if label in (b"unconfined", b"unprivileged_userns", b"unprivileged_userns (enforce)",
                 b"unprivileged_userns (complain)", b"unprivileged_userns (kill)"):
        return {"status": "observed", "label": label.decode("ascii")}
    return {"status": "other" if label else "empty"}


def child(mode, uid, observe_label=False):
    record = {"schema": CHILD_SCHEMA, "mode": mode, "uid": os.getuid(),
              "euid": os.geteuid(), "steps": [], "outcome": "unavailable"}
    if (mode not in ("map", "control") or sys.platform != "linux"
            or not hasattr(os, "unshare") or not hasattr(os, "CLONE_NEWUSER")
            or uid <= 0 or record["uid"] != uid or record["euid"] != uid
            or os.getcwd() != "/"):
        record["error"] = "直接UID-map probeのcaller条件が不正です"
        return record, 2

    fd = None
    status = 0
    operation = "environment"
    try:
        # Pythonのlocale coercionが追加する既知のキーだけを消す。
        os.unsetenv("LC_CTYPE")
        operation = "unshare"
        os.unshare(os.CLONE_NEWUSER)
        record["steps"].append({"operation": operation, "outcome": "passed"})
        if mode == "map":
            operation = "open"
            fd = os.open("/proc/self/uid_map", os.O_WRONLY | os.O_CLOEXEC)
            record["steps"].append({"operation": operation, "outcome": "passed"})
            operation = "write"
            payload = f"{uid} {uid} 1\n".encode("ascii")
            written = os.write(fd, payload)
            record["steps"].append({"operation": operation, "outcome": "passed",
                                    "written": written})
            if written != len(payload):
                record["error"] = "UID-mapのwriteが完了していません"
                status = 2
        record["outcome"] = "passed" if status == 0 else "unavailable"
    except OSError as error:
        record["steps"].append({"operation": operation, "outcome": "failed",
                                "errno": error.errno,
                                "error": errno.errorcode.get(error.errno, "UNKNOWN")})
        record["outcome"] = "failed"
        status = 1
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError as error:
                record["cleanupError"] = errno.errorcode.get(error.errno, "UNKNOWN")
                record["outcome"] = "unavailable"
                status = 2
    if observe_label and (status == 0 or
            (status == 1 and operation == "write" and record["steps"][-1]["errno"] == errno.EPERM)):
        record["apparmor"] = read_apparmor_label()
    return record, status



# child経路では標準ライブラリ以外の測定器を読み込まない。
def load_comparison():
    global base, parent, launch
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "uid_write_baseline", Path(__file__).resolve().with_name("probe-linux-namespace-bash.py"))
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    parent, launch = base.parent, base.launch


def native_runtime():
    from pathlib import Path
    if sys.version_info < (3, 12) or not hasattr(os, "unshare") or not hasattr(os, "CLONE_NEWUSER"):
        raise ValueError("直接UID-map比較にはPython 3.12以上のos.unshareが必要です")
    path = str(Path(sys.executable).resolve())
    if any(char in path for char in "\t\r\n"):
        raise ValueError("Python実行体pathが不正です")
    return {"name": "python", "path": path, "hash": base.digest(path), "version": sys.version}


def validate_source(root, checkpoint):
    from pathlib import Path
    path = Path(__file__).resolve()
    relative = path.relative_to(path.parent.parent)
    identity = base.validate(root)
    committed = parent.subprocess.run(
        ["git", "show", identity["sourceSha"] + ":" + relative.as_posix()],
        cwd=root, capture_output=True, check=True, timeout=5,
    ).stdout
    if (identity != checkpoint["identity"]
            or base.hashlib.sha256(committed).hexdigest() != base.digest(path)
            or base.digest(root / relative) != base.digest(path)):
        raise ValueError("直接UID-map比較のsourceがcommitと一致しません")
    return {**base.hashes(), "direct": base.digest(path)}


def check_baseline(root, output, version, record, status):
    checkpoint = base.check_checkpoint(root, output, version)
    if os.environ.get("PROOF_MODE") != "probe-uid-write":
        raise ValueError("直接UID-map比較の方式が一致しません")
    if (record.get("schema") != "linux-namespace-uid-comparison/v1" or record.get("error")
            or any(record.get(key) != checkpoint[key]
                   for key in ("identity", "controllerHashes", "runtimeHashes", "unshare"))
            or not isinstance(record.get("stages"), list) or len(record["stages"]) != 4
            or any(type(value) is not int for value in record["stages"])):
        raise ValueError("直接比較のUID基準の出所・段階が一致しません")
    if record["measurements"]["perl"] != json.loads((output / "namespace-bash-perl.json").read_text()):
        raise ValueError("直接比較のPerl基準が変化しました")
    bash_record = base.load_bash(output, checkpoint)
    if bash_record is not None:
        bash_record["after"] = base.snapshot(version)["context"]
        if (record["measurements"].get("bash") != bash_record
                or record.get("uidMappingLookup") != json.loads((output / "namespace-uid-name-check.json").read_text())):
            raise ValueError("直接比較のBash基準または名前解決記録が変化しました")
    elif "bash" in record["measurements"]:
        raise ValueError("直接比較のBash基準が不足しています")
    gate = json.loads((output / "namespace-bash-gate.json").read_text())
    outcome = base.comparison_result(record, checkpoint, gate, parent.ancestry()[1:], record["stages"])
    if (record.get("outcome") != outcome
            or not (outcome == "uid-mapping-reproduced" and status == parent.FINAL_REPRODUCED
                    or outcome == "not-reproduced" and status == parent.FINAL_CLEAR)):
        raise ValueError("同じVMのUID-only失敗と成功対照を再現できません")
    return checkpoint, outcome


def prepare_direct(root, output, version, baseline_status):
    record = {"schema": "linux-namespace-uid-write-checkpoint/v1", "outcome": "unavailable"}
    try:
        record["baseline"] = json.loads((output / "namespace-uid.json").read_text())
        checkpoint, outcome = check_baseline(root, output, version, record["baseline"], baseline_status)
        record.update(identity=checkpoint["identity"], controllerHashes=validate_source(root, checkpoint),
                      runtime=native_runtime(), baselineStatus=baseline_status)
        record["outcome"] = "ready" if outcome == "uid-mapping-reproduced" else "not-reproduced"
    except Exception as error:
        record["error"] = type(error).__name__ + ": " + str(error)
    finally:
        base.save(output / "namespace-uid-write-checkpoint.json", record)
        launch.emit({"stage": "direct-gate", **{key: value for key, value in record.items()
                                             if key != "baseline"}}, "uid-write")
    return 48 if record["outcome"] == "ready" else parent.FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def direct_scenarios(uid, observe_label=False):
    from pathlib import Path
    options = ["--apparmor-label"] if observe_label else []
    return [("direct-" + mode, ["-I", str(Path(__file__).resolve()), "child", mode, str(uid), *options])
            for mode in ("map", "control")]


def classify_direct(probe, uid, mode=None, observe_label=False):
    try:
        if mode is None:
            argv = probe.get("argv", [])
            if not isinstance(argv, list) or len(argv) != (6 if observe_label else 5):
                return "unavailable"
            mode = argv[3]
        if (probe.get("error") or probe.get("cleanupError") or probe.get("logTruncated")
                or probe.get("signal") is not None or probe["stderr"] != ""
                or type(probe["status"]) is not int or probe["argv"] != dict(direct_scenarios(uid, observe_label))["direct-" + mode]):
            return "unavailable"
        result = json.loads(probe["stdout"])
        if (not isinstance(result, dict) or result.get("schema") != CHILD_SCHEMA
                or result.get("mode") != mode or result.get("error") or result.get("cleanupError")
                or type(result.get("uid")) is not int or result["uid"] != uid
                or type(result.get("euid")) is not int or result["euid"] != uid):
            return "unavailable"
        steps = result.get("steps")
        if (not isinstance(steps, list) or any(not isinstance(step, dict)
                or any(key in step and type(step[key]) is not int for key in ("errno", "written"))
                for step in steps)):
            return "unavailable"
        passed = [{"operation": "unshare", "outcome": "passed"}]
        if mode == "map":
            passed += [{"operation": "open", "outcome": "passed"},
                       {"operation": "write", "outcome": "passed", "written": len(f"{uid} {uid} 1\n")}]
        if result.get("steps") == passed and result.get("outcome") == "passed" and probe["status"] == 0:
            return "passed"
        failed = passed[:2] + [{"operation": "write", "outcome": "failed", "errno": errno.EPERM, "error": "EPERM"}]
        if mode == "map" and result.get("steps") == failed and result.get("outcome") == "failed" and probe["status"] == 1:
            return "uid-map-write-eperm"
    except (KeyError, TypeError, ValueError, AttributeError):
        pass
    return "unavailable"


def direct_outcome(measurement, checkpoint, baseline, observe_label):
    try:
        uid = checkpoint["context"]["euid"]
        scenarios = direct_scenarios(uid, observe_label)
        if not base.bash_capture_valid(measurement, parent.ancestry()[1:], checkpoint, scenarios, native_runtime()["hash"]):
            raise ValueError("直接UID-mapのcapture・caller・所有PIDが一致しません")
        baseline_probes = [probe for item in baseline["measurements"].values()
                           for case in item["cases"] for probe in case["probes"]]
        probes = [probe for case in measurement["cases"] for probe in case["probes"]]
        if len({probe["pid"] for probe in baseline_probes + probes}) != 21:
            raise ValueError("基準と直接UID-mapのprobe PIDが重複しています")
        latest = max(base.datetime.datetime.fromisoformat(probe["endedAt"]) for probe in baseline_probes)
        outcomes = []
        for case, (name, argv) in zip(measurement["cases"], scenarios):
            if case["name"] != name or case["argv"] != argv or len(case["probes"]) != 3:
                raise ValueError("直接UID-mapのcase・argv・回数が一致しません")
            modes = []
            for repetition, probe in enumerate(case["probes"], 1):
                start = base.datetime.datetime.fromisoformat(probe["startedAt"])
                end = base.datetime.datetime.fromisoformat(probe["endedAt"])
                elapsed = probe["elapsedMs"]
                if (probe.get("repetition") != repetition or start < latest or end < start
                        or type(elapsed) not in (int, float) or not base.math.isfinite(elapsed) or not 0 <= elapsed <= 5000):
                    raise ValueError("直接UID-mapの測定順序・時刻が不正です")
                modes.append(classify_direct(probe, uid, name.removeprefix("direct-"), observe_label))
            outcomes.append(modes)
        if outcomes[1] == ["passed"] * 3:
            if outcomes[0] == ["uid-map-write-eperm"] * 3:
                return "direct-write-reproduced"
            if outcomes[0] == ["passed"] * 3:
                return "direct-write-not-reproduced"
        raise ValueError("直接UID-mapのwrite EPERMまたは全成功と成功対照が揃いません")
    except (KeyError, TypeError, ValueError, AttributeError, OSError) as error:
        raise ValueError(str(error)) from None


def finalize_direct(root, output, version, baseline_status, gate_status, capture_status):
    record = {"schema": "linux-namespace-uid-write-comparison/v1", "outcome": "unavailable", "measurements": {},
              "stages": [baseline_status, gate_status, capture_status]}
    observe_label = os.environ.get("PROOF_UID_WRITE_LABEL") == "true"
    if observe_label:
        record["apparmorLabelRequested"] = True
    try:
        # rawを先に保持し、checkpointやsourceの後続検査に失敗しても失わない。
        record["baseline"] = json.loads((output / "namespace-uid.json").read_text())
        checkpoint = json.loads((output / "namespace-bash-checkpoint.json").read_text())
        direct = base.load_bash(output, checkpoint, direct_scenarios(checkpoint["context"]["euid"], observe_label))
        if direct is not None:
            record["measurements"]["direct"] = direct
        saved = json.loads((output / "namespace-uid-write-checkpoint.json").read_text())
        if direct is not None:
            direct["after"] = base.snapshot(version)["context"]
        verified, baseline_outcome = check_baseline(root, output, version, record["baseline"], baseline_status)
        record.update(identity=verified["identity"], controllerHashes=validate_source(root, verified), runtime=native_runtime())
        if (saved.get("schema") != "linux-namespace-uid-write-checkpoint/v1"
                or saved.get("baseline") != record["baseline"] or saved.get("baselineStatus") != baseline_status
                or any(saved.get(key) != record[key] for key in ("identity", "controllerHashes", "runtime"))):
            raise ValueError("直接UID-mapの段階間で基準・source・Pythonが変化しました")
        if (baseline_outcome == "not-reproduced" and saved.get("outcome") == "not-reproduced"
                and gate_status == parent.FINAL_CLEAR and capture_status == -1
                and (direct is None or direct["forkCount"] == 0)):
            record["outcome"] = "not-reproduced"
        elif (baseline_outcome == "uid-mapping-reproduced" and saved.get("outcome") == "ready"
              and gate_status == 48 and capture_status == 0 and direct is not None):
            record["outcome"] = direct_outcome(direct, verified, record["baseline"], observe_label)
        else:
            raise ValueError("直接UID-mapの比較段階が成立しません")
        if validate_source(root, verified) != record["controllerHashes"] or native_runtime() != record["runtime"]:
            raise ValueError("直接UID-mapの最終判定中にsource・Pythonが変化しました")
    except Exception as error:
        record.update(outcome="unavailable", error=type(error).__name__ + ": " + str(error))
    finally:
        base.save(output / "namespace-uid-write.json", record)
        launch.emit({key: value for key, value in record.items()
                     if key not in ("baseline", "measurements", "outcome")}, "uid-write")
        for name, measurement in record["measurements"].items():
            uid = record.get("baseline", {}).get("uidMappingLookup", {}).get("requestedUid", -1)
            parent.log_measurement(name, measurement, prefix="uid-write",
                                   classifier=lambda probe: classify_direct(probe, uid, observe_label=observe_label))
        launch.emit({"outcome": record["outcome"], "error": record.get("error")}, "uid-write")
    return parent.FINAL_REPRODUCED if record["outcome"] in ("direct-write-reproduced", "direct-write-not-reproduced") else parent.FINAL_CLEAR if record["outcome"] == "not-reproduced" else 2


def main(args):
    if args and args[0] == "child":
        if len(args) not in (3, 4) or (len(args) == 4 and args[3] != "--apparmor-label"):
            raise ValueError("直接UID-map probeの引数が不正です")
        result, status = child(args[1], int(args[2]), len(args) == 4)
        print(json.dumps(result, ensure_ascii=False))
        return status
    from pathlib import Path
    load_comparison()
    stage, root, output, version = args[0], Path(args[1]).resolve(), Path(args[2]).resolve(), args[3]
    if stage == "gate":
        return prepare_direct(root, output, version, int(args[4]))
    if stage == "settings":
        saved = json.loads((output / "namespace-uid-write-checkpoint.json").read_text())
        checkpoint, _ = check_baseline(root, output, version, saved["baseline"], saved["baselineStatus"])
        if (saved.get("outcome") != "ready" or saved.get("controllerHashes") != validate_source(root, checkpoint)
                or saved.get("runtime") != native_runtime()):
            raise ValueError("直接UID-mapの起動は許可されていません")
        print(saved["runtime"]["path"] + "\t" + saved["runtime"]["hash"])
        return 0
    if stage == "finalize":
        return finalize_direct(root, output, version, *map(int, args[4:7]))
    raise ValueError("直接UID-mapの比較段階が不正です")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print("直接UID-map補助: " + type(error).__name__, file=sys.stderr)
        sys.exit(2)
