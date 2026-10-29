import re
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
CONTRACT = ROOT / "contracts" / "autonomous-peer-contract.md"
PEER_NAMES = ("herdr-peer-refactor", "orca-peer-refactor")


class PeerRefactorSkillTests(unittest.TestCase):
    def test_peer_skill_references_resolve_from_the_loaded_skill_files(self):
        for name in PEER_NAMES:
            skill_dir = SKILLS / name
            skill_file = skill_dir / "SKILL.md"
            text = skill_file.read_text(encoding="utf-8")
            self.assertIn("autonomous-peer-contract.md", text)
            for path in skill_dir.rglob("*.md"):
                for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
                    if target.startswith(("https://", "http://", "mailto:", "#")):
                        continue
                    local_target = target.split("#", 1)[0]
                    if local_target:
                        with self.subTest(path=path.relative_to(ROOT), target=target):
                            self.assertTrue((path.parent / local_target).resolve().is_file())
        self.assertTrue(CONTRACT.is_file())

    def test_peer_wait_limits_match_the_shared_contract(self):
        contract = CONTRACT.read_text(encoding="utf-8")
        script = (SKILLS / PEER_NAMES[0] / "scripts" / "peer-request.sh").read_text(encoding="utf-8")
        rows = dict()
        in_table = False
        for line in contract.splitlines():
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if [re.sub(r"\s+", "", cell) for cell in cells] == ["上限", "値"]:
                in_table = True
                continue
            if in_table and not line.lstrip().startswith("|"):
                break
            if in_table and cells and not set("".join(cells)) <= {"-", " "}:
                if len(cells) == 2:
                    rows[re.sub(r"\s+", "", cells[0])] = cells[1]

        expected = {
            "peer1回の待機": ("PEER_TIMEOUT_S", 1200),
            "1候補の累積待機": ("TOTAL_WAIT_S", 7200),
            "ReviewRound": ("MAX_ROUNDS", 3),
        }
        for label, (constant, seconds) in expected.items():
            value = rows[label]
            match = re.fullmatch(r"(\d+)\s*(分|時間|回)", value)
            self.assertIsNotNone(match, value)
            units = {"分": 60, "時間": 3600, "回": 1}
            self.assertEqual(int(match.group(1)) * units[match.group(2)], seconds)
            found = re.findall(rf"^[ \t]*{constant}=(\d+)$", script, re.M)
            self.assertEqual(found, [str(seconds)])

    def test_shared_public_helpers_have_the_same_behavior_source(self):
        shared_helpers = (
            "candidate-record.py",
            "check-architecture-report.py",
            "check-owned.sh",
            "gh-once.sh",
            "run-evidence.py",
        )
        for filename in shared_helpers:
            with self.subTest(helper=filename):
                herdr = (SKILLS / PEER_NAMES[0] / "scripts" / filename).read_bytes()
                orca = (SKILLS / PEER_NAMES[1] / "scripts" / filename).read_bytes()
                self.assertEqual(herdr, orca)

    def test_static_html_inspection_reports_that_rendering_is_pending(self):
        report = ROOT / "tests" / "fixtures" / "architecture-render" / "valid.html"
        checker = SKILLS / PEER_NAMES[0] / "scripts" / "check-architecture-report.py"
        result = subprocess.run(
            ["python3", str(checker), str(report)],
            capture_output=True,
            text=True,
            check=True,
        )
        receipt = json.loads(result.stdout)
        self.assertGreater(receipt["expected_mermaid_diagrams"], 0)
        self.assertEqual(receipt["static_check"], "passed")
        self.assertEqual(receipt["render_check"], "not_performed")
        self.assertTrue((SKILLS / PEER_NAMES[0] / "scripts" / "check-architecture-render.js").is_file())

    def test_html_static_checker_accepts_text_and_rejects_markup_inside_mermaid(self):
        checker = SKILLS / PEER_NAMES[0] / "scripts" / "check-architecture-report.py"
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = Path(temporary_directory) / "report.html"
            report.write_text(
                '<pre class="mermaid">flowchart TD\nA["&lt;label&gt;"] --> B\n</pre>',
                encoding="utf-8",
            )
            accepted = subprocess.run(
                ["python3", str(checker), str(report)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(json.loads(accepted.stdout)["expected_mermaid_diagrams"], 1)

            report.write_text(
                '<pre class="mermaid">flowchart TD<br />A --> B</pre>',
                encoding="utf-8",
            )
            rejected = subprocess.run(
                ["python3", str(checker), str(report)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == "__main__":
    unittest.main()
