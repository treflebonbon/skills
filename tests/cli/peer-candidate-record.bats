#!/usr/bin/env bats

setup() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/skills/herdr-peer-refactor/scripts/candidate-record.py"
  REPO="$BATS_TEST_TMPDIR/repo"
  ARTIFACT="$BATS_TEST_TMPDIR/report.md"
  CANDIDATES="$BATS_TEST_TMPDIR/candidates.json"
  RECORD="$BATS_TEST_TMPDIR/record.json"
  FINGERPRINT="$BATS_TEST_TMPDIR/fingerprint"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.name 'Candidate Record Test'
  git -C "$REPO" config user.email 'candidate-record@example.invalid'
  printf 'source\n' >"$REPO/source.txt"
  git -C "$REPO" add source.txt
  git -C "$REPO" commit -qm source
  SOURCE_SHA="$(git -C "$REPO" rev-parse HEAD)"
  SOURCE_REPO="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
  printf '# Use event log\nThe source report describes this candidate.\n' >"$ARTIFACT"
  write_candidates
}

write_candidates() {
  cat >"$CANDIDATES" <<'JSON'
[
  {
    "id": "C-1",
    "title": "Use event log",
    "acceptance": ["existing events remain"],
    "non_goals": ["new UI"],
    "owned_files": ["src/events.py"]
  }
]
JSON
}

pin_record() {
  (cd "$REPO" && python3 "$SCRIPT" pin "$ARTIFACT" "$SOURCE_REPO" "$SOURCE_SHA" "$CANDIDATES" "$RECORD" >"$FINGERPRINT" && cat "$FINGERPRINT")
}

@test "pin rejects a clone with the source commit but a different originating repo" {
  local clone="$BATS_TEST_TMPDIR/clone"
  git clone -q "$REPO" "$clone"
  [ "$(git -C "$clone" rev-parse HEAD)" = "$SOURCE_SHA" ]
  run bash -c 'cd "$1" && python3 "$2" pin "$3" "$4" "$5" "$6" "$7"' _ "$clone" "$SCRIPT" "$ARTIFACT" "$SOURCE_REPO" "$SOURCE_SHA" "$CANDIDATES" "$RECORD"
  [ "$status" -ne 0 ]
  [[ "$output" == *"提示元と別の Git リポジトリ"* ]]
  [ ! -e "$RECORD" ]
}

check_record() {
  (cd "$REPO" && python3 "$SCRIPT" check "$RECORD" "${1:-$CANDIDATES}" "$(cat "$FINGERPRINT")")
}

@test "plain text report can be pinned and checked" {
  run pin_record
  [ "$status" -eq 0 ]
  run check_record
  [ "$status" -eq 0 ]
  run bash -c 'cd "$1" && python3 "$2" check "$3"' _ "$REPO" "$SCRIPT" "$RECORD"
  [ "$status" -ne 0 ]
  run bash -c 'cd "$1" && python3 "$2" check "$3" "$4"' _ "$REPO" "$SCRIPT" "$RECORD" "$CANDIDATES"
  [ "$status" -ne 0 ]
  python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["source_commit"] == sys.argv[2]; assert r["artifact_sha256"]; assert r["repo_common_dir"]' "$RECORD" "$SOURCE_SHA"
}

@test "HTML report title matches after markup and whitespace normalization" {
  cat >"$ARTIFACT" <<'HTML'
<html><body><h1>Use <em>event</em>
 log</h1><p>Candidate source.</p></body></html>
HTML
  run pin_record
  [ "$status" -eq 0 ]
  run check_record
  [ "$status" -eq 0 ]
}

@test "candidate title must occur in the source report" {
  sed -i 's/Use event log/Unrelated design/' "$CANDIDATES"
  run pin_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"レポートにありません"* ]]
  [ ! -e "$RECORD" ]
}

@test "candidate IDs and titles are unique and required lists are validated" {
  cat >"$CANDIDATES" <<'JSON'
[
  {"id":"C-1","title":"Use event log","acceptance":["ok"],"non_goals":[],"owned_files":["a"]},
  {"id":"C-1","title":"Use event log","acceptance":["ok"],"non_goals":[],"owned_files":["b"]}
]
JSON
  run pin_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"id が重複"* ]]
  cat >"$CANDIDATES" <<'JSON'
[
  {"id":"C-1","title":"Use event log","acceptance":["ok"],"non_goals":[],"owned_files":["a"]},
  {"id":"C-2","title":" use   EVENT log ","acceptance":["ok"],"non_goals":[],"owned_files":["b"]}
]
JSON
  run pin_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"title が重複"* ]]
  cat >"$CANDIDATES" <<'JSON'
[
  {"id":"C-1","title":"Use event log","acceptance":[],"non_goals":[],"owned_files":["a"]}
]
JSON
  run pin_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"acceptance は空でない配列"* ]]
}

@test "modified and missing reports fail check" {
  run pin_record
  [ "$status" -eq 0 ]
  printf 'changed\n' >>"$ARTIFACT"
  run check_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"変更または移動"* ]]
  rm "$ARTIFACT"
  run check_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"レポートを読めません"* ]]
}

@test "check rejects a different Git common directory" {
  run pin_record
  [ "$status" -eq 0 ]
  OTHER="$BATS_TEST_TMPDIR/other"
  mkdir -p "$OTHER"
  git -C "$OTHER" init -q
  git -C "$OTHER" config user.name 'Candidate Record Test'
  git -C "$OTHER" config user.email 'candidate-record@example.invalid'
  printf 'other\n' >"$OTHER/source.txt"
  git -C "$OTHER" add source.txt
  git -C "$OTHER" commit -qm other
  run bash -c 'cd "$1" && python3 "$2" check "$3" "$4" "$5"' _ "$OTHER" "$SCRIPT" "$RECORD" "$CANDIDATES" "$(cat "$FINGERPRINT")"
  [ "$status" -ne 0 ]
  [[ "$output" == *"別の Git リポジトリ"* ]]
}

@test "edited or added candidate payload does not match the pin" {
  run pin_record
  [ "$status" -eq 0 ]
  sed -i 's/existing events remain/changed acceptance/' "$CANDIDATES"
  run check_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"候補が固定記録と一致しません"* ]]
}

@test "an additional candidate is rejected even when its title is in the report" {
  printf '\n# Add another event handler\n' >>"$ARTIFACT"
  # Candidate two is not pinned; pin the matching artifact with only the original payload.
  run pin_record
  [ "$status" -eq 0 ]
  cat >"$CANDIDATES" <<'JSON'
[
  {"id":"C-1","title":"Use event log","acceptance":["existing events remain"],"non_goals":["new UI"],"owned_files":["src/events.py"]},
  {"id":"C-2","title":"Add another event handler","acceptance":["second"],"non_goals":[],"owned_files":["src/other.py"]}
]
JSON
  run check_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"候補が固定記録と一致しません"* ]]
}

@test "pin never overwrites an existing record" {
  run pin_record
  [ "$status" -eq 0 ]
  cp "$RECORD" "$BATS_TEST_TMPDIR/original-record.json"
  run pin_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"既に存在します"* ]]
  cmp "$BATS_TEST_TMPDIR/original-record.json" "$RECORD"
}

@test "external fingerprint rejects simultaneous record and candidate edits" {
  run pin_record
  [ "$status" -eq 0 ]
  local fingerprint="$output"
  [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]]
  run bash -c 'cd "$1" && python3 "$2" check "$3" "$4" "$5"' _ "$REPO" "$SCRIPT" "$RECORD" "$CANDIDATES" "$fingerprint"
  [ "$status" -eq 0 ]
  python3 - "$RECORD" "$CANDIDATES" <<'PY'
import json, sys
for path in sys.argv[1:]:
    with open(path) as stream:
        value = json.load(stream)
    candidates = value["candidates"] if isinstance(value, dict) else value
    candidates[0]["acceptance"] = ["replace original intent"]
    with open(path, "w") as stream:
        json.dump(value, stream)
PY
  run bash -c 'cd "$1" && python3 "$2" check "$3" "$4" "$5"' _ "$REPO" "$SCRIPT" "$RECORD" "$CANDIDATES" "$fingerprint"
  [ "$status" -ne 0 ]
  [[ "$output" == *"fingerprint"* ]]
}

@test "a later descendant HEAD and a linked worktree in the same repo are accepted" {
  run pin_record
  [ "$status" -eq 0 ]
  printf 'later\n' >"$REPO/later.txt"
  git -C "$REPO" add later.txt
  git -C "$REPO" commit -qm later
  run check_record
  [ "$status" -eq 0 ]
  LINKED="$BATS_TEST_TMPDIR/linked"
  git -C "$REPO" worktree add -q --detach "$LINKED" HEAD
  run bash -c 'cd "$1" && python3 "$2" check "$3" "$4" "$5"' _ "$LINKED" "$SCRIPT" "$RECORD" "$CANDIDATES" "$(cat "$FINGERPRINT")"
  [ "$status" -eq 0 ]
}

@test "replacement during record read cannot switch the verified candidate" {
  run pin_record
  [ "$status" -eq 0 ]
  run bash -c 'cd "$1" && python3 - "$2" "$3" "$4" "$5"' _ "$REPO" "$SCRIPT" "$RECORD" "$CANDIDATES" "$output" <<'PY'
import importlib.util, json, sys
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("candidate_record", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
record_path, candidates_path, fingerprint = sys.argv[2:]
read_bytes = Path.read_bytes

def replace_after_read(path):
    raw = read_bytes(path)
    if str(path) == record_path:
        record = json.loads(raw)
        record["candidates"][0]["acceptance"] = ["replace original intent"]
        Path(record_path).write_text(json.dumps(record))
        Path(candidates_path).write_text(json.dumps(record["candidates"]))
    return raw

with patch.object(Path, "read_bytes", replace_after_read):
    try:
        module.check(record_path, candidates_path, fingerprint)
    except ValueError as error:
        assert "候補が固定記録と一致しません" in str(error), str(error)
    else:
        raise AssertionError("replacement candidate was accepted")
PY
  [ "$status" -eq 0 ]
}

@test "source commit must remain an ancestor of HEAD" {
  run pin_record
  [ "$status" -eq 0 ]
  git -C "$REPO" checkout -q --orphan unrelated
  git -C "$REPO" rm -rf -q .
  printf 'unrelated history\n' >"$REPO/other.txt"
  git -C "$REPO" add other.txt
  git -C "$REPO" commit -qm unrelated
  run check_record
  [ "$status" -ne 0 ]
  [[ "$output" == *"祖先ではありません"* ]]
}
