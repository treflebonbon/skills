import ast
import datetime as dt
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/herdr-peer-refactor"
ASSETS = SKILL / "assets/auto-peer"
RULES = ASSETS / "auto-peer.rules"
CLAUDE_SETTINGS = ASSETS / "auto-peer-deny.json"
CLAUDE_PROFILE = ASSETS / "claude-peer.settings.json"
CODEX_PROFILE = ASSETS / "codex-peer.config.toml"
PREFLIGHT = SKILL / "scripts/auto-peer-preflight.py"
LAUNCH_CLAUDE = SKILL / "scripts/launch-child.sh"
LAUNCH_CODEX = SKILL / "scripts/codex-auto-peer.sh"


def policy_values():
    tree = ast.parse(RULES.read_text(encoding="utf-8"))
    values = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in {"peer_deny", "AUTO_PEER_POLICY_PROBE"}:
                values[node.targets[0].id] = ast.literal_eval(node.value)
    return values


class AutoPeerPolicyTests(unittest.TestCase):
    def test_claude_settings_are_the_projection_of_the_policy_source(self):
        records = policy_values()["peer_deny"]
        expected = {"permissions": {"deny": [pattern for record in records for pattern in record["claude"]]}}
        actual = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))

        self.assertEqual(actual, expected)
        self.assertEqual(len(expected["permissions"]["deny"]), len(set(expected["permissions"]["deny"])))
        self.assertIn("git push origin HEAD", [command for record in records for command in record.get("claude_deny", [])])

        runtime = json.loads(CLAUDE_PROFILE.read_text(encoding="utf-8"))
        self.assertEqual(runtime["permissions"]["deny"], expected["permissions"]["deny"])
        self.assertTrue(runtime["permissions"]["blockReadsOutsideWorkingDirectories"])
        self.assertTrue(runtime["sandbox"]["enabled"])
        self.assertTrue(runtime["sandbox"]["failIfUnavailable"])
        self.assertFalse(runtime["sandbox"]["allowUnsandboxedCommands"])

    @unittest.skipUnless(shutil.which("codex"), "Codex CLI execpolicy is unavailable")
    def test_codex_rules_reject_raw_push_merge_and_the_policy_probe(self):
        probe = policy_values()["AUTO_PEER_POLICY_PROBE"]
        examples = [
            probe,
            "git push origin HEAD",
            "git -C . push origin HEAD",
            "/usr/bin/git push origin HEAD",
            "env git push origin HEAD",
            "gh pr merge 1",
            "git-push-reviewed",
        ]
        for command in examples:
            with self.subTest(command=command):
                result = subprocess.run(
                    ["codex", "execpolicy", "check", "--rules", str(RULES), "--", *command.split()],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout).get("decision"), "forbidden", result.stdout)

    def test_dedicated_codex_profile_keeps_workspace_and_credential_read_only(self):
        config = tomllib.loads(CODEX_PROFILE.read_text(encoding="utf-8"))
        filesystem = config["permissions"]["dotfiles-peer"]["filesystem"]

        self.assertEqual(filesystem[":workspace_roots"]["."], "read")
        self.assertEqual(filesystem["~/.codex-peer/gh"]["."], "read")


class AutoPeerPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-auto-peer.")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.state = self.base / "state.json"
        self.env = dict(os.environ)
        self.env.update(
            {
                "HOME": str(self.home),
                "PATH": f"{self.bin}:{os.environ['PATH']}",
                "AUTO_PEER_TEST_STATE": str(self.state),
            }
        )
        self.claude_home = self.home / ".claude-peer"
        self.claude_home.mkdir(mode=0o700)
        self.settings = self.claude_home / "auto-peer-settings.json"
        self.settings.write_bytes(CLAUDE_PROFILE.read_bytes())
        self.receipt = self.base / "run" / "auto-peer-preflight.json"
        self.receipt.parent.mkdir(mode=0o700)
        self.install_claude_mock()

    def install_claude_mock(self):
        mock = self.bin / "claude"
        mock.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, subprocess, sys\n"
            "args = sys.argv[1:]\n"
            "if args == ['--version']:\n"
            "    print('2.1.300')\n"
            "elif args == ['auth', 'status', '--json']:\n"
            "    print(json.dumps({'authMethod': 'claude.ai', 'configDirectory': os.environ['CLAUDE_CONFIG_DIR']}))\n"
            "elif '--print' in args:\n"
            "    state = json.loads(open(os.environ['AUTO_PEER_TEST_STATE'], encoding='utf-8').read())\n"
            "    settings_path = args[args.index('--settings') + 1] if '--settings' in args else ''\n"
            "    if os.path.basename(settings_path) == 'baseline.settings.json':\n"
            "        subprocess.run(['treflebonbon-auto-policy-probe'], check=True)\n"
            "        open(os.path.join(os.getcwd(), 'outside-read-ran'), 'w', encoding='utf-8').write('ran')\n"
            "        denials = []\n"
            "    elif state.get('deny'):\n"
            "        denials = [\n"
            "            {'tool_name': 'Bash', 'tool_input': {'command': 'treflebonbon-auto-policy-probe'}},\n"
            "            {'tool_name': 'Bash', 'tool_input': {'command': 'git push origin HEAD'}},\n"
            "        ]\n"
            "    else:\n"
            "        subprocess.run(['treflebonbon-auto-policy-probe'], check=True)\n"
            "        denials = []\n"
            "    print(json.dumps({'type': 'result', 'permission_denials': denials}))\n"
            "else:\n"
            "    sys.exit(64)\n",
            encoding="utf-8",
        )
        mock.chmod(0o755)
        self.env["CLAUDE_CONFIG_DIR"] = str(self.claude_home)

    def run_preflight(self, *arguments):
        return subprocess.run(
            ["python3", "-B", str(PREFLIGHT), *map(str, arguments)],
            env=self.env,
            capture_output=True,
            text=True,
        )

    def test_claude_preflight_requires_control_success_and_runtime_refusals(self):
        probe_marker = self.base / "probe-executed"
        git_marker = self.base / "raw-push-executed"
        self.env["AUTO_PEER_PROBE_MARKER"] = str(probe_marker)
        self.env["AUTO_PEER_GIT_MARKER"] = str(git_marker)
        self.state.write_text(json.dumps({"deny": True}), encoding="utf-8")
        before = {
            path: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in ASSETS.iterdir()
            if path.is_file()
        }

        result = self.run_preflight("claude", "--settings", self.settings, "--receipt", self.receipt)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(git_marker.exists())
        receipt = json.loads(self.receipt.read_text(encoding="utf-8"))
        self.assertEqual(receipt["runtime"], "claude")
        self.assertEqual(receipt["observed"]["sandbox_outside_read"], "denied")
        self.assertEqual(receipt["observed"]["configured_denials"], [
            "treflebonbon-auto-policy-probe",
            "git push origin HEAD",
        ])
        self.assertEqual(
            before,
            {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in before},
        )

    def test_claude_preflight_fails_if_settings_are_ignored(self):
        probe_marker = self.base / "probe-executed"
        self.env["AUTO_PEER_PROBE_MARKER"] = str(probe_marker)
        self.state.write_text(json.dumps({"deny": False}), encoding="utf-8")

        result = self.run_preflight("claude", "--settings", self.settings, "--receipt", self.receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.receipt.exists())

    def test_claude_preflight_rejects_a_noncanonical_settings_file_before_cli_use(self):
        self.settings.write_text('{"permissions":{"deny":[]}}\n', encoding="utf-8")
        self.state.write_text(json.dumps({"deny": True}), encoding="utf-8")

        result = self.run_preflight("claude", "--settings", self.settings, "--receipt", self.receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.receipt.exists())

    def install_codex_mock(self, *, denied=True):
        self.codex_home = self.home / ".codex-peer"
        (self.codex_home / "rules").mkdir(parents=True, mode=0o700)
        (self.codex_home / "gh").mkdir(mode=0o700)
        self.codex_home.chmod(0o700)
        (self.codex_home / "config.toml").write_bytes(CODEX_PROFILE.read_bytes())
        (self.codex_home / "rules/auto-peer.rules").write_bytes(RULES.read_bytes())
        (self.codex_home / "gh/hosts.yml").write_text("github.com:\n  users:\n", encoding="utf-8")
        (self.codex_home / "gh/hosts.yml").chmod(0o600)
        now = dt.datetime.now(dt.timezone.utc).date().isoformat()
        attestation = {
            "repository": "owner/repo",
            "credential_type": "fine-grained personal access token",
            "permissions": {
                "contents": "read",
                "issues": "read",
                "metadata": "read",
                "pull_requests": "read",
            },
            "verified_at": now,
            "verified_by": "reviewer",
            "activated_at": now,
            "activated_by": "reviewer",
        }
        (self.codex_home / "auto-peer-read-only-attestation.json").write_text(
            json.dumps(attestation, indent=2) + "\n", encoding="utf-8"
        )
        self.env["CODEX_HOME"] = str(self.codex_home)
        self.env["GH_CONFIG_DIR"] = str(self.codex_home / "gh")
        self.env["AUTO_PEER_TEST_CODEX_CALL"] = str(self.base / "codex-call.json")
        codex = self.bin / "codex"
        codex.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, re, sys, urllib.request\n"
            "args = sys.argv[1:]\n"
            "if args == ['--version']:\n"
            "    print('codex-cli 0.165.0')\n"
            "elif args == ['login', 'status']:\n"
            "    sys.exit(0)\n"
            "elif args and args[0] == 'exec':\n"
            "    open(os.environ['AUTO_PEER_TEST_CODEX_CALL'], 'w', encoding='utf-8').write(json.dumps({'args': args, 'home': os.environ['HOME'], 'codex_home': os.environ['CODEX_HOME'], 'gh_home': os.environ['GH_CONFIG_DIR']}))\n"
            "    provider = next(value for value in args if value.startswith('model_providers.mock='))\n"
            "    url = re.search(r'base_url=\\\"([^\\\"]+)', provider).group(1)\n"
            "    input_items = []\n"
            "    outputs = {\n"
            "        'auto-peer-read-control': 'Process exited with code 0\\nOutput:\\nOn branch auto-peer-canary\\nnothing to commit, working tree clean\\n',\n"
            "        'auto-peer-workspace-write': 'Process exited with code 1\\nOutput:\\ntouch: cannot touch marker: Read-only file system\\n',\n"
            "        'auto-peer-raw-push': 'exec_command failed: CreateProcess { message: \\\"Rejected(\\\\\\\"git push rejected: No raw push.\\\\\\\")\\\" }',\n"
            "    }\n"
            "    if os.environ.get('AUTO_PEER_TEST_WRITE_ALLOWED'):\n"
            "        outputs['auto-peer-workspace-write'] = 'Process exited with code 0\\nOutput:\\n'\n"
            "    if os.environ.get('AUTO_PEER_TEST_RAW_PUSH_ALLOWED'):\n"
            "        outputs['auto-peer-raw-push'] = 'Process exited with code 0\\nOutput:\\n'\n"
            "    for _ in range(4):\n"
            "        headers = {'Content-Type': 'application/json'}\n"
            "        if os.environ.get('AUTO_PEER_TEST_SEND_AUTH'):\n"
            "            headers['Authorization'] = 'Bearer fixture-only'\n"
            "        request = urllib.request.Request(url, data=json.dumps({'model': 'mock-model', 'input': input_items}).encode(), headers=headers)\n"
            "        with urllib.request.urlopen(request, timeout=5) as response:\n"
            "            body = response.read().decode()\n"
            "        events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith('data: ')]\n"
            "        call = next((event['item'] for event in events if event.get('type') == 'response.output_item.done' and event.get('item', {}).get('type') == 'function_call'), None)\n"
            "        if call is None:\n"
            "            break\n"
            "        call_id = call['call_id']\n"
            "        output = outputs.get(call_id, 'unexpected canary call')\n"
            "        input_items = [{'type': 'function_call_output', 'call_id': call_id, 'output': output}]\n"
            "    print(json.dumps({'type': 'turn.completed'}))\n"
            "    sys.exit(0)\n"
            "elif args[:2] == ['execpolicy', 'check']:\n"
            f"    denied = {denied!r}\n"
            "    command = args[args.index('--') + 1:]\n"
            "    decision = 'forbidden' if denied and command and command[0] in {'git', '/usr/bin/git', '/bin/git', 'gh', 'git-push-reviewed', 'command', 'env', 'treflebonbon-auto-policy-probe'} else None\n"
            "    result = {'matchedRules': [] if decision is None else [{'prefixRuleMatch': {'decision': decision}}]}\n"
            "    if decision is not None:\n"
            "        result['decision'] = decision\n"
            "    print(json.dumps(result))\n"
            "else:\n"
            "    sys.exit(64)\n",
            encoding="utf-8",
        )
        codex.chmod(0o755)
        gh = self.bin / "gh"
        gh.write_text("#!/bin/sh\nif [ \"$1\" = repo ]; then printf 'owner/repo\\n'; fi\nexit 0\n", encoding="utf-8")
        gh.chmod(0o755)

    def test_codex_preflight_requires_matching_profile_rules_auth_and_human_read_only_scope(self):
        self.install_codex_mock()
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(payload["runtime"], "codex")
        self.assertEqual(payload["observed"], {
            "workspace_read": "allowed",
            "workspace_write": "denied",
            "raw_push": "forbidden",
            "loopback_authorization": "absent",
        })
        invocation = json.loads(Path(self.env["AUTO_PEER_TEST_CODEX_CALL"]).read_text(encoding="utf-8"))
        arguments = invocation["args"]
        canary_home = Path(invocation["codex_home"]).resolve()
        canary_root = Path(invocation["home"]).resolve()
        self.assertTrue(canary_root.is_relative_to(self.home.resolve()))
        self.assertNotEqual(canary_home, self.codex_home.resolve())
        self.assertEqual(canary_home, canary_root / ".codex-peer")
        self.assertEqual(Path(invocation["gh_home"]).resolve(), canary_home / "gh")
        fixture = Path(arguments[arguments.index("-C") + 1]).resolve()
        self.assertTrue(fixture.is_relative_to(self.home.resolve()))
        self.assertNotEqual(fixture, Path.cwd().resolve())
        filesystem_override = next(value.split("=", 1)[1] for value in arguments if value.startswith("permissions.dotfiles-peer.filesystem="))
        primary = fixture.parent / "primary"
        common_dir = primary / ".git"
        git_dir = common_dir / "worktrees" / "linked"
        self.assertEqual(filesystem_override, f'{{"{git_dir}"="read", "{common_dir}"="read"}}')

    def test_codex_preflight_rejects_an_authorization_header_to_loopback(self):
        self.install_codex_mock()
        self.env["AUTO_PEER_TEST_SEND_AUTH"] = "1"
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Authorization header", result.stdout + result.stderr)
        self.assertFalse(receipt.exists())

    def test_codex_preflight_holds_if_active_workspace_write_is_allowed(self):
        self.install_codex_mock()
        self.env["AUTO_PEER_TEST_WRITE_ALLOWED"] = "1"
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("workspace write", result.stdout + result.stderr)
        self.assertFalse(receipt.exists())

    def test_codex_preflight_holds_if_active_raw_push_reaches_fake_git(self):
        self.install_codex_mock()
        self.env["AUTO_PEER_TEST_RAW_PUSH_ALLOWED"] = "1"
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("raw push", result.stdout + result.stderr)
        self.assertFalse(receipt.exists())

    def test_codex_preflight_holds_if_policy_evaluator_does_not_forbid(self):
        self.install_codex_mock(denied=False)
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(receipt.exists())

    def test_codex_preflight_holds_if_read_only_attestation_is_missing(self):
        self.install_codex_mock()
        (self.codex_home / "auto-peer-read-only-attestation.json").unlink()
        receipt = self.base / "run" / "codex-auto-peer-preflight.json"

        result = self.run_preflight("codex", "--repository", "owner/repo", "--receipt", receipt)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(receipt.exists())

    def test_receipt_verification_detects_a_changed_claude_settings_file(self):
        probe_marker = self.base / "probe-executed"
        self.env["AUTO_PEER_PROBE_MARKER"] = str(probe_marker)
        self.state.write_text(json.dumps({"deny": True}), encoding="utf-8")
        generated = self.run_preflight("claude", "--settings", self.settings, "--receipt", self.receipt)
        self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)
        self.settings.write_text("{}\n", encoding="utf-8")

        verified = self.run_preflight(
            "verify", "--runtime", "claude", "--settings", self.settings, "--receipt", self.receipt
        )

        self.assertNotEqual(verified.returncode, 0)

    def test_claude_receipt_verification_repeats_the_runtime_canary(self):
        self.env["AUTO_PEER_PROBE_MARKER"] = str(self.base / "probe-executed")
        self.state.write_text(json.dumps({"deny": True}), encoding="utf-8")
        generated = self.run_preflight("claude", "--settings", self.settings, "--receipt", self.receipt)
        self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)

        verified = self.run_preflight(
            "verify", "--runtime", "claude", "--settings", self.settings, "--receipt", self.receipt
        )

        self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)


class AutoPeerLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-auto-peer-launch.")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.worktree = self.base / "worktree"
        self.worktree.mkdir()
        self.settings = self.home / ".claude-peer" / "auto-peer-settings.json"
        self.receipt = self.base / "auto-peer-receipt.json"
        self.log = self.base / "calls.jsonl"
        self.env = dict(os.environ)
        self.env.update(
            {
                "HOME": str(self.home),
                "PATH": f"{self.bin}:{os.environ['PATH']}",
                "AUTO_PEER_TEST_CALL_LOG": str(self.log),
                "AUTO_PEER_TEST_PREFLIGHT_PASS": "1",
                "AUTO_PEER_TEST_SETTINGS": str(self.settings),
                "AUTO_PEER_TEST_WORKTREE": str(self.worktree),
            }
        )
        python = self.bin / "python3"
        python.write_text(
            "#!/bin/sh\n"
            f"case \" $* \" in *auto-peer-preflight.py*) printf '%s\\n' preflight >>\"$AUTO_PEER_TEST_CALL_LOG\"; [ \"$AUTO_PEER_TEST_PREFLIGHT_PASS\" = 1 ] ;; *) exec {shlex.quote(sys.executable)} \"$@\" ;; esac\n",
            encoding="utf-8",
        )
        python.chmod(0o755)
        herdr = self.bin / "herdr"
        herdr.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "args = sys.argv[1:]\n"
            "with open(os.environ['AUTO_PEER_TEST_CALL_LOG'], 'a', encoding='utf-8') as log: log.write(json.dumps(args) + '\\n')\n"
            "if args[:2] == ['workspace', 'create']:\n"
            "    print(json.dumps({'result': {'root_pane': {'pane_id': 'pane-1'}}}))\n"
            "elif args[:2] == ['pane', 'process-info']:\n"
            "    print(json.dumps({'result': {'process_info': {'foreground_processes': [{'argv': ['claude', '--permission-mode', 'auto', '--settings', os.environ['AUTO_PEER_TEST_SETTINGS']], 'cwd': os.environ['AUTO_PEER_TEST_WORKTREE']}]}}}))\n"
            "elif args[:2] == ['pane', 'run']:\n"
            "    sys.exit(0)\n"
            "else:\n"
            "    sys.exit(64)\n",
            encoding="utf-8",
        )
        herdr.chmod(0o755)

    def calls(self):
        return [json.loads(line) if line.startswith("[") else line for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_claude_launcher_preflights_before_creating_a_workspace_and_uses_dedicated_settings(self):
        run_dir = self.base / "run"
        self.env["AUTO_PEER_TEST_PREFLIGHT_PASS"] = "0"
        rejected = subprocess.run(
            [str(LAUNCH_CLAUDE), str(run_dir), "parent-pane", str(self.worktree), "child-1", "4", str(self.receipt), str(self.settings)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.calls(), ["preflight"])
        self.assertFalse(run_dir.exists())

        self.log.unlink()
        self.env["AUTO_PEER_TEST_PREFLIGHT_PASS"] = "1"
        launched = subprocess.run(
            [str(LAUNCH_CLAUDE), str(run_dir), "parent-pane", str(self.worktree), "child-1", "4", str(self.receipt), str(self.settings)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(launched.returncode, 0, launched.stdout + launched.stderr)
        recorded = self.calls()
        self.assertEqual(recorded[0], "preflight")
        pane_run = next(call for call in recorded if isinstance(call, list) and call[:2] == ["pane", "run"])
        self.assertIn(f"CLAUDE_CONFIG_DIR={self.home / '.claude-peer'}", pane_run[3])
        self.assertIn(f"--settings {self.settings}", pane_run[3])

    def test_codex_launcher_never_falls_back_when_preflight_fails(self):
        codex = self.bin / "codex"
        codex.write_text("#!/bin/sh\nprintf launched > \"$AUTO_PEER_TEST_CODEX_LAUNCHED\"\n", encoding="utf-8")
        codex.chmod(0o755)
        self.env["AUTO_PEER_TEST_PREFLIGHT_PASS"] = "0"
        self.env["AUTO_PEER_TEST_CODEX_LAUNCHED"] = str(self.base / "codex-launched")

        result = subprocess.run(
            [str(LAUNCH_CODEX), "owner/repo", str(self.receipt), "--", "review this candidate"],
            env=self.env,
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), ["preflight"])
        self.assertFalse(Path(self.env["AUTO_PEER_TEST_CODEX_LAUNCHED"]).exists())


if __name__ == "__main__":
    unittest.main()
