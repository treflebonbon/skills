import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "dogfood",
    "domain-modeling-studio",
    "herdr-peer-refactor",
    "marp",
    "md-agents-review",
    "md-claude-review",
    "orca-peer-refactor",
    "pr-screenshots",
    "rop",
    "ui-grill-with-docs",
    "worktree-gc",
}
CANDIDATE_VERSION = "0.2.3"
PREVIOUS_CANDIDATE_VERSION = "0.2.2"
RUN_PLUGIN_CLI_E2E = os.environ.get("TREFLEBONBON_PLUGIN_CLI_E2E") == "1"


def is_local_environment_name(name):
    return name == ".env" or name.startswith(".env.")


def snapshot(root=ROOT):
    contents = {}
    for directory, dirs, files in os.walk(root):
        dirs[:] = [
            d
            for d in dirs
            if d not in {".git", "node_modules"} and not is_local_environment_name(d)
        ]
        for name in files:
            if is_local_environment_name(name):
                continue
            path = Path(directory) / name
            contents[str(path.relative_to(root))] = (
                hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode
            )
    return contents


class PluginPackageContractTest(unittest.TestCase):
    def test_skill_directories_are_the_exact_public_set(self):
        names = {
            skill_file.parent.name
            for skill_file in (ROOT / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(names, EXPECTED_SKILLS)

        for name in EXPECTED_SKILLS:
            skill = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.DOTALL)
            self.assertIsNotNone(frontmatter, name)
            self.assertRegex(frontmatter.group(1), rf"(?m)^name: {re.escape(name)}$")
            self.assertRegex(frontmatter.group(1), r"(?m)^description:\s*\S")

    def test_every_manifest_and_package_uses_candidate_version(self):
        manifests = (
            ROOT / "plugin.json",
            ROOT / ".claude-plugin/plugin.json",
        )
        for path in manifests:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertEqual(json.loads(path.read_text())["version"], CANDIDATE_VERSION)

        marketplace = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
        self.assertEqual(len(marketplace["plugins"]), 1)
        self.assertEqual(marketplace["plugins"][0]["version"], CANDIDATE_VERSION)

        codex_marketplace = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())
        self.assertEqual(len(codex_marketplace["plugins"]), 1)
        codex_entry = codex_marketplace["plugins"][0]
        self.assertEqual(codex_entry["source"], {"source": "local", "path": "./"})
        self.assertEqual(
            codex_entry["policy"],
            {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
        )
        self.assertEqual(codex_entry["category"], "Productivity")

        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["version"], CANDIDATE_VERSION)

    def test_formatter_dependencies_live_outside_the_plugin_root(self):
        package = json.loads((ROOT / "package.json").read_text())
        self.assertNotIn("devDependencies", package)
        self.assertFalse((ROOT / "package-lock.json").exists())

        development = json.loads((ROOT / "development/package.json").read_text())
        self.assertTrue(development["private"])
        self.assertEqual(development["devDependencies"], {"oxfmt": "0.67.0"})
        lock = json.loads((ROOT / "development/package-lock.json").read_text())
        self.assertEqual(lock["name"], development["name"])
        self.assertEqual(lock["version"], development["version"])
        self.assertEqual(lock["packages"][""]["name"], development["name"])
        self.assertEqual(lock["packages"][""]["version"], development["version"])
        self.assertEqual(
            lock["packages"][""]["devDependencies"], development["devDependencies"]
        )
        self.assertEqual(lock["packages"]["node_modules/oxfmt"]["version"], "0.67.0")

    def test_quality_commands_and_docs_install_the_development_formatter(self):
        package = json.loads((ROOT / "package.json").read_text())
        format_targets = package["scripts"]["format"].split()[1:]
        format_check_targets = package["scripts"]["format:check"].split()[2:]
        self.assertEqual(format_check_targets, format_targets)

        for script in ("format", "format:check"):
            with self.subTest(script=script):
                self.assertIn("development/node_modules/.bin/oxfmt", package["scripts"][script])
                self.assertIn("development/package.json", package["scripts"][script])
                self.assertIn("development/package-lock.json", package["scripts"][script])

        for path in (ROOT / "README.md", ROOT / "docs/verification.md"):
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertIn("npm ci --prefix development", path.read_text(encoding="utf-8"))

    def test_manual_only_skills_keep_each_runtime_policy(self):
        for name in ("pr-screenshots", "ui-grill-with-docs"):
            skill = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.DOTALL)
            self.assertIsNotNone(frontmatter, name)
            self.assertRegex(frontmatter.group(1), r"(?m)^disable-model-invocation: true$")

            codex_policy = (ROOT / "skills" / name / "agents/openai.yaml").read_text(
                encoding="utf-8"
            )
            self.assertRegex(
                codex_policy,
                r"(?ms)^policy:\n\s+allow_implicit_invocation: false\s*$",
            )

    def test_codex_invocation_guidance_uses_the_plugin_namespace(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertRegex(
            readme,
            r"(?m)^\| Codex\s+\| `\$treflebonbon-skills:<skill-name>`\s+\|$",
        )

        for path in (
            ROOT / "skills/dogfood/SKILL.md",
            ROOT / "skills/dogfood/references/verification.md",
        ):
            with self.subTest(path=path.relative_to(ROOT)):
                text = path.read_text(encoding="utf-8")
                self.assertRegex(
                    text,
                    r"(?m)^Codex: \$treflebonbon-skills:dogfood(?:\s|$)",
                )
                self.assertNotRegex(text, r"(?m)^Codex: \$dogfood\b")

    def test_verification_entrypoint_preserves_previous_candidate_evidence(self):
        verification = (ROOT / "docs/verification.md").read_text(encoding="utf-8")
        self.assertIn(f"Candidate {CANDIDATE_VERSION} の再受入境界", verification)
        self.assertIn(f"候補版 `{CANDIDATE_VERSION}`", verification)
        self.assertIn(f"Candidate {PREVIOUS_CANDIDATE_VERSION} の受入境界", verification)
        self.assertIn(f"候補版 `{PREVIOUS_CANDIDATE_VERSION}`", verification)

    def test_readme_documents_all_skills_platforms_and_dependency_routes(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(CANDIDATE_VERSION, readme)
        for name in EXPECTED_SKILLS:
            with self.subTest(skill=name):
                self.assertIn(f"`{name}`", readme)
        for requirement in (
            "Linux x86_64",
            "Linux aarch64",
            "macOS aarch64",
            "WSL2",
            "Nix は必要ありません",
            "4.5.1",
            "1.63.0",
            "0.1.22",
            "Bash 4.0",
            "readlink -f",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, readme)

        install_routes = (
            "claude plugin marketplace add treflebonbon/skills",
            "claude plugin marketplace add /absolute/path/to/skills",
            "codex plugin marketplace add treflebonbon/skills",
            "codex plugin marketplace add /absolute/path/to/skills",
            "agy plugin install https://github.com/treflebonbon/skills",
            "agy plugin install /absolute/path/to/skills",
        )
        for route in install_routes:
            with self.subTest(route=route):
                self.assertIn(route, readme)

        for detail in (
            "skills/dogfood/references/dependencies.md",
            "skills/domain-modeling-studio/references/dependencies.md",
            "skills/herdr-peer-refactor/references/dependencies.md",
            "skills/herdr-peer-refactor/references/auto-session.md",
            "contracts/auto-peer-protection.md",
            "docs/raw-codex-isolation.md",
            "Python 3.9+",
            "Python 3.11+ (`tomllib`)",
        ):
            with self.subTest(detail=detail):
                self.assertIn(detail, readme)

    def test_optional_ast_grep_and_xvfb_dependencies_are_route_scoped(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("ast-grep", readme)
        self.assertIn("0.42.1", readme)
        self.assertIn("Xvfb", readme)
        self.assertIn("xauth", readme)

        studio_path = ROOT / "skills/domain-modeling-studio/references/dependencies.md"
        studio = studio_path.read_text(encoding="utf-8")
        self.assertIn("ast-grep 0.42.1", studio)
        self.assertIn("npm install --global @ast-grep/cli@0.42.1", studio)
        self.assertIn("ソースコードを読んで調査を続けます", studio)
        self.assertIn("構文抽出 helper 自体も実行していません", studio)

        dogfood_dependencies = (
            ROOT / "skills/dogfood/references/dependencies.md"
        ).read_text(encoding="utf-8")
        for requirement in (
            "sudo apt install xvfb xauth",
            "brew install xorg-server",
            "2:21.1.12-1ubuntu1.6",
            "1:1.1.2-1build1",
            "2:21.1.7-3+deb12u13",
            "1:1.1.2-1",
            "非 WSL2",
            "headed retry",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, dogfood_dependencies)

    def test_non_wsl_headed_retry_checks_xvfb_before_running(self):
        skill = (ROOT / "skills/dogfood/SKILL.md").read_text(encoding="utf-8")
        initial_run = skill.index(
            'node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}"'
        )
        retry_start = skill.index('if [ "$runner_status" -eq 2 ]; then')
        retry_end = skill.index('if [ "$runner_status" -ne 0 ]; then', retry_start)
        retry = skill[retry_start:retry_end]
        wsl_branch = retry.index('if [[ -n "${WSL_DISTRO_NAME:-}" ]] || {')
        xvfb_run = retry.index(
            'xvfb-run -a node "$SKILL_DIR/scripts/dogfood-runtime.mjs"'
        )
        guard = retry.index("if ! command -v xvfb-run")

        self.assertLess(initial_run, retry_start)
        self.assertLess(0, wsl_branch)
        self.assertLess(wsl_branch, guard)
        self.assertLess(guard, xvfb_run)
        for binary in ("xvfb-run", "Xvfb", "xauth"):
            with self.subTest(binary=binary):
                check = retry.find(f"command -v {binary}")
                self.assertGreaterEqual(check, 0)
                self.assertLess(check, xvfb_run)
        self.assertIn("sudo apt install xvfb xauth", retry[:xvfb_run])
        self.assertIn("runner_status=127", retry[guard:xvfb_run])
        self.assertIn(
            'node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}" --headed',
            skill,
        )

    def test_all_package_markdown_links_resolve_inside_the_package(self):
        tracked = subprocess.run(
            ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
        ).stdout.split(b"\0")
        paths = [Path(item.decode("utf-8")) for item in tracked if item]
        self.assertFalse(
            any(is_local_environment_name(path.name) for path in paths),
            "tracked package inputs must not include local environment files",
        )

        link_pattern = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
        for relative in paths:
            if relative.suffix != ".md" or {"evals", "dist", "vendor"}.intersection(
                relative.parts
            ):
                continue
            document = ROOT / relative
            content = re.sub(
                r"```.*?```", "", document.read_text(encoding="utf-8"), flags=re.DOTALL
            )
            for target in link_pattern.findall(content):
                target = target.strip().strip("<>")
                if target.startswith(("https://", "http://", "mailto:", "#", "//")):
                    continue
                local_target = target.split("#", 1)[0].split("?", 1)[0]
                if local_target:
                    with self.subTest(document=relative, target=target):
                        self.assertTrue((document.parent / local_target).resolve().is_file())

    def test_default_quality_entry_runs_nested_node_and_fixture_bats(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package["scripts"]
        self.assertIn("test:python", scripts["test"])
        self.assertIn("test:node", scripts["test"])
        self.assertIn("test:bats", scripts["test"])
        self.assertIn("skills/dogfood/tests/runtime.test.mjs", scripts["test:node"])
        self.assertIn("skills/domain-modeling-studio", scripts["test:node"])
        self.assertIn("packages/wsl2-browser", scripts["test:node"])
        for suite in (
            "dogfood.bats",
            "dogfood-results.bats",
            "managed-dogfood-browser.bats",
            "packages/wsl2-browser/tests/*.bats",
            "tests/raw-codex/*.bats",
            "tests/*.bats",
            "tests/cli/*.bats",
        ):
            with self.subTest(suite=suite):
                self.assertIn(suite, scripts["test:bats"])
        self.assertNotIn("dogfood-real-browser.bats", scripts["test:bats"])
        self.assertIn("TREFLEBONBON_PLUGIN_CLI_E2E=1", scripts["test:plugin-cli"])

    def test_formatter_ignores_generated_and_vendor_assets(self):
        config = json.loads((ROOT / ".oxfmtrc.json").read_text(encoding="utf-8"))
        self.assertIn("skills/domain-modeling-studio/dist/**", config["ignorePatterns"])
        self.assertIn("**/vendor/**", config["ignorePatterns"])

    def test_license_and_third_party_notices_are_packaged(self):
        license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("MIT License", license_text)
        self.assertTrue((ROOT / "skills/domain-modeling-studio/dist/THIRD-PARTY-LICENSES.txt").is_file())
        self.assertTrue((ROOT / "packages/wsl2-browser/THIRD_PARTY_NOTICES.md").is_file())

    def test_npm_locks_use_public_registry_urls_and_integrity(self):
        locks = (
            ROOT / "development/package-lock.json",
            ROOT / "skills/dogfood/references/package-lock.json",
            ROOT / "skills/domain-modeling-studio/package-lock.json",
            ROOT / "packages/wsl2-browser/package-lock.json",
        )
        for path in locks:
            lock = json.loads(path.read_text(encoding="utf-8"))
            packages = lock.get("packages", {})
            self.assertTrue(packages, path)
            for name, package in packages.items():
                if not name:
                    continue
                with self.subTest(lock=path.relative_to(ROOT), package=name):
                    self.assertTrue(package["resolved"].startswith("https://registry.npmjs.org/"))
                    self.assertRegex(package["integrity"], r"^sha(256|384|512)-")

    def test_snapshot_skips_local_environment_and_dependency_state(self):
        with tempfile.TemporaryDirectory(prefix="plugin-snapshot.") as temporary:
            root = Path(temporary)
            (root / ".env").write_text("fixture secret\n", encoding="utf-8")
            (root / ".env.local/child").parent.mkdir()
            (root / ".env.local/child").write_text("fixture secret\n", encoding="utf-8")
            (root / "node_modules/vendor.js").parent.mkdir()
            (root / "node_modules/vendor.js").write_text("generated\n", encoding="utf-8")
            (root / "__pycache__/module.pyc").parent.mkdir()
            (root / "__pycache__/module.pyc").write_bytes(b"bytecode")
            (root / "dist/studio.html").parent.mkdir()
            (root / "dist/studio.html").write_text("shipped asset\n", encoding="utf-8")
            (root / "README.md").write_text("public source\n", encoding="utf-8")

            read_bytes = Path.read_bytes

            def guarded_read(path):
                if is_local_environment_name(path.name):
                    raise AssertionError("local environment files must not be read")
                return read_bytes(path)

            with patch.object(Path, "read_bytes", guarded_read):
                contents = snapshot(root)

            self.assertEqual(set(contents), {"README.md", "__pycache__/module.pyc", "dist/studio.html"})


@unittest.skipUnless(
    RUN_PLUGIN_CLI_E2E,
    "run npm run test:plugin-cli for isolated official CLI installation checks",
)
class OfficialPluginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [name for name in ("agy", "claude", "codex") if not shutil.which(name)]
        if missing:
            raise RuntimeError("required official plugin CLIs are missing")

    def setUp(self):
        self.assert_source_is_safe_to_install(ROOT)
        self.before = snapshot()
        self.addCleanup(self.assert_payload_unchanged)
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-plugin.")
        self.addCleanup(self.temporary.cleanup)
        self.environment = {
            name: os.environ[name]
            for name in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP")
            if name in os.environ
        }
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

    def assert_source_is_safe_to_install(self, root):
        for directory, dirs, files in os.walk(root):
            if any(is_local_environment_name(name) for name in (*dirs, *files)):
                raise AssertionError("plugin source contains a local environment file")

    def assert_payload_unchanged(self):
        self.assert_source_is_safe_to_install(ROOT)
        self.assertEqual(snapshot(), self.before, "公式 CLI が配布元を書き換えました")

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
    def test_antigravity_accepts_all_bundled_skills(self):
        result = json.loads(
            self.command("agy", "plugin", "validate", str(ROOT), "--strict", "--json")
        )
        self.assertEqual(result["name"], "treflebonbon-skills")
        self.assertEqual(
            result["components"]["skills"], len(EXPECTED_SKILLS)
        )
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
            json.loads((installed / "plugin.json").read_text())["version"],
            CANDIDATE_VERSION,
        )
        installed_skills = {
            skill_file.parent.name
            for skill_file in (installed / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(installed_skills, EXPECTED_SKILLS)
        for name in (
            "git-push-topic",
            "git-push-reviewed",
            "gh-review-thread",
            "orca-send",
            "codex-reviewer",
        ):
            entrypoint = installed / "bin" / name
            with self.subTest(entrypoint=name):
                self.assertTrue(
                    entrypoint.is_file(),
                    f"Codex の公式導入物から {name} が欠落しています",
                )
                self.assertFalse(
                    entrypoint.is_symlink(),
                    f"{name} は通常ファイルとして導入される必要があります",
                )
                self.assertTrue(
                    os.access(entrypoint, os.X_OK),
                    f"Codex の公式導入物で {name} が実行可能ではありません",
                )
        bats = shutil.which("bats")
        if bats:
            cli_root = Path(self.temporary.name) / "codex-installed-cli-tests"
            cli_root.mkdir()
            for name in ("bin", "contracts", "lib", "packages", "share", "skills"):
                os.symlink(installed / name, cli_root / name, target_is_directory=True)
            shutil.copytree(ROOT / "tests/cli", cli_root / "tests/cli")
            suites = sorted((cli_root / "tests/cli").glob("*.bats"))
            result = subprocess.run(
                [bats, *map(str, suites)],
                cwd=cli_root,
                env=self.environment,
                capture_output=True,
                text=True,
                timeout=240,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in EXPECTED_SKILLS:
            with self.subTest(skill=name):
                self.assertEqual(
                    snapshot(ROOT / "skills" / name),
                    snapshot(installed / "skills" / name),
                )

    @unittest.skipUnless(shutil.which("claude"), "Claude Code が必要")
    def test_claude_installs_rop_from_the_local_marketplace(self):
        self.command("claude", "plugin", "marketplace", "add", str(ROOT), "--json")
        self.command("claude", "plugin", "install", "treflebonbon-skills@treflebonbon", "--json")
        inventory = self.command("claude", "plugin", "details", "treflebonbon-skills@treflebonbon")
        for name in EXPECTED_SKILLS:
            with self.subTest(skill=name):
                self.assertIn(name, inventory)

    @unittest.skipUnless(shutil.which("agy"), "Antigravity CLI が必要")
    def test_antigravity_installs_the_portable_rop_plugin(self):
        self.command("agy", "plugin", "install", str(ROOT))
        plugins = self.command("agy", "plugin", "list", "--json")
        self.assertIn("treflebonbon-skills", plugins)


if __name__ == "__main__":
    unittest.main()
