from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
BATS = shutil.which("bats")
REQUIRED = BATS and shutil.which("jq")


@unittest.skipUnless(REQUIRED, "the migrated CLI Bats tests require bats and jq")
class MigratedBatsTest(unittest.TestCase):
    def test_existing_cli_suites(self):
        for suite in sorted((ROOT / "tests/cli").glob("*.bats")):
            with self.subTest(suite=suite.name):
                result = subprocess.run(
                    [BATS, str(suite)],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
