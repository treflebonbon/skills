#!/usr/bin/env python3
"""Pin a candidate list to its report and source commit."""

import hashlib
import html.parser
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def fail(message):
    raise ValueError(message)


def git(*args):
    result = subprocess.run(
        ["git", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode:
        fail("Git リポジトリまたは commit を確認できません")
    return result.stdout.strip()


def repo_identity():
    common_dir = git("rev-parse", "--git-common-dir")
    return str(Path(common_dir).resolve(strict=True))


def commit_id(value):
    if not re.fullmatch(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})", value):
        fail("source-sha は完全な commit SHA で指定してください")
    return git("rev-parse", "--verify", f"{value}^{{commit}}")


def check_ancestor(source_commit):
    head = git("rev-parse", "--verify", "HEAD^{commit}")
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", source_commit, head],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode:
        fail("source commit は現在の HEAD の祖先ではありません")


class TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def artifact_text(raw):
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail("レポートは UTF-8 で読めません")
    parser = TextExtractor()
    parser.feed(source)
    parser.close()
    return " ".join("".join(parser.parts).split())


def load_json(path, label, read_bytes=None):
    try:
        raw = read_bytes(path) if read_bytes else Path(path).read_bytes()
        return json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail(f"{label} を読めません")


def normalize_text(value):
    return " ".join(value.split())


def validate_candidates(candidates, source_text):
    if not isinstance(candidates, list) or not candidates:
        fail("候補は空でない JSON 配列で指定してください")
    ids, titles = set(), set()
    for index, candidate in enumerate(candidates, 1):
        label = f"候補 {index}"
        if not isinstance(candidate, dict):
            fail(f"{label} はオブジェクトではありません")
        candidate_id = candidate.get("id")
        title = candidate.get("title")
        if not isinstance(candidate_id, str) or not candidate_id.strip():
            fail(f"{label} の id が空です")
        if candidate_id in ids:
            fail(f"候補の id が重複しています: {candidate_id}")
        ids.add(candidate_id)
        if not isinstance(title, str) or not title.strip():
            fail(f"{label} の title が空です")
        title_key = normalize_text(title).casefold()
        if title_key in titles:
            fail(f"候補の title が重複しています: {title}")
        titles.add(title_key)
        for field, nonempty in (("acceptance", True), ("non_goals", False), ("owned_files", True)):
            value = candidate.get(field)
            if not isinstance(value, list) or (nonempty and not value):
                requirement = "空でない配列" if nonempty else "配列"
                fail(f"{label} の {field} は{requirement}にしてください")
            if any(not isinstance(item, str) or not item.strip() for item in value):
                fail(f"{label} の {field} は空でない文字列の配列にしてください")
        if normalize_text(title) not in source_text:
            fail(f"候補 title がレポートにありません: {title}")


def read_artifact(path, read_bytes=None):
    absolute = os.path.abspath(path)
    try:
        raw = read_bytes(absolute) if read_bytes else Path(absolute).read_bytes()
    except OSError:
        fail("レポートを読めません")
    return absolute, raw


def pin(artifact, source_repo, source_sha, candidates_path, record_path):
    if not os.path.isabs(source_repo):
        fail("提示元 repo の共通 Git dir は絶対パスで指定してください")
    source_identity = str(Path(source_repo).resolve(strict=True))
    if repo_identity() != source_identity:
        fail("提示元と別の Git リポジトリです")
    artifact_path, raw = read_artifact(artifact)
    source_text = artifact_text(raw)
    candidates = load_json(candidates_path, "候補ファイル")
    validate_candidates(candidates, source_text)
    source_commit = commit_id(source_sha)
    check_ancestor(source_commit)
    record = {
        "version": 1,
        "repo_common_dir": source_identity,
        "artifact_path": artifact_path,
        "artifact_sha256": hashlib.sha256(raw).hexdigest(),
        "source_commit": source_commit,
        "candidates": candidates,
    }
    raw_record = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    try:
        with open(record_path, "xb") as stream:
            stream.write(raw_record)
    except FileExistsError:
        fail("記録ファイルは既に存在します。上書きしません")
    except OSError:
        fail("記録ファイルを作成できません")
    print(hashlib.sha256(raw_record).hexdigest())


def check(record_path, candidates_path, fingerprint, read_bytes=None):
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        fail("record fingerprint は SHA-256 で指定してください")
    raw_record = read_bytes(record_path) if read_bytes else Path(record_path).read_bytes()
    if hashlib.sha256(raw_record).hexdigest() != fingerprint:
        fail("記録ファイルの fingerprint が一致しません")
    try:
        record = json.loads(raw_record.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        fail("記録ファイルを読めません")
    if not isinstance(record, dict) or record.get("version") != 1:
        fail("記録ファイルの形式が不正です")
    required = ("repo_common_dir", "artifact_path", "artifact_sha256", "source_commit", "candidates")
    if any(not isinstance(record.get(field), str) for field in required[:4]):
        fail("記録ファイルの形式が不正です")
    if not os.path.isabs(record["artifact_path"]) or not os.path.isabs(record["repo_common_dir"]):
        fail("記録ファイルの provenance が不正です")
    if repo_identity() != record["repo_common_dir"]:
        fail("別の Git リポジトリです")
    artifact_path, raw = read_artifact(record["artifact_path"], read_bytes)
    if artifact_path != record["artifact_path"] or hashlib.sha256(raw).hexdigest() != record["artifact_sha256"]:
        fail("レポートが記録後に変更または移動されています")
    source_text = artifact_text(raw)
    validate_candidates(record["candidates"], source_text)
    source_commit = commit_id(record["source_commit"])
    if source_commit != record["source_commit"]:
        fail("記録された source commit が不正です")
    check_ancestor(source_commit)
    proposed = load_json(candidates_path, "候補ファイル", read_bytes)
    validate_candidates(proposed, source_text)
    if proposed != record["candidates"]:
        fail("候補が固定記録と一致しません")


def main(argv):
    if len(argv) == 7 and argv[1] == "pin":
        pin(*argv[2:])
    elif argv[1:2] == ["check"] and len(argv) == 5:
        check(*argv[2:])
    else:
        fail("使い方: candidate-record.py pin <artifact> <source-repo-common-dir> <source-sha> <candidates.json> <record.json> | check <record.json> <candidates.json> <record-sha256>")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except ValueError as error:
        print(f"エラー: {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.SubprocessError):
        print("エラー: ファイルまたは Git の操作に失敗しました", file=sys.stderr)
        sys.exit(1)
