import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
PAYLOADS = ("ui-grill-with-docs", "domain-modeling-studio")


class IndependentModelingSkillTests(unittest.TestCase):
    def test_skill_resources_resolve_from_their_markdown_files(self) -> None:
        for name in PAYLOADS:
            skill_dir = SKILLS / name
            for path in skill_dir.rglob("*.md"):
                content = path.read_text(encoding="utf-8")
                for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
                    if target.startswith(("https://", "http://", "#", "mailto:")):
                        continue
                    local_target = target.split("#", 1)[0]
                    if local_target:
                        with self.subTest(path=path.relative_to(ROOT), target=target):
                            self.assertTrue((path.parent / local_target).resolve().is_file())

    def test_studio_render_cli_loads_its_template_and_writes_outside_the_payload(self) -> None:
        studio_dir = SKILLS / "domain-modeling-studio"
        render_script = studio_dir / "scripts" / "render.mjs"
        fixture = studio_dir / "tests" / "fixture.mjs"

        with tempfile.TemporaryDirectory(prefix="issue-531-render-") as tmp:
            scratch = Path(tmp)
            model = scratch / "model.json"
            output = scratch / "review.html"
            write_fixture = (
                f"import {{ example }} from {fixture.as_uri()!r}; "
                "import { writeFileSync } from 'node:fs'; "
                f"writeFileSync({str(model)!r}, JSON.stringify(example()));"
            )
            subprocess.run(["node", "--input-type=module", "-e", write_fixture],
                           cwd=scratch, check=True, capture_output=True, text=True)
            subprocess.run(["node", str(render_script), str(model), str(output)],
                           cwd=scratch, check=True, capture_output=True, text=True)

            self.assertTrue(output.is_file())
            rendered = output.read_text(encoding="utf-8")
            self.assertIn('id="studio-document"', rendered)
            self.assertIn('"sessionId":"example-session"', rendered)
            self.assertFalse((studio_dir / "review.html").exists())

    def test_studio_build_and_third_party_license_are_packaged(self) -> None:
        studio_dir = SKILLS / "domain-modeling-studio"
        self.assertTrue((studio_dir / "package.json").is_file())
        self.assertTrue((studio_dir / "package-lock.json").is_file())
        self.assertTrue((studio_dir / "dist" / "studio.html").is_file())
        license_file = studio_dir / "dist" / "THIRD-PARTY-LICENSES.txt"
        self.assertTrue(license_file.is_file())
        notices = license_file.read_text(encoding="utf-8").strip()
        self.assertTrue(notices)
        html = (studio_dir / "dist" / "studio.html").read_text(encoding="utf-8")
        self.assertIn(notices.replace("--", "—"), html)

    def test_external_skills_remain_separate_from_the_package(self) -> None:
        for name in ("grilling", "domain-modeling", "codebase-design", "playwright-cli"):
            with self.subTest(skill=name):
                self.assertFalse((SKILLS / name).exists())


if __name__ == "__main__":
    unittest.main()
