from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
BATS = shutil.which("bats")


@unittest.skipUnless(BATS, "worktree-gc regression tests require Bats")
class WorktreeGcTransferTests(unittest.TestCase):
    def test_repo_and_fanout_public_entries_preserve_their_fixture_contracts(self):
        for suite in ("worktree-gc.bats", "worktree-gc-fanout.bats"):
            with self.subTest(suite=suite):
                result = subprocess.run(
                    [BATS, str(ROOT / "tests" / suite)],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
