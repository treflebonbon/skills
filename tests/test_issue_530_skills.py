import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"


class StandaloneSkillTransferTests(unittest.TestCase):
    def read_skill(self, name: str) -> str:
        return (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")

    def test_three_public_skill_entries_name_their_skill(self) -> None:
        for name in ("marp", "md-agents-review", "md-claude-review"):
            with self.subTest(skill=name):
                content = self.read_skill(name)
                match = re.match(r"\A---\n(.*?)\n---\n", content, re.DOTALL)
                self.assertIsNotNone(match, "SKILL.md must begin with frontmatter")
                if match is None:
                    continue
                frontmatter = match.group(1)
                self.assertRegex(frontmatter, rf"(?m)^name: {re.escape(name)}$")
                self.assertRegex(frontmatter, r"(?m)^description: .+")

    def test_marp_explains_official_cli_setup_and_pdf_prerequisites(self) -> None:
        content = self.read_skill("marp")
        self.assertIn("@marp-team/marp-cli", content)
        self.assertIn("4.5.1", content)
        self.assertIn("https://nodejs.org/", content)
        self.assertIn("https://github.com/marp-team/marp-cli/blob/v4.5.1/README.md", content)
        self.assertIn("最新 stable", content)
        self.assertIn("公式 vendor", content)
        self.assertIn("https://www.google.com/chrome/", content)
        self.assertIn("https://www.microsoft.com/edge/download", content)
        self.assertIn("https://www.mozilla.org/firefox/new/", content)
        self.assertRegex(content, r"Node\.js.{0,24}18")
        self.assertRegex(content, r"npx.{0,100}--pdf|--pdf.{0,100}npx")
        self.assertIn("Chrome", content)
        self.assertIn("Nix は不要", content)
        self.assertIn("HTML 出力だけなら browser は必須ではない", content)
        self.assertIn("対象プロジェクト", content)

        template = (SKILLS / "marp" / "references" / "design-template.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("theme: dracula", template)
        self.assertIn("default", template)

    def test_instruction_review_skills_keep_their_roles_and_cross_reference(self) -> None:
        agents = self.read_skill("md-agents-review")
        claude = self.read_skill("md-claude-review")
        self.assertIn("AGENTS.md", agents)
        self.assertIn("md-claude-review", agents)
        self.assertIn("CLAUDE.md", claude)
        self.assertIn("md-agents-review", claude)
        for name in ("md-agents-review", "md-claude-review"):
            criteria = SKILLS / name / "references" / "criteria.md"
            self.assertTrue(criteria.is_file())

    def test_skill_local_links_resolve_from_their_markdown_files(self) -> None:
        for name in ("marp", "md-agents-review", "md-claude-review"):
            for path in (SKILLS / name).rglob("*.md"):
                content = path.read_text(encoding="utf-8")
                for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
                    if target.startswith(("https://", "http://", "#")):
                        continue
                    relative_path = target.split("#", 1)[0]
                    if relative_path.startswith(("references/", "../")):
                        with self.subTest(path=path.relative_to(ROOT), target=target):
                            self.assertTrue((path.parent / relative_path).resolve().is_file())

    def test_claude_api_remains_optional_with_the_existing_fallback(self) -> None:
        content = self.read_skill("md-claude-review") + (
            SKILLS / "md-claude-review" / "references" / "criteria.md"
        ).read_text(encoding="utf-8")
        self.assertIn("claude-api", content)
        self.assertRegex(
            content,
            r"(?is)claude-api.{0,300}(?:unavailable|not available|使えない|利用できない)",
        )
        self.assertRegex(
            content, r"(?is)(?:fallback|代替|fallback procedure|最新化手順)"
        )
        self.assertIn("https://code.claude.com/docs/en/best-practices", content)

    def test_existing_claude_review_evaluation_files_resolve_from_the_skill(self) -> None:
        skill_dir = SKILLS / "md-claude-review"
        evals_path = skill_dir / "evals" / "evals.json"
        evals_content = evals_path.read_text(encoding="utf-8")
        evals = json.loads(evals_content)
        self.assertEqual(evals["skill_name"], "md-claude-review")
        self.assertEqual(len(evals["evals"]), 4)
        self.assertNotIn("AskUserQuestion", evals_content)
        self.assertNotIn("docs/architecture.md", evals_content)
        for evaluation in evals["evals"]:
            for relative_path in evaluation["files"]:
                with self.subTest(evaluation=evaluation["name"], file=relative_path):
                    self.assertTrue((skill_dir / relative_path).is_file())

    def test_skill_payload_has_no_dotfiles_installation_paths(self) -> None:
        for name in ("marp", "md-agents-review", "md-claude-review"):
            for path in (SKILLS / name).rglob("*.md"):
                with self.subTest(path=path.relative_to(ROOT)):
                    content = path.read_text(encoding="utf-8")
                    self.assertNotIn("~/.claude/skills", content)
                    self.assertNotIn("local-skills/", content)
                    self.assertNotIn("dotfiles checkout", content)


if __name__ == "__main__":
    unittest.main()
