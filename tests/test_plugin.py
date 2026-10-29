import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class OfficialPluginTest(unittest.TestCase):
    def setUp(self):
        self.before = self.snapshot()
        self.addCleanup(self.assert_payload_unchanged)
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-plugin.")
        self.addCleanup(self.temporary.cleanup)
        self.environment = os.environ.copy()
        home = Path(self.temporary.name)
        for name, directory in {
            "HOME": "home",
            "XDG_CONFIG_HOME": "config",
            "XDG_DATA_HOME": "data",
            "XDG_CACHE_HOME": "cache",
            "XDG_STATE_HOME": "state",
            "CODEX_HOME": "codex",
            "CLAUDE_CONFIG_DIR": "claude",
        }.items():
            path = home / directory
            path.mkdir()
            self.environment[name] = str(path)

    def snapshot(self):
        contents = {}
        for directory, dirs, files in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__"}]
            for name in files:
                if name == ".env" or name.startswith(".env."):
                    continue
                path = Path(directory) / name
                contents[str(path.relative_to(ROOT))] = (
                    hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode
                )
        return contents

    def assert_payload_unchanged(self):
        self.assertEqual(self.snapshot(), self.before, "公式 CLI が配布元を書き換えました")

    def command(self, *arguments):
        result = subprocess.run(
            arguments,
            cwd=self.temporary.name,
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    @unittest.skipUnless(shutil.which("agy"), "Antigravity CLI が必要")
    def test_antigravity_accepts_the_portable_rop_plugin(self):
        result = json.loads(
            self.command("agy", "plugin", "validate", str(ROOT), "--strict", "--json")
        )
        self.assertEqual(result["name"], "treflebonbon-skills")
        self.assertEqual(result["components"]["skills"], 1)
        self.assertEqual(
            [f for f in result["findings"] if f["severity"] != "note"], []
        )

    @unittest.skipUnless(shutil.which("codex"), "Codex CLI が必要")
    def test_codex_installs_rop_from_the_local_marketplace(self):
        self.command("codex", "plugin", "marketplace", "add", str(ROOT), "--json")
        result = json.loads(self.command(
            "codex", "plugin", "add", "treflebonbon-skills@treflebonbon", "--json"
        ))
        installed = Path(result["installedPath"])
        self.assertEqual(
            (installed / "skills/rop/references/rust.md").read_bytes(),
            (ROOT / "skills/rop/references/rust.md").read_bytes(),
        )

    @unittest.skipUnless(shutil.which("claude"), "Claude Code が必要")
    def test_claude_installs_rop_from_the_local_marketplace(self):
        self.command("claude", "plugin", "marketplace", "add", str(ROOT), "--json")
        self.command("claude", "plugin", "install", "treflebonbon-skills@treflebonbon", "--json")
        inventory = self.command("claude", "plugin", "details", "treflebonbon-skills@treflebonbon")
        self.assertIn("rop", inventory)

    @unittest.skipUnless(shutil.which("agy"), "Antigravity CLI が必要")
    def test_antigravity_installs_the_portable_rop_plugin(self):
        self.command("agy", "plugin", "install", str(ROOT))
        plugins = self.command("agy", "plugin", "list", "--json")
        self.assertIn("treflebonbon-skills", plugins)


if __name__ == "__main__":
    unittest.main()
