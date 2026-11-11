import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class DocstringReportTest(unittest.TestCase):
    def setUp(self):
        """実際の npm 入口と package の Python module を使う Git fixture を作る。"""
        self.temporary = tempfile.TemporaryDirectory(prefix="docstring-report.")
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        (self.repo / "package.json").write_text((ROOT / "package.json").read_text())
        (self.repo / "development").mkdir()
        script = ROOT / "development/report-docstrings.py"
        if script.exists():
            shutil.copy2(script, self.repo / "development/report-docstrings.py")
        package = self.repo / "lib/python/treflebonbon_skills"
        package.mkdir(parents=True)
        for name in ("__init__.py", "git_context.py"):
            shutil.copy2(ROOT / "lib/python/treflebonbon_skills" / name, package / name)
        self.git("init", "-q")
        self.commit()

    def git(self, *arguments):
        """fixture の Git だけを操作し、引き継がれた Git の参照先を使わない。"""
        return subprocess.check_output(["git", *arguments], cwd=self.repo, env=self.environment, text=True).strip()

    def stage(self, source, path="sample.py"):
        """指定したソースを index に保存し、作業ツリーとの違いを作れるようにする。"""
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)
        self.git("add", "--", path)

    def commit(self):
        """テスト用の比較元を fixture 内だけに作る。"""
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-q", "--allow-empty", "-m", "test: base")

    def report(self, *arguments):
        """合意済みの npm コマンドから JSON 診断を実行する。"""
        return subprocess.run(
            ["npm", "run", "--silent", "report:docstrings", "--", *arguments],
            cwd=self.repo, env=self.environment, text=True, capture_output=True,
        )

    def test_missing_docstrings_are_reported_without_failing(self):
        """説明不足を検査不能と混同せず、変更した関数だけを報告する。"""
        source = 'def unchanged():\n    """保つ説明。"""\n    return 0\n\ndef changed():\n    return 1\n'
        self.stage(source)
        self.commit()
        self.stage(source.replace("return 1", "return 2"))
        base = self.git("rev-parse", "HEAD")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["head"], base)
        self.assertEqual(report["base"], base)
        self.assertEqual(report["missing_docstrings"], 1)
        self.assertEqual(report["functions"], [
            {"path": "sample.py", "name": "changed", "line": 5, "has_docstring": False},
        ])

    def test_index_content_is_reported_without_executing_source_or_changing_files(self):
        """作業ツリーやソースの実行結果に依存せず、index を読み取る。"""
        self.stage('raise SystemExit("実行してはいけない")\n\ndef staged():\n    return 1\n')
        working = 'def working():\n    """作業ツリーだけの説明。"""\n    return 2\n'
        (self.repo / "sample.py").write_text(working)
        before = self.git("diff", "--cached", "--raw")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [
            {"path": "sample.py", "name": "staged", "line": 3, "has_docstring": False},
        ])
        self.assertEqual((self.repo / "sample.py").read_text(), working)
        self.assertEqual(self.git("diff", "--cached", "--raw"), before)

    def test_explicit_base_reports_committed_changes_with_a_clean_index(self):
        """比較元の指定により、clean な index でも既存コミットの差分を診断する。"""
        self.stage("def changed():\n    return 1\n")
        self.commit()
        base = self.git("rev-parse", "HEAD")
        self.stage("def changed():\n    return 2\n")
        self.commit()
        current = self.report()
        self.assertEqual(current.returncode, 0, current.stderr)
        self.assertEqual(json.loads(current.stdout)["functions"], [])

        result = self.report("--base", base)

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["base"], base)
        self.assertEqual(report["functions"], [
            {"path": "sample.py", "name": "changed", "line": 1, "has_docstring": False},
        ])

    def test_methods_and_nested_async_functions_keep_their_qualified_names(self):
        """クラスと入れ子の所属を残し、関数名を区別できるようにする。"""
        self.stage('class Worker:\n    async def run(self):\n        """処理を開始する。"""\n        def helper():\n            return 1\n        return helper()\n')

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [
            {"path": "sample.py", "name": "Worker.run", "line": 2, "has_docstring": True},
            {"path": "sample.py", "name": "Worker.run.helper", "line": 4, "has_docstring": False},
        ])

    def test_formatting_and_deletion_are_omitted_but_docstring_changes_are_reported(self):
        """表示位置やコメントではなく構文を比べ、説明の追加も変更として扱う。"""
        self.stage("def retained():\n    return 1\n\ndef deleted():\n    return 2\n")
        self.commit()
        self.stage("# コメントを追加\n\ndef retained( ):\n    return (1)\n")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [])
        self.stage('def retained():\n    """値を返す。"""\n    return 1\n')
        documented = self.report()
        self.assertEqual(documented.returncode, 0, documented.stderr)
        self.assertEqual(json.loads(documented.stdout)["functions"], [
            {"path": "sample.py", "name": "retained", "line": 1, "has_docstring": True},
        ])

    def test_extensionless_python_is_included_and_other_file_types_are_ignored(self):
        """Python を含むパス名だけで別言語を Python と誤認しない。"""
        self.stage('#!/usr/bin/env -S python3 -I\ndef run():\n    """起動する。"""\n    return 1\n', "bin/python cli")
        self.stage("#!/opt/python-tools/bin/bash\necho ready\n", "bin/shell")
        (self.repo / "shell-link").symlink_to("bin/shell")
        self.git("add", "--", "shell-link")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [
            {"path": "bin/python cli", "name": "run", "line": 2, "has_docstring": True},
        ])

    def test_invalid_base_is_an_error_instead_of_an_empty_success(self):
        """存在しない比較元には、正常な空の診断と異なる理由を返す。"""
        valid = self.report("--base", "HEAD")
        self.assertEqual(valid.returncode, 0, valid.stderr)

        result = self.report("--base", "missing-reference")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("比較元の commit を確認できません", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_extensionless_script_converted_to_python_has_no_previous_python_functions(self):
        """別言語から Python へ変えたファイルでは、新しい関数を診断する。"""
        self.stage("#!/bin/sh\necho ready\n", "bin/converted")
        self.commit()
        self.stage("#!/usr/bin/python3\ndef run():\n    return 1\n", "bin/converted")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [
            {"path": "bin/converted", "name": "run", "line": 2, "has_docstring": False},
        ])

    def test_invalid_syntax_is_reported_without_echoing_source(self):
        """構文が不正な行を表示せず、診断不能の位置と理由を返す。"""
        self.stage("def valid():\n    return 1\n")
        valid = self.report()
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.stage("def broken(  # SOURCE_SHOULD_STAY_PRIVATE\n")

        result = self.report()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python の構文を解析できません: sample.py:1", result.stderr)
        self.assertNotIn("SOURCE_SHOULD_STAY_PRIVATE", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_git_metadata_is_required_for_the_npm_diagnostic(self):
        """Git の管理情報がない状態を、有効な空の index と区別する。"""
        valid = self.report()
        self.assertEqual(valid.returncode, 0, valid.stderr)
        (self.repo / ".git").rename(self.repo / "saved-git")

        result = self.report()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Git repository の管理情報を確認できません", result.stderr)

    def test_git_hook_can_select_its_index_inside_the_current_git_directory(self):
        """部分 commit 用の index を、通常の index と取り違えない。"""
        self.stage("def ordinary():\n    return 1\n")
        alternate = self.repo / ".git/report-index"
        shutil.copyfile(self.repo / ".git/index", alternate)
        self.environment["GIT_INDEX_FILE"] = str(alternate)
        self.stage("def selected():\n    return 2\n")

        result = self.report()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["functions"], [
            {"path": "sample.py", "name": "selected", "line": 1, "has_docstring": False},
        ])

    def test_index_outside_the_current_git_directory_is_rejected(self):
        """別の index の指定を、有効な worktree 内の index と区別する。"""
        self.stage("def valid():\n    return 1\n")
        outside = self.repo / "outside-index"
        shutil.copyfile(self.repo / ".git/index", outside)
        self.environment["GIT_INDEX_FILE"] = str(outside)

        result = self.report()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("現在の worktree の index を確認できません", result.stderr)


if __name__ == "__main__":
    unittest.main()
