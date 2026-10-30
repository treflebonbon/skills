import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"


class StandaloneSkillTransferTests(unittest.TestCase):
    def read_skill(self, name: str) -> str:
        return (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")

    def test_marp_templates_are_packaged_beside_the_skill(self) -> None:
        skill = self.read_skill("marp")
        marp_dir = SKILLS / "marp"
        for resource in ("references/design-template.md", "references/slide-guidelines.md"):
            with self.subTest(resource=resource):
                self.assertIn(resource, skill)
                self.assertTrue((marp_dir / resource).is_file())

    def test_instruction_reviews_keep_their_distinct_scopes(self) -> None:
        agents = self.read_skill("md-agents-review")
        claude = self.read_skill("md-claude-review")
        self.assertIn("AGENTS.md", agents)
        self.assertIn("md-claude-review", agents)
        self.assertIn("CLAUDE.md", claude)
        self.assertIn("md-agents-review", claude)

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

    def test_claude_api_remains_optional_and_the_document_fallback_remains_available(
        self,
    ) -> None:
        skill = self.read_skill("md-claude-review")
        criteria = (
            SKILLS / "md-claude-review" / "references" / "criteria.md"
        ).read_text(encoding="utf-8")
        self.assertIn("claude-api", skill)
        self.assertIn("prompt-audit", criteria)
        self.assertIn("https://code.claude.com/docs/en/best-practices", criteria)
        self.assertNotIn("claude-api", skill.split("---", 2)[1])

    def test_existing_claude_review_evaluation_inputs_resolve_from_the_skill(self) -> None:
        skill_dir = SKILLS / "md-claude-review"
        evals = json.loads(
            (skill_dir / "evals" / "evals.json").read_text(encoding="utf-8")
        )
        self.assertEqual(evals["skill_name"], "md-claude-review")
        self.assertTrue(evals["evals"])
        for evaluation in evals["evals"]:
            for relative_path in evaluation["files"]:
                with self.subTest(evaluation=evaluation["name"], file=relative_path):
                    self.assertTrue((skill_dir / relative_path).is_file())

    def test_skill_payload_does_not_require_dotfiles_installation_paths(self) -> None:
        for name in ("marp", "md-agents-review", "md-claude-review"):
            for path in (SKILLS / name).rglob("*.md"):
                with self.subTest(path=path.relative_to(ROOT)):
                    content = path.read_text(encoding="utf-8")
                    self.assertNotIn("~/.claude/skills", content)
                    self.assertNotIn("local-skills/", content)
                    self.assertNotIn("dotfiles checkout", content)


if __name__ == "__main__":
    unittest.main()
