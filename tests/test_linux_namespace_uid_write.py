"""実namespaceを作らず、公開済み基準と直接writeの判定境界を確認する。"""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "development/probe-linux-namespace-uid-write.py"


@unittest.skipUnless(sys.platform == "linux", "Linuxの診断fixture")
class UidWriteTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("uid_write_test", HELPER)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.m.load_comparison()
        self.b = self.m.base
        self.directory = tempfile.TemporaryDirectory(prefix="uid-write-fixture-")
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        rows = json.loads((ROOT / "docs/evidence/linux-namespace-uid/44542479679-1/observations.json").read_text())["jobs"][0]["records"]
        baseline = copy.deepcopy(rows[3])
        baseline["outcome"] = "uid-mapping-reproduced"
        baseline["stages"] = [46, 0, 47, 0]
        baseline["measurements"] = {}
        for name in ("perl", "bash"):
            measurement = copy.deepcopy(next(row for row in rows if row.get("parent") == name and "case" not in row))
            measurement.pop("parent")
            measurement["cases"] = []
            for row in rows:
                if row.get("parent") != name or "case" not in row:
                    continue
                if not measurement["cases"] or measurement["cases"][-1]["name"] != row["case"]:
                    measurement["cases"].append({"name": row["case"], "argv": row["argv"], "probes": []})
                probe = copy.deepcopy(row)
                for key in ("parent", "case", "stdinType", "stdoutType", "stderrType", "logTruncated", "outcome"):
                    probe.pop(key, None)
                measurement["cases"][-1]["probes"].append(probe)
            baseline["measurements"][name] = measurement

        perl, bash = (baseline["measurements"][name] for name in ("perl", "bash"))
        perl["runtime"]["cwd"] = str(ROOT)
        self.common = bash["ancestry"]
        self.snapshot = {"runtime": bash["runtime"], "ancestry": self.common, "context": bash["before"]}
        self.real_digest = self.b.digest
        hashes = {baseline["unshare"]["path"]: baseline["unshare"]["hash"],
                  perl["runtime"]["path"]: perl["runtime"]["hash"],
                  bash["runtime"]["path"]: bash["runtime"]["hash"]}
        def digest(path):
            return hashes[str(path)] if str(path) in hashes else self.real_digest(path)
        # 実VMの条件取得だけを置換し、raw分類と保存処理は本実装を使う。
        for target, name, value in (
            (self.b, "digest", digest), (self.m.launch, "digest", digest),
            (self.b, "validate", lambda root: baseline["identity"]),
            (self.b.parent, "ancestry", lambda: [{"pid": 90001}] + self.common),
            (self.b, "snapshot", lambda version: copy.deepcopy(self.snapshot)),
            (self.m.launch, "context", lambda: copy.deepcopy(bash["before"])),
            (os, "environ", {"PROOF_MODE": "probe-uid-write"}),
            (os, "geteuid", lambda: 1001),
        ):
            mock = patch.object(target, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        baseline["controllerHashes"] = self.b.hashes()
        perl["controllerHash"] = self.b.digest(self.m.parent.PERL_HELPER)
        bash["controllerHash"] = self.b.digest(self.b.DRIVER)
        baseline["uidMappingLookup"]["controllerHashes"] = baseline["controllerHashes"]
        baseline["runtimeHashes"]["python"] = self.b.digest(sys.executable)
        runtime = {"name": "python", "path": str(Path(sys.executable).resolve()),
                   "hash": self.b.digest(sys.executable), "version": sys.version}
        self.checkpoint = {
            "schema": "linux-namespace-bash-checkpoint/v1", "comparisonKind": "uid",
            "comparisonMode": "probe-uid-write", "outcome": "ready",
            "identity": baseline["identity"], "controllerHashes": baseline["controllerHashes"],
            "runtimeHashes": baseline["runtimeHashes"], "bash": self.snapshot,
            "context": bash["before"], "ancestry": [{"pid": 90001}] + self.common,
            "unshare": baseline["unshare"],
        }
        for target, name, value in (
            (self.b, "runtime_hashes", lambda version: baseline["runtimeHashes"]),
            (self.m, "native_runtime", lambda: runtime),
            (self.m, "validate_source", lambda root, checkpoint: {**self.b.hashes(), "direct": self.real_digest(HELPER)}),
        ):
            mock = patch.object(target, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.baseline = baseline
        self.write("namespace-bash-checkpoint.json", self.checkpoint)
        self.write("namespace-bash-before.json", self.snapshot)
        self.write("namespace-bash-perl.json", perl)
        self.write("namespace-bash-gate.json", {
            "schema": "linux-namespace-bash-gate/v1", "outcome": "uid-map-eperm",
            "identity": baseline["identity"], "controllerHashes": baseline["controllerHashes"], "baseline": perl})
        self.write("namespace-uid-name-check.json", baseline["uidMappingLookup"])
        self.write("namespace-uid.json", baseline)
        for case in bash["cases"]:
            for probe in case["probes"]:
                self.write(f'bash-{case["name"]}-{probe["repetition"]}.json', probe)
        self.version = bash["runtime"]["version"]

    def write(self, name, value):
        (self.output / name).write_text(json.dumps(value))

    def captured(self, call):
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            status = call()
        rows = [json.loads(line.split("] ", 1)[1]) for line in stream.getvalue().splitlines()]
        return status, rows

    def gate(self, status=43):
        return self.captured(lambda: self.m.prepare_direct(ROOT, self.output, self.version, status))

    def native(self, variant="write"):
        expected = []
        source = self.baseline["measurements"]["bash"]["cases"][0]["probes"][0]
        for case_index, (name, argv) in enumerate(self.m.direct_scenarios(1001)):
            for repetition in range(1, 4):
                probe = copy.deepcopy(source)
                pid = 20000 + case_index * 3 + repetition
                probe.update(pid=pid, argv=argv, repetition=repetition, executableHash=self.b.digest(sys.executable),
                             executableHashAfter=self.b.digest(sys.executable), startedAt="2026-11-20T00:00:00.000Z",
                             endedAt="2026-11-20T00:00:00.001Z", elapsedMs=1, stdout="", stderr="", status=0, waitStatus=0)
                probe["childBefore"]["pid"] = pid
                steps = [{"operation": "unshare", "outcome": "passed"}]
                result = {"schema": self.m.CHILD_SCHEMA, "mode": name.removeprefix("direct-"),
                          "uid": 1001, "euid": 1001, "steps": steps, "outcome": "passed"}
                if name == "direct-map":
                    steps.append({"operation": "open", "outcome": "passed"})
                    if variant == "passed":
                        steps.append({"operation": "write", "outcome": "passed", "written": 12})
                    else:
                        operation = variant if variant in ("unshare", "open") else "write"
                        steps[:] = steps[:("unshare", "open", "write").index(operation)]
                        steps.append({"operation": operation, "outcome": "failed", "errno": 1, "error": "EPERM"})
                        result["outcome"] = "failed"
                        probe.update(status=1, waitStatus=1)
                probe["stdout"] = json.dumps(result)
                self.write(f"bash-{name}-{repetition}.json", probe)
                expected.append(probe)
        return expected

    def final(self, gate=48, capture=0, baseline=43):
        status, rows = self.captured(lambda: self.m.finalize_direct(
            ROOT, self.output, self.version, baseline, gate, capture))
        return status, json.loads((self.output / "namespace-uid-write.json").read_text()), rows

    def test_exact_write_failure_and_nearest_success(self):
        status, _ = self.gate()
        self.assertEqual(status, 48)
        for variant, outcome in (("write", "direct-write-reproduced"), ("passed", "direct-write-not-reproduced")):
            with self.subTest(variant=variant):
                expected = self.native(variant)
                status, saved, rows = self.final()
                self.assertEqual(status, 43)
                self.assertEqual(saved["outcome"], outcome)
                self.assertEqual(saved["baseline"], self.baseline)
                probes = [probe for case in saved["measurements"]["direct"]["cases"] for probe in case["probes"]]
                self.assertEqual(probes, expected)
                logged = [row for row in rows if "case" in row]
                self.assertEqual(len(logged), 6)
                self.assertEqual([row["outcome"] for row in logged],
                                 ["uid-map-write-eperm" if variant == "write" else "passed"] * 3 + ["passed"] * 3)
                (self.output / "namespace-uid-write.json").unlink()

    def test_other_operation_is_not_uid_map_write_failure(self):
        self.assertEqual(self.gate()[0], 48)
        for variant in ("unshare", "open"):
            with self.subTest(variant=variant):
                self.native(variant)
                status, saved, rows = self.final()
                self.assertEqual(status, 2)
                self.assertIn("write EPERMまたは全成功と成功対照が揃いません", saved["error"])
                self.assertEqual([row["outcome"] for row in rows if row.get("case") == "direct-map"], ["unavailable"] * 3)
                (self.output / "namespace-uid-write.json").unlink()

    def test_gate_rejects_changed_baseline_and_mode_without_extra_calls(self):
        self.assertEqual(self.gate()[0], 48)
        (self.output / "namespace-uid-write-checkpoint.json").unlink()
        for field in ("identity", "lookup", "mode", "baseline"):
            changed = copy.deepcopy(self.baseline)
            if field == "identity":
                changed["identity"] = {}
            elif field == "lookup":
                changed["uidMappingLookup"]["resolvedUid"] = 1002
            elif field == "mode":
                os.environ["PROOF_MODE"] = "probe-uid"
            else:
                changed["measurements"]["bash"]["cases"][1]["probes"][0].update(status=0, waitStatus=0, stderr="")
                for case in changed["measurements"]["bash"]["cases"]:
                    for probe in case["probes"]:
                        self.write(f'bash-{case["name"]}-{probe["repetition"]}.json', probe)
            self.write("namespace-uid.json", changed)
            status, rows = self.gate()
            self.assertEqual(status, 2)
            self.assertEqual(rows[-1]["outcome"], "unavailable")
            self.assertIn({"identity": "出所・段階", "lookup": "名前解決記録が変化", "mode": "段階間のsource", "baseline": "比較条件・raw結果"}[field], rows[-1]["error"])
            (self.output / "namespace-uid-write-checkpoint.json").unlink()
            os.environ["PROOF_MODE"] = "probe-uid-write"
            self.write("namespace-uid.json", self.baseline)

    def test_partial_capture_and_late_context_failure_keep_other_raw(self):
        self.assertEqual(self.gate()[0], 48)
        expected = self.native()
        (self.output / "bash-direct-map-2.json").write_text("{")
        status, saved, rows = self.final()
        self.assertEqual(status, 2)
        self.assertIn("capture・caller・所有PID", saved["error"])
        probes = [probe for case in saved["measurements"]["direct"]["cases"] for probe in case["probes"]]
        self.assertEqual(probes, [probe for probe in expected if probe["pid"] != 20002])
        self.assertEqual(saved["baseline"], self.baseline)
        logged = [row for row in rows if "case" in row]
        self.assertEqual([row["pid"] for row in logged], [probe["pid"] for probe in probes])
        for raw, row in zip(probes, logged):
            self.assertEqual({key: row[key] for key in raw}, raw)
        (self.output / "namespace-uid-write.json").unlink()
        self.native()
        def broken_snapshot(version):
            raise ValueError("public-fixture-snapshot-failed")
        with patch.object(self.b, "snapshot", broken_snapshot):
            status, saved, rows = self.final()
        self.assertEqual(status, 2)
        self.assertIn("public-fixture-snapshot-failed", saved["error"])
        self.assertEqual([probe for case in saved["measurements"]["direct"]["cases"] for probe in case["probes"]], expected)
        self.assertEqual(saved["baseline"], self.baseline)

    def test_direct_rejects_changed_capture_and_raw_result(self):
        self.assertEqual(self.gate()[0], 48)
        for variant in ("mixed", "control", "errno", "short", "cleanup", "caller", "owner", "hash", "pid", "time"):
            with self.subTest(variant=variant):
                self.native()
                path = self.output / ("bash-direct-control-1.json" if variant == "control" else "bash-direct-map-1.json")
                probe = json.loads(path.read_text())
                result = json.loads(probe["stdout"])
                if variant == "mixed":
                    result.update(outcome="passed", steps=[
                        {"operation": "unshare", "outcome": "passed"},
                        {"operation": "open", "outcome": "passed"},
                        {"operation": "write", "outcome": "passed", "written": 12}])
                    probe.update(status=0, waitStatus=0)
                elif variant == "control":
                    result.update(outcome="failed", steps=[{"operation": "unshare", "outcome": "failed", "errno": 1, "error": "EPERM"}])
                    probe.update(status=1, waitStatus=1)
                elif variant == "errno":
                    result["steps"][-1].update(errno=13, error="EACCES")
                elif variant == "short":
                    result.update(outcome="unavailable", error="UID-mapのwriteが完了していません")
                    probe.update(status=2, waitStatus=2)
                elif variant == "cleanup":
                    result.update(outcome="unavailable", cleanupError="EIO")
                    probe.update(status=2, waitStatus=2)
                elif variant == "caller":
                    result["euid"] = 1002
                elif variant == "owner":
                    probe["ownerPid"] += 1
                elif variant == "hash":
                    probe["executableHashAfter"] = "0" * 64
                elif variant == "pid":
                    probe["pid"] = self.baseline["measurements"]["perl"]["cases"][0]["probes"][0]["pid"]
                    probe["childBefore"]["pid"] = probe["pid"]
                elif variant == "time":
                    probe["startedAt"] = "2026-11-19T00:00:00.000Z"
                probe["stdout"] = json.dumps(result)
                path.write_text(json.dumps(probe))
                status, saved, _ = self.final()
                self.assertEqual(status, 2)
                reason = ("capture・caller・所有PID" if variant in ("owner", "hash") else
                          "probe PIDが重複" if variant == "pid" else
                          "測定順序・時刻" if variant == "time" else
                          "write EPERMまたは全成功と成功対照が揃いません")
                self.assertIn(reason, saved["error"])
                (self.output / "namespace-uid-write.json").unlink()

    def test_clear_baseline_skips_direct_probes(self):
        clear = copy.deepcopy(self.baseline)
        clear["outcome"] = "not-reproduced"
        clear["stages"] = [46, 0, 44, -1]
        clear["measurements"].pop("bash")
        clear.pop("uidMappingLookup")
        for case in clear["measurements"]["perl"]["cases"]:
            for probe in case["probes"]:
                probe.update(status=0, stderr="")
        self.write("namespace-uid.json", clear)
        self.write("namespace-bash-perl.json", clear["measurements"]["perl"])
        self.write("namespace-bash-gate.json", {
            "schema": "linux-namespace-bash-gate/v1", "outcome": "not-reproduced",
            "identity": clear["identity"], "controllerHashes": clear["controllerHashes"],
            "baseline": clear["measurements"]["perl"]})
        (self.output / "namespace-bash-before.json").unlink()
        self.assertEqual(self.gate(status=44)[0], 44)
        status, saved, _ = self.final(gate=44, capture=-1, baseline=44)
        self.assertEqual(status, 44)
        self.assertEqual(saved["outcome"], "not-reproduced")
        self.assertEqual(saved["measurements"], {})
        self.assertEqual(saved["baseline"], clear)


if __name__ == "__main__":
    unittest.main()
