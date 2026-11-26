"""Selection and raw isolation checks for the prebuilt C launcher."""

import hashlib
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib/python"))
from treflebonbon_skills.raw_launcher import select_raw_launcher  # noqa: E402


def source_sha256():
    fixtures = ROOT / "tests/fixtures"
    hashes = [
        hashlib.sha256((fixtures / name).read_bytes()).hexdigest()
        for name in ("bun-exec-pid-namespace.c", "bun-exec-launcher.c")
    ]
    return hashlib.sha256("".join(hashes).encode("ascii")).hexdigest()


class RawLauncherSelectionTests(unittest.TestCase):
    def test_selection_requires_a_canonical_nix_output(self):
        for path in ("", "/usr/bin/true", "/nix/store/../bin/true"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Nix store"):
                select_raw_launcher(path, source_sha256())

    @unittest.skipUnless(os.environ.get("RAW_LAUNCHER_PROOF"), "explicit Nix output required")
    def test_validation_rejects_a_different_source_and_an_unselected_closure(self):
        selected = os.environ["RAW_LAUNCHER_PROOF"]
        launcher = select_raw_launcher(selected, source_sha256())
        with self.assertRaisesRegex(ValueError, "source or version"):
            select_raw_launcher(selected, "0" * 64)
        with self.assertRaisesRegex(ValueError, "selected closure"):
            launcher.verify_copy(Path("/nonexistent"), [])

    @unittest.skipUnless(os.environ.get("RAW_LAUNCHER_PROOF"), "explicit Nix output required")
    def test_launcher_only_sigkill_under_real_raw_isolation(self):
        launcher = select_raw_launcher(os.environ["RAW_LAUNCHER_PROOF"], source_sha256())
        raw = runpy.run_path(str(ROOT / "share/codex-isolation/secret-isolation-worktree.py"))
        with tempfile.TemporaryDirectory(prefix="raw-launcher-proof-") as directory:
            base = Path(directory)
            ca = base / "unused-ca"
            ca.touch()
            subprocess.run(
                ["bash", "-c", 'source "$PROJECT_ROOT/tests/helpers/raw-codex.bash"; raw_fixture'],
                env=os.environ | {
                    "PROJECT_ROOT": str(ROOT),
                    "BATS_TEST_TMPDIR": str(base),
                    "CODEX_ISOLATION_CA_BUNDLE": str(ca),
                },
                check=True,
                timeout=30,
            )
            repo = raw["Repository"].discover(base / "raw/work", linked_only=True)
            fixtures = ROOT / "tests/fixtures"
            files = {
                "entry": fixtures / "bun-exec-entry.sh",
                "prepare.ts": fixtures / "bun-raw-launcher-prepare.ts",
                "supervise.py": fixtures / "raw-launcher-proof.py",
                **{name: ROOT / "lib/bun" / name for name in ("run", "bunfig.toml", "tsconfig.json")},
            }
            for name, original in files.items():
                shutil.copyfile(original, repo.root / name)
                (repo.root / name).chmod(original.stat().st_mode & 0o777)
            policy = base / "policy.json"
            head = raw["git"](repo.root, "rev-parse", "HEAD").decode().strip()
            raw["approve"](repo, policy, head, ["flake.nix", *files])
            bun = shutil.which("bun")
            self.assertIsNotNone(bun, "Nix Bun is required for the raw proof")
            output = base / "session"
            self.assertEqual(raw["run_isolated"](
                repo, policy, output,
                ["python3", "-I", "-B", str(repo.root / "supervise.py"), str(launcher.executable)],
                [],
                runtime=dict(mcp_tools={"bun": bun}, config_files={}, output="default",
                             requirements="", hooks={}, git_identity={}),
                launcher=launcher,
            ), 0)
            copied = base / "altered-store"
            shutil.copytree(launcher.package, copied / launcher.package.name)
            executable = copied / launcher.executable.relative_to("/nix/store")
            launcher.verify_copy(copied, [str(launcher.package)])
            with self.assertRaisesRegex(ValueError, "file owner or mode"):
                executable.chmod(0o755)
                launcher.verify_copy(copied, [str(launcher.package)])
            with self.assertRaisesRegex(ValueError, "digest"):
                executable.write_bytes(b"changed executable")
                executable.chmod(0o555)
                launcher.verify_copy(copied, [str(launcher.package)])
