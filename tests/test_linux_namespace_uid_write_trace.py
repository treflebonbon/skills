"""Kprobeの選択、トレースの照合と後片付けをfixtureで検査する。"""

import errno
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "development/probe-linux-namespace-uid-write-trace.py"
SPEC = importlib.util.spec_from_file_location("uid_map_trace", SOURCE)
TRACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRACE)


def trace_text(events, written=None):
    """tracefsが表示する件数とPIDを含むfixtureを返す。"""
    count = len(events)
    header = f"# entries-in-buffer/entries-written: {count}/{count if written is None else written} #P:4\n"
    return header + "\n".join(
        f"python3-{pid} [001] d... 123.45678{index}: uidmap_123_1_map:{name}: (masked) {value}"
        for index, (pid, name, value) in enumerate(events)
    )


class UidMapTraceTests(unittest.TestCase):
    events = [
        (1234, "write_enter", ""),
        (1234, "file_enter", "cap=21"),
        (1234, "apparmor_enter", "cap=21"),
        (1234, "apparmor_exit", "ret=-1"),
        (1234, "file_exit", "ret=0x0"),
        (1234, "write_exit", "ret=-1"),
    ]

    def test_selected_write_keeps_only_known_fields(self):
        result = TRACE.parse_trace(trace_text(self.events), 1234, "map")
        self.assertEqual(result["status"], "observed")
        self.assertEqual([row["event"] for row in result["events"]], [event[1] for event in self.events])
        self.assertEqual([row.get("ret") for row in result["events"]], [None, None, None, -1, 0, -1])
        self.assertEqual([row.get("cap") for row in result["events"]], [None, 21, 21, None, None, None])
        self.assertNotIn("masked", json.dumps(result))

    def test_no_uid_map_write_on_control(self):
        self.assertEqual(TRACE.parse_trace(trace_text([]), 1234, "control"),
                         {"status": "no-uid-map-write", "events": []})
        with self.assertRaisesRegex(TRACE.TraceError, "一対一"):
            TRACE.parse_trace(trace_text(self.events), 1234, "control")
        with self.assertRaisesRegex(TRACE.TraceError, "一対一"):
            TRACE.parse_trace(trace_text([]), 1234, "map")

    def test_rejects_other_pid_loss_and_unbalanced_hooks(self):
        for raw, reason in (
            (trace_text(self.events, written=7), "欠落"),
            (trace_text([(1235, *self.events[0][1:]), *self.events[1:]]), "PID"),
            (trace_text(self.events[:3] + self.events[4:]), "能力検査の開始と戻り値"),
            (trace_text(self.events[:2] + [(1234, "apparmor_enter", "cap=21 cap=21")] + self.events[3:]), "能力番号"),
            (trace_text([self.events[0], self.events[-1]]), "CAP_SYS_ADMIN"),
            (trace_text(self.events[:2] + self.events[4:]), "CAP_SYS_ADMIN"),
            (trace_text(self.events[:2] + [(1234, "apparmor_enter", "cap=7")] + self.events[3:]), "CAP_SYS_ADMIN"),
        ):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(TRACE.TraceError, reason):
                    TRACE.parse_trace(raw, 1234, "map")

    def test_append_preserves_preexisting_registered_events(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(TRACE, "TRACEFS", Path(tmp)):
            registry = Path(tmp) / "kprobe_events"
            registry.write_text("p:existing/event existing_func\n")
            with mock.patch.object(TRACE.os, "open", wraps=TRACE.os.open) as opened:
                TRACE.kprobe_command("p:uidmap_123_1_map/write_enter proc_uid_map_write")
                TRACE.kprobe_command("-:uidmap_123_1_map/write_enter")
            flags = TRACE.os.O_WRONLY | TRACE.os.O_APPEND | TRACE.os.O_CLOEXEC
            self.assertEqual(opened.call_args_list, [mock.call(registry, flags)] * 2)
            self.assertEqual(registry.read_text().splitlines(), [
                "p:existing/event existing_func",
                "p:uidmap_123_1_map/write_enter proc_uid_map_write",
                "-:uidmap_123_1_map/write_enter",
            ])

    def test_arm_filters_before_enabling_and_checks_child_first(self):
        with (mock.patch.object(TRACE, "require_probe_child") as child,
              mock.patch.object(TRACE, "kprobe_command") as register,
              mock.patch.object(Path, "exists", return_value=False),
              mock.patch.object(Path, "mkdir"),
              mock.patch.object(Path, "write_text", autospec=True) as write):
            order = mock.Mock()
            order.attach_mock(child, "child")
            order.attach_mock(register, "register")
            order.attach_mock(write, "write")
            group = TRACE.group_name("123", "1", "map")
            TRACE.arm_trace(group, 1000, 1234, 1001)
            self.assertEqual(order.mock_calls[0], mock.call.child(1000, 1234, 1001))
            self.assertEqual(register.call_count, 6)
            for event in TRACE.EVENTS:
                base = TRACE.TRACEFS / "instances" / group / "events" / group / event
                filtered = mock.call.write(base / "filter", "common_pid == 1234\n", encoding="ascii")
                enabled = mock.call.write(base / "enable", "1\n", encoding="ascii")
                self.assertLess(order.mock_calls.index(filtered), order.mock_calls.index(enabled))
            self.assertEqual(write.call_args.args[1], "1\n")
            checked_calls = len(order.mock_calls)
            child.side_effect = TRACE.TraceError("待機中の非root所有子を照合できません")
            with self.assertRaisesRegex(TRACE.TraceError, "待機中の非root所有子"):
                TRACE.arm_trace(group, 1000, 1234, 1001)
            self.assertEqual(order.mock_calls[checked_calls:], [mock.call.child(1000, 1234, 1001)])

    def test_arm_rolls_back_partial_registration(self):
        with (mock.patch.object(TRACE, "require_probe_child"),
              mock.patch.object(TRACE, "kprobe_command", side_effect=[None, OSError(errno.EINVAL, "fixture")]),
              mock.patch.object(Path, "exists", return_value=False),
              mock.patch.object(Path, "mkdir"),
              mock.patch.object(Path, "write_text"),
              mock.patch.object(TRACE, "remove_trace") as cleanup):
            group = TRACE.group_name("123", "1", "control")
            with self.assertRaisesRegex(TRACE.TraceError, r"kprobe_events \(write_exit\) が EINVAL"):
                TRACE.arm_trace(group, 1000, 1234, 1001)
            cleanup.assert_called_once_with(group)

    def test_group_name_rejects_unexpected_identifiers(self):
        self.assertEqual(TRACE.group_name("123", "1", "control"), "uidmap_123_1_control")
        for args in (("../123", "1", "map"), ("123", "", "map"), ("123", "1", "other")):
            with self.assertRaisesRegex(TRACE.TraceError, "run・attempt・役割"):
                TRACE.group_name(*args)

    def test_workflow_trace_input_and_cleanup(self):
        workflow = (SOURCE.parents[1] / ".github/workflows/linux-process-proof.yml").read_text()
        guard = workflow.split("- name: 入力 SHA と方式を検査\n", 1)[1].split("        run: |\n", 1)[1].split("      - uses:", 1)[0]
        for mode, audit, label, allowed in (
            ("probe-uid-write", "false", "false", True),
            ("probe-uid-write", "true", "false", False),
            ("probe-uid-write", "false", "true", False),
            ("proof", "false", "false", False),
        ):
            env = {
                "PROOF_SOURCE_SHA": "a" * 40, "PROOF_MODE": mode, "UID_WRITE_TRACE": "true",
                "UID_WRITE_AUDIT": audit, "UID_WRITE_LABEL": label,
            }
            result = subprocess.run(["bash", "--noprofile", "--norc", "-e", "-c", guard],
                                    env=env, capture_output=True, text=True, timeout=5, check=False)
            self.assertEqual(result.returncode, 0 if allowed else 2)
            self.assertEqual(result.stderr, "" if allowed else
                             "kernelトレースにはprobe-uid-writeと監査・ラベル観測の無効化が必要です\n")
        cleanup = workflow.split("- name: UID-map専用カーネルトレースを解除\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("if: always() && steps.uid_trace_check.outcome == 'success'", cleanup)
        self.assertIn('cleanup "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"', cleanup)
        self.assertIn("if: always() && !inputs.uid_write_audit && !inputs.uid_write_trace", workflow)


if __name__ == "__main__":
    unittest.main()
