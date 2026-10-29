from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RawCodexPackageTests(unittest.TestCase):
    def test_dev_shell_status_uses_packaged_git_context_without_dotfiles(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            repository = base / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(repository)], check=True)
            environment = os.environ | {
                "HOME": str(base / "home"),
                "XDG_STATE_HOME": str(base / "state"),
            }

            result = subprocess.run(
                [str(ROOT / "bin/devshell-env"), "status", str(repository)],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("untrusted", result.stdout)
        self.assertIn("no flake", result.stdout)

    def test_raw_entry_rejects_permission_bypass_before_project_evaluation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            repository = base / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(repository)], check=True)
            environment = os.environ | {
                "HOME": str(base / "home"),
                "XDG_STATE_HOME": str(base / "state"),
            }

            result = subprocess.run(
                [
                    str(ROOT / "bin/devshell-env"),
                    "codex",
                    "--dangerously-bypass-approvals-and-sandbox",
                ],
                cwd=repository,
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("runtime boundary", result.stderr)
            self.assertFalse((base / "state/devshell-env/sessions").exists())


if __name__ == "__main__":
    unittest.main()
