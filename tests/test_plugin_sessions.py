import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "development/plugin_sessions.py"
SKILL = "/installed/plugin/skills/rop/SKILL.md"
RESOURCE = "/installed/plugin/skills/rop/references/rust.md"
NAMESPACE = "treflebonbon-skills:rop"
AGY_INIT = {"event": "init", "conversation_id": "agy-session"}


def agy_read(path):
    return {
        "event": "step_update",
        "step_update": {
            "state": "DONE",
            "step_type": "tool",
            "tool_info": {
                "name": "read_file",
                "parameters": {"Path": path},
                "output": "20 lines, 500 bytes",
            },
        },
    }


def native_events(runtime):
    """Return literal native event shapes at the CLI process boundary."""
    if runtime == "claude":
        events = [{"type": "system", "subtype": "init", "skills": [NAMESPACE], "session_id": "claude-session"}]
        for index, path in enumerate((SKILL, RESOURCE)):
            events += [
                {"type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": str(index), "name": "Read",
                    "input": {"file_path": path},
                }]}},
                {"type": "user", "message": {"content": [{
                    "type": "tool_result", "tool_use_id": str(index), "content": "public skill",
                }]}},
            ]
        return events + [{"type": "result", "subtype": "success", "is_error": False}]
    if runtime == "codex":
        return [{"type": "thread.started", "thread_id": "codex-session"}] + [
            {"type": "item.completed", "item": {
                "type": "command_execution", "command": f"/bin/bash -lc 'cat -- {path}'",
                "exit_code": 0, "aggregated_output": "public skill",
            }} for path in (SKILL, RESOURCE)
        ] + [{"type": "turn.completed"}]
    return [AGY_INIT, agy_read(SKILL), agy_read(RESOURCE),
            {"event": "result", "result": {"status": "SUCCESS"}}]


def native_inventory(runtime):
    """Model the two native inventory formats without importing the checker."""
    if runtime == "codex":
        return {"installed": [{"name": "treflebonbon-skills", "installed": True,
                               "enabled": True, "version": "0.2.8"}]}
    return {"status": "SUCCESS", "response": NAMESPACE + "\tROP"}


class PluginSessionCliTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def check(self, events, *, inventory=None, runtime="agy", exit_code=0, command=None):
        """Submit an on-disk case through the same public check CLI as operators."""
        case = self.base / "case"
        case.mkdir(exist_ok=True)
        log = case / "events.jsonl"
        log.write_text("".join(json.dumps(e) + "\n" for e in events))
        (self.base / "inventory.json").write_text(json.dumps(inventory or {}))
        invocation = ("$" if runtime == "codex" else "/") + NAMESPACE + " 受入確認"
        native_command = [runtime, "exec", "--ephemeral", invocation] if runtime == "codex" else [runtime, "-p", invocation]
        (case / "process.json").write_text(json.dumps({
            "runtime": runtime, "skill": "rop", "command": command or native_command, "exit_code": exit_code,
        }))
        result = subprocess.run([sys.executable, "-I", str(CLI), "check", str(case)], capture_output=True, text=True)
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def assert_read_baseline_passes(self, runtime="agy"):
        """Keep the successful side of each refusal boundary explicit."""
        code, record = self.check(native_events(runtime), runtime=runtime,
                                  inventory=native_inventory(runtime))
        self.assertEqual(code, 0, record)

    def test_exit_zero_without_reads_fails_but_successful_native_reads_pass(self):
        inventory = {"status": "SUCCESS", "response": "treflebonbon-skills:rop\tROP"}
        completion = {"event": "result", "result": {"status": "SUCCESS"}}
        code, record = self.check([completion], inventory=inventory)
        self.assertEqual(code, 1)
        self.assertIn("skill_not_read", record["reasons"])

        code, record = self.check(
            [AGY_INIT, agy_read(SKILL), agy_read(RESOURCE), completion], inventory=inventory
        )
        self.assertEqual(code, 0)
        self.assertEqual(record["status"], "passed")
        self.assertEqual(record["skill_path"], SKILL)
        self.assertEqual(record["resource_paths"], [RESOURCE])

    def test_claude_and_codex_successful_read_evidence_is_supported(self):
        """Both native protocols must provide the same observable read contract."""
        for runtime in ("claude", "codex"):
            with self.subTest(runtime=runtime):
                code, record = self.check(native_events(runtime), runtime=runtime,
                                          inventory=native_inventory(runtime))
                self.assertEqual(code, 0, record)
                self.assertEqual(record["resource_paths"], [RESOURCE])

    def test_unknown_skill_inventory_does_not_pass_on_read_evidence(self):
        self.assert_read_baseline_passes()
        code, record = self.check(native_events("agy"), inventory={"status": "SUCCESS", "response": "other\tOther"})
        self.assertEqual(code, 1)
        self.assertIn("skill_not_detected", record["reasons"])

    def test_failed_or_missing_resource_read_does_not_pass(self):
        self.assert_read_baseline_passes()
        events = native_events("agy")
        events[2]["step_update"]["tool_info"]["output"] = "Error: file not found"
        code, record = self.check(events, inventory=native_inventory("agy"))
        self.assertEqual(code, 1)
        self.assertIn("resource_not_read", record["reasons"])

    def test_successful_reads_do_not_hide_process_or_native_failure(self):
        self.assert_read_baseline_passes()
        code, record = self.check(native_events("agy"), inventory=native_inventory("agy"), exit_code=7)
        self.assertEqual(code, 1)
        self.assertIn("process_failed", record["reasons"])
        events = native_events("agy")
        events[-1]["result"]["status"] = "ERROR"
        code, record = self.check(events, inventory=native_inventory("agy"))
        self.assertEqual(code, 1)
        self.assertIn("incomplete_session", record["reasons"])

    def test_echo_and_masked_cat_failures_are_not_read_evidence(self):
        """A successful shell process cannot substitute for a successful file read."""
        self.assert_read_baseline_passes("codex")
        for command in (f"echo 'cat -- {RESOURCE}'", f"cat -- {RESOURCE} || true"):
            with self.subTest(command=command):
                events = native_events("codex")
                events[2]["item"]["command"] = command
                code, record = self.check(events, runtime="codex", inventory=native_inventory("codex"))
                self.assertEqual(code, 1)
                self.assertIn("resource_not_read", record["reasons"])

    def test_resources_from_another_plugin_root_do_not_pass(self):
        self.assert_read_baseline_passes()
        events = native_events("agy")
        events[2] = agy_read("/other/plugin/skills/rop/references/rust.md")
        code, record = self.check(events, inventory=native_inventory("agy"))
        self.assertEqual(code, 1)
        self.assertIn("resource_not_read", record["reasons"])

    def test_unchecked_dependencies_are_explicit_even_when_reads_pass(self):
        code, record = self.check(native_events("agy"), inventory=native_inventory("agy"))
        self.assertEqual(code, 0)
        self.assertEqual(record["dependencies_status"], "unconfirmed")
        self.assertEqual(record["auxiliary_status"], "unconfirmed")

    def test_missing_session_id_is_not_evidence_of_a_fresh_session(self):
        self.assert_read_baseline_passes()
        events = native_events("agy")[1:]
        code, record = self.check(events, inventory=native_inventory("agy"))
        self.assertEqual(code, 1)
        self.assertIn("session_id_missing_or_ambiguous", record["reasons"])

    def test_multiple_session_ids_are_not_one_fresh_session(self):
        self.assert_read_baseline_passes()
        events = native_events("agy") + [{"event": "init", "conversation_id": "different-session"}]
        code, record = self.check(events, inventory=native_inventory("agy"))
        self.assertEqual(code, 1)
        self.assertIn("session_id_missing_or_ambiguous", record["reasons"])

    def test_reading_files_without_official_invocation_does_not_pass(self):
        self.assert_read_baseline_passes()
        code, record = self.check(native_events("agy"), inventory=native_inventory("agy"),
                                  command=["agy", "-p", "/rop 受入確認"])
        self.assertEqual(code, 1)
        self.assertIn("official_invocation_missing", record["reasons"])

    def test_codex_zsh_reads_have_the_same_public_contract(self):
        """The native macOS shell envelope must not change read verification."""
        events = native_events("codex")
        for event in events:
            item = event.get("item", {})
            if "command" in item:
                item["command"] = item["command"].replace("/bin/bash", "/bin/zsh")
        code, record = self.check(events, runtime="codex", inventory=native_inventory("codex"))
        self.assertEqual(code, 0, record)

    def test_run_uses_native_names_and_writes_checkable_evidence(self):
        """External client fixtures exercise launch arguments and persisted results."""
        clients = self.base / "clients"
        clients.mkdir()
        calls = self.base / "calls.jsonl"
        for runtime in ("claude", "codex", "agy"):
            data = {"events": native_events(runtime), "inventory": native_inventory(runtime)}
            script = (
                "#!" + sys.executable + "\n"
                "import json, pathlib, sys\n"
                f"data = json.loads({json.dumps(data)!r})\n"
                f"with open({str(calls)!r}, 'a') as output: output.write(json.dumps(sys.argv) + '\\n')\n"
                "if '--version' in sys.argv: print('fixture-cli 1.0')\n"
                "elif 'plugin' in sys.argv or '/skills' in sys.argv: print(json.dumps(data['inventory']))\n"
                "else:\n"
                " for event in data['events']: print(json.dumps(event))\n"
            )
            path = clients / runtime
            path.write_text(script)
            path.chmod(0o755)
        output = self.base / "sessions"
        result = subprocess.run(
            [sys.executable, "-I", str(CLI), "run", "--output-dir", str(output), "--skill", "rop"],
            env=os.environ | {"PATH": str(clients) + os.pathsep + os.environ["PATH"]},
            capture_output=True, text=True,
        )
        self.assertTrue(result.stdout, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, report)
        self.assertEqual(report["passed"], 3)
        commands = [json.loads(line) for line in calls.read_text().splitlines()]
        prompts = [argument for command in commands for argument in command if "受入確認" in argument]
        self.assertEqual(len(prompts), 3)
        self.assertEqual({prompt.split(" ", 1)[0] for prompt in prompts},
                         {"/treflebonbon-skills:rop", "$treflebonbon-skills:rop"})
        self.assertEqual(json.loads((output / "summary.json").read_text()), report)
        for runtime in ("claude", "codex", "agy"):
            self.assertTrue((output / runtime / "rop/events.jsonl").is_file())

    def test_missing_clients_fail_all_33_cases_without_model_calls(self):
        """The default matrix stays exhaustive when prerequisites are missing."""
        clients = self.base / "empty-clients"
        clients.mkdir()
        output = self.base / "missing"
        result = subprocess.run(
            [sys.executable, "-I", str(CLI), "run", "--output-dir", str(output)],
            env=os.environ | {"PATH": str(clients)}, capture_output=True, text=True,
        )
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["expected"], 33)
        self.assertEqual(report["passed"], 0)
        self.assertTrue(all(case["status"] == "unconfirmed" for case in report["cases"]))
        self.assertTrue(all(case["reasons"] == ["cli_or_inventory_unavailable"] for case in report["cases"]))

    def test_existing_output_is_preserved(self):
        output = self.base / "existing"
        output.mkdir()
        sentinel = output / "original.txt"
        sentinel.write_text("keep this evidence")
        result = subprocess.run(
            [sys.executable, "-I", str(CLI), "run", "--output-dir", str(output)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["reasons"], ["output_exists"])
        self.assertEqual(sentinel.read_text(), "keep this evidence")

    def test_truncated_events_are_unconfirmed_and_do_not_echo_the_input(self):
        self.check(native_events("agy"), inventory=native_inventory("agy"))
        (self.base / "case/events.jsonl").write_text('{"credential":"do-not-echo')
        result = subprocess.run([sys.executable, "-I", str(CLI), "check", str(self.base / "case")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["reasons"], ["invalid_evidence"])
        self.assertNotIn("do-not-echo", result.stdout + result.stderr)

    def test_timeout_keeps_evidence_and_marks_the_case_failed(self):
        clients = self.base / "clients"
        clients.mkdir()
        script = (
            "#!" + sys.executable + "\nimport json, sys, time\n"
            f"events = json.loads({json.dumps(native_events('agy'))!r})\n"
            f"inventory = json.loads({json.dumps(native_inventory('agy'))!r})\n"
            "if '--version' in sys.argv: print('fixture 1.0')\n"
            "elif '/skills' in sys.argv: print(json.dumps(inventory))\n"
            "else:\n"
            " for event in events: print(json.dumps(event), flush=True)\n"
            " time.sleep(60)\n"
        )
        client = clients / "agy"
        client.write_text(script)
        client.chmod(0o755)
        output = self.base / "timeout"
        result = subprocess.run(
            [sys.executable, "-I", str(CLI), "run", "--runtime", "agy", "--skill", "rop",
             "--timeout", "1", "--output-dir", str(output)],
            env=os.environ | {"PATH": str(clients)}, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 1)
        record = json.loads(result.stdout)["cases"][0]
        self.assertIn("process_failed", record["reasons"])
        self.assertEqual(json.loads((output / "agy/rop/process.json").read_text())["exit_code"], 124)
        self.assertEqual((output.stat().st_mode & 0o777), 0o700)
        self.assertEqual(((output / "agy/rop/events.jsonl").stat().st_mode & 0o777), 0o600)
        self.assertTrue((output / "agy/rop/stderr.log").exists())
