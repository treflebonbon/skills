import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def git(*arguments):
    return subprocess.run(
        ["git", *map(str, arguments)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class PythonLauncherPayloadImmutabilityTest(unittest.TestCase):
    def test_codex_reviewer_does_not_write_python_cache_into_installed_payload(self):
        with tempfile.TemporaryDirectory(prefix="skills-python-launcher.") as temporary:
            base = Path(temporary)
            payload = base / "installed-plugin"
            (payload / "bin").mkdir(parents=True)
            (payload / "lib/python").mkdir(parents=True)
            for entry in ("codex-reviewer", "codex-worktree", "devshell-env"):
                shutil.copy2(ROOT / "bin" / entry, payload / "bin" / entry)
            shutil.copytree(
                ROOT / "lib/python/treflebonbon_skills",
                payload / "lib/python/treflebonbon_skills",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            shutil.copytree(
                ROOT / "share/codex-isolation",
                payload / "share/codex-isolation",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )

            repository = base / "source"
            worktree = base / "linked-review"
            git("init", "-q", repository)
            git(
                "-C",
                repository,
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial",
            )
            git("-C", repository, "worktree", "add", "-q", "-b", "review", worktree)

            mock_bin = base / "mock-bin"
            mock_bin.mkdir()
            capture = base / "codex.json"
            codex = mock_bin / "codex"
            codex.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "with open(os.environ['CODEX_CAPTURE'], 'w', encoding='utf-8') as f:\n"
                "    json.dump(sys.argv[1:], f)\n",
                encoding="utf-8",
            )
            codex.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{mock_bin}:/usr/bin:/bin",
                    "CODEX_CAPTURE": str(capture),
                    "HOME": str(base / "home"),
                    "XDG_STATE_HOME": str(base / "state"),
                }
            )
            environment.pop("GIT_DIR", None)
            environment.pop("GIT_WORK_TREE", None)

            result = subprocess.run(
                [str(payload / "bin/codex-reviewer"), "review prompt"],
                cwd=worktree,
                env=environment,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(capture.read_text(encoding="utf-8"))[0:2], ["-C", str(worktree)])

            status = subprocess.run(
                [str(payload / "bin/devshell-env"), "status", str(worktree)],
                cwd=base,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(status.returncode, 0, status.stdout + status.stderr)

            raw = subprocess.run(
                [
                    str(payload / "bin/codex-worktree"),
                    "--dangerously-bypass-approvals-and-sandbox",
                ],
                cwd=worktree,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(raw.returncode, 1, raw.stdout + raw.stderr)
            self.assertIn("runtime boundary", raw.stderr)
            self.assertEqual(list(payload.rglob("__pycache__")), [])


if __name__ == "__main__":
    unittest.main()
