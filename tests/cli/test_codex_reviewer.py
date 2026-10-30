import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
REVIEWER = ROOT / "bin/codex-reviewer"


def git(*arguments):
    return subprocess.run(
        ["git", *map(str, arguments)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class CodexReviewerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-codex-reviewer.")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repository = self.base / "repo"
        self.worktree = self.base / "review"
        self.mock_bin = self.base / "mock-bin"
        self.capture = self.base / "codex.json"
        self.mock_bin.mkdir()
        git("init", "-q", self.repository)
        git("-C", self.repository, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "initial")
        git("-C", self.repository, "worktree", "add", "-q", "-b", "review", self.worktree)
        self.nested = self.worktree / "nested"
        self.nested.mkdir()
        self.codex = self.mock_bin / "codex"
        self.codex.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "with open(os.environ['CODEX_CAPTURE'], 'w', encoding='utf-8') as f:\n"
            "    json.dump({'argv': sys.argv[1:], 'git_env': {k: v for k, v in os.environ.items() if k.startswith('GIT_')}}, f)\n"
            "sys.exit(int(os.environ.get('CODEX_EXIT', '0')))\n",
            encoding="utf-8",
        )
        self.codex.chmod(0o755)
        self.environment = os.environ.copy()
        self.environment.update(
            {
                "PATH": f"{self.mock_bin}:/usr/bin:/bin",
                "CODEX_CAPTURE": str(self.capture),
                "GIT_DIR": str(self.base / "wrong.git"),
                "GIT_WORK_TREE": str(self.base / "wrong-worktree"),
            }
        )

    def run_reviewer(self, *arguments, cwd=None):
        return subprocess.run(
            [str(REVIEWER), *arguments],
            cwd=cwd or self.nested,
            env=self.environment,
            capture_output=True,
            text=True,
        )

    def launched(self):
        return json.loads(self.capture.read_text(encoding="utf-8"))

    def assert_rejected(self, *arguments, cwd=None):
        self.capture.unlink(missing_ok=True)
        result = self.run_reviewer(*arguments, cwd=cwd)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("codex-reviewer:", result.stderr)
        self.assertFalse(self.capture.exists())

    def test_linked_worktree_gets_exact_read_only_metadata_from_arbitrary_cwd(self):
        result = self.run_reviewer("-m", "some-model", "review prompt")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = [
            "-C",
            str(self.worktree.resolve()),
            "-c",
            'default_permissions="dotfiles-secure"',
            "-c",
            f'permissions.dotfiles-secure.filesystem={{"{self.repository.resolve()}/.git/worktrees/review"="read","{self.repository.resolve()}/.git"="read"}}',
            "-m",
            "some-model",
            "review prompt",
        ]
        launched = self.launched()
        self.assertEqual(launched["argv"], expected)
        self.assertEqual(launched["git_env"], {})

    def test_peer_profile_preserves_the_same_read_only_metadata(self):
        result = self.run_reviewer("--peer", "--disable", "apps")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        launched = self.launched()
        self.assertEqual(launched["argv"][3], 'default_permissions="dotfiles-peer"')
        self.assertIn('permissions.dotfiles-peer.filesystem={"', launched["argv"][5])
        self.assertTrue(launched["argv"][5].endswith('"read"}'))
        self.assertEqual(launched["argv"][6:], ["--disable", "apps"])

    def test_boundary_replacing_arguments_are_rejected_before_start(self):
        cases = [
            ("-C/tmp",), ("--cd=/tmp",), ("-s",), ("--sandbox=danger-full-access",),
            ("--add-dir=/tmp",), ("--worktree",), ("-Pother",), ("--permissions-profile=other",),
            ("-pother",), ("--profile=other",), ("--dangerously-bypass-approvals-and-sandbox",),
            ("--yolo",), ("--ignore-user-config",), ("--ignore-rules",), ("--approve-for-me",),
            ("--remote=ws://x",), ("--remote-auth-token-env=X",), ("-cdefault_permissions=x",),
            ("--config=permissions.dotfiles-secure.filesystem={}",),
            ("-c", "permissions.x={}"), ("--config", 'sandbox_mode="danger-full-access"'),
            ("-c", "sandbox_workspace_write.network_access=true"), ("-c", 'profile="other"'),
            ("-c", "profiles.x={}"),
            ("-c", 'model_reasoning_effort="high"\n[permissions.dotfiles-secure.filesystem]\n"/"="write"'),
            ("--config=model=\"x\"\r[permissions.x]",),
            ("-c", 'mcp_servers.review={command="sh",args=["-c","id"]}'),
            ("-c", 'notify=["sh","-c","id"]'), ("-c", 'shell_environment_policy.inherit="all"'),
            ("-cfeatures.x=true",),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.assert_rejected(*arguments)

    def test_model_configuration_and_arguments_after_double_dash_are_forwarded(self):
        result = self.run_reviewer("-c", 'model_reasoning_effort="high"', "--", "--sandbox")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.launched()["argv"][6:],
            ["-c", 'model_reasoning_effort="high"', "--", "--sandbox"],
        )

    def test_codex_profile_rejection_is_propagated_without_a_fallback(self):
        self.environment["CODEX_EXIT"] = "78"

        result = self.run_reviewer("review prompt")

        self.assertEqual(result.returncode, 78)
        argv = self.launched()["argv"]
        self.assertEqual(argv[3], 'default_permissions="dotfiles-secure"')
        self.assertIn('permissions.dotfiles-secure.filesystem={"', argv[5])

    def test_main_checkout_non_git_directory_and_broken_metadata_fail_closed(self):
        self.assert_rejected("prompt", cwd=self.repository)

        plain = self.base / "plain"
        plain.mkdir()
        self.assert_rejected("prompt", cwd=plain)

        git_dir = self.repository / ".git/worktrees/review"
        (git_dir / "gitdir").write_text(str(self.base / "elsewhere/.git") + "\n", encoding="utf-8")
        self.assert_rejected("prompt")


if __name__ == "__main__":
    unittest.main()
