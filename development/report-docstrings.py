"""ステージ済み Python 関数の変更と docstring の有無を診断する。"""

from __future__ import annotations

import argparse
import ast
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib/python"))

from treflebonbon_skills.git_context import InvalidContext, Repository, git_environment


def git(repository: Repository, *arguments: str) -> bytes:
    """Git の参照先を固定し、index と履歴の内容を副作用なしに読む。"""
    environment = git_environment()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    if "GIT_INDEX_FILE" in os.environ:
        index = repository.root / os.environ["GIT_INDEX_FILE"]
        try:
            resolved = index.resolve(strict=True)
            if index.is_symlink() or not resolved.is_file() or resolved.parent != repository.git_dir:
                raise ValueError("現在の worktree の index を確認できません")
        except (OSError, RuntimeError) as error:
            raise ValueError("現在の worktree の index を確認できません") from error
        environment["GIT_INDEX_FILE"] = str(resolved)
    result = subprocess.run(
        ["git", *arguments], cwd=repository.root, env=environment,
        capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError("Git から比較用の内容を取得できません")
    return result.stdout


def functions(source: bytes, path: str) -> dict[tuple[str, int], ast.FunctionDef | ast.AsyncFunctionDef]:
    """ソースを実行せずに関数を取得し、診断不能な構文を区別する。"""
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError) as error:
        line = getattr(error, "lineno", None)
        raise ValueError(f"Python の構文を解析できません: {path}:{line or '?'}") from error
    found = {}
    occurrences = Counter()

    def collect(parent: ast.AST, scope: tuple[str, ...] = ()) -> None:
        """条件分岐内も辿り、メソッド・入れ子・同名定義の所属を保持する。"""
        for node in ast.iter_child_nodes(parent):
            nested_scope = scope
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                nested_scope = (*scope, node.name)
                if not isinstance(node, ast.ClassDef):
                    name = ".".join(nested_scope)
                    found[(name, occurrences[name])] = node
                    occurrences[name] += 1
            collect(node, nested_scope)

    collect(tree)
    return found


def is_python(source: bytes, path: str) -> bool:
    """拡張子か一般的な Python shebang で、解析する言語を確認する。"""
    return Path(path).suffix == ".py" or bool(re.match(
        rb"^#!\s*(?:\S*/)?(?:env\s+(?:-S\s+)?)?(?:python|pypy)(?:[0-9]+(?:\.[0-9]+)*)?(?:\s|$)",
        source.split(b"\n", 1)[0],
    ))


def report(reference: str) -> dict:
    """比較元と index の構文を比べ、変更した関数だけを列挙する。"""
    repository = Repository.discover(Path.cwd())
    head = git(repository, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    try:
        base = git(repository, "rev-parse", "--verify", "--end-of-options", reference + "^{commit}").decode().strip()
    except ValueError as error:
        raise ValueError("比較元の commit を確認できません") from error
    records = git(repository, "diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", base, "--").split(b"\0")
    changed = []
    for index in range(0, len(records) - 1, 2):
        metadata = records[index].decode("ascii").split()
        old_mode, new_mode = metadata[0][1:], metadata[1]
        old_blob, new_blob, status = metadata[2:5]
        path = os.fsdecode(records[index + 1])
        if status == "D" or Path(path).suffix not in ("", ".py"):
            continue
        if new_mode not in ("100644", "100755"):
            if Path(path).suffix == ".py":
                raise ValueError(f"通常の Python ファイルとして診断できません: {path}")
            continue
        current = git(repository, "cat-file", "blob", new_blob)
        if not is_python(current, path):
            continue
        old_source = git(repository, "cat-file", "blob", old_blob) if old_mode in ("100644", "100755") else b""
        previous = functions(old_source, path) if is_python(old_source, path) else {}
        for name, node in functions(current, path).items():
            old_node = previous.get(name)
            if old_node is not None and ast.dump(old_node) == ast.dump(node):
                continue
            changed.append({"path": path, "name": name[0], "line": node.lineno,
                            "has_docstring": bool((ast.get_docstring(node) or "").strip())})
    return {"head": head, "base": base, "source": "index",
            "missing_docstrings": sum(not item["has_docstring"] for item in changed),
            "functions": changed}


def main() -> int:
    """説明不足の報告と、Git・構文の問題による診断不能を区別する。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="HEAD", help="index と比較する commit（既定: HEAD）")
    arguments = parser.parse_args()
    try:
        print(json.dumps(report(arguments.base)))
    except InvalidContext:
        print("ERROR: Git repository の管理情報を確認できません", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
