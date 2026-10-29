import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills/pr-screenshots"


class PRScreenshotsSkillTest(unittest.TestCase):
    def test_bundled_cli_path_is_absolute_and_independent_of_cwd(self):
        resolver = SKILL_ROOT / "scripts/browser-tool-path"
        self.assertTrue(resolver.is_file(), "the skill must bundle its CLI path resolver")

        with tempfile.TemporaryDirectory(prefix="pr-screenshots-cwd.") as temporary:
            symlinked_skill = Path(temporary) / "installed-skill"
            symlinked_skill.symlink_to(SKILL_ROOT, target_is_directory=True)
            for entry in (
                "browser-attachments",
                "managed-chrome-owner",
                "playwright-cli",
                "wsl2-browser-prepare",
            ):
                with self.subTest(entry=entry):
                    for entry_resolver in (
                        resolver,
                        symlinked_skill / "scripts/browser-tool-path",
                    ):
                        result = subprocess.run(
                            [str(entry_resolver), entry],
                            cwd=temporary,
                            capture_output=True,
                            text=True,
                            check=False,
                        )
                        expected = (ROOT / "packages/wsl2-browser/bin" / entry).resolve()
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertEqual(Path(result.stdout.strip()).resolve(strict=True), expected)
                        self.assertTrue(expected.is_absolute())

            invalid = subprocess.run(
                [str(resolver), "../../bin/sh"],
                cwd=temporary,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertEqual(invalid.stdout, "")

    def test_both_supported_skill_hosts_require_explicit_invocation(self):
        skill_file = SKILL_ROOT / "SKILL.md"
        self.assertTrue(skill_file.is_file())
        skill = skill_file.read_text(encoding="utf-8")
        frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.DOTALL)
        self.assertIsNotNone(frontmatter)
        self.assertRegex(frontmatter.group(1), r"(?m)^name: pr-screenshots$")
        self.assertRegex(frontmatter.group(1), r"(?m)^disable-model-invocation: true$")

        codex_metadata = (SKILL_ROOT / "agents/openai.yaml").read_text(encoding="utf-8")
        self.assertRegex(
            codex_metadata,
            r"(?ms)^policy:\n\s+allow_implicit_invocation: false\s*$",
        )

    def test_dependency_guide_explains_optional_capture_and_wsl2_requirements(self):
        dependencies = (SKILL_ROOT / "DEPENDENCIES.md").read_text(encoding="utf-8")

        for requirement in (
            "GitHub CLI `gh`",
            "Node.js 20.19",
            "WSL2",
            "mirrored networking",
            "playwright-cli",
            "Nix は不要",
            "手動",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, dependencies)

    def test_skill_document_links_resolve_inside_the_plugin(self):
        for document in SKILL_ROOT.rglob("*.md"):
            content = document.read_text(encoding="utf-8")
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
                if target.startswith(("https://", "http://", "#", "mailto:")):
                    continue
                local_target = target.split("#", 1)[0]
                if local_target:
                    with self.subTest(document=document.relative_to(ROOT), target=target):
                        self.assertTrue((document.parent / local_target).resolve().is_file())

    def test_existing_evaluation_cases_are_preserved(self):
        evaluation_root = SKILL_ROOT / "evals"
        scenarios = json.loads((evaluation_root / "scenarios.json").read_text(encoding="utf-8"))
        results = json.loads((evaluation_root / "results.json").read_text(encoding="utf-8"))
        evaluation = (evaluation_root / "evaluation.md").read_text(encoding="utf-8")

        self.assertEqual(set(scenarios), {"A", "B", "C", "D"})
        self.assertTrue(any("ID" in requirement for requirement in scenarios["B"]["requirements"]))
        self.assertTrue(any("認証不足" in requirement for requirement in scenarios["C"]["requirements"]))
        self.assertIn("送信結果不明", scenarios["B"]["scenario"])
        self.assertTrue(any(run.get("scenario") == "D" for run in results["runs"]))
        self.assertTrue(evaluation.startswith("# pr-screenshots 配備前の実行評価"))

if __name__ == "__main__":
    unittest.main()
